using System.IO;
using System.Text.Json;

namespace Workspace;

/// <summary>
/// Disk layout (all under %APPDATA%\workspace):
///   index.json             libraries, project list, settings
///   projects\&lt;id&gt;.json    one project: entries, blocks, edges, environments, tasks
///   projects\&lt;id&gt;.runs.jsonl   append-only run log
/// Writes are atomic: temp file then move, so a crash never leaves half a file.
/// </summary>
public static class Store
{
    public static string DataDir { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "workspace");
    public static string ProjectsDir => Path.Combine(DataDir, "projects");
    static string IndexFile => Path.Combine(DataDir, "index.json");

    public static AppIndex Idx { get; private set; } = new();

    public static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public static string NewId(string prefix) =>
        prefix + "_" + Guid.NewGuid().ToString("n").Substring(0, 10);

    public static void Load()
    {
        Directory.CreateDirectory(DataDir);
        Directory.CreateDirectory(ProjectsDir);
        if (File.Exists(IndexFile))
        {
            try { Idx = Json.R<AppIndex>(File.ReadAllText(IndexFile)) ?? new AppIndex(); }
            catch { Idx = new AppIndex(); }
        }
        if (Idx.Settings == null) Idx.Settings = new Settings();
        if (Idx.Libraries == null) Idx.Libraries = new();
        if (Idx.Projects == null) Idx.Projects = new();

        // Rebuild the project list from disk so a hand-copied file still shows up.
        foreach (var f in Directory.GetFiles(ProjectsDir, "*.json"))
        {
            var id = Path.GetFileNameWithoutExtension(f);
            if (Idx.Projects.Any(p => p.Id == id)) continue;
            var p = LoadProject(id);
            if (p != null) Idx.Projects.Add(RefOf(p));
        }
        PruneMissingProjects();
    }

    static void PruneMissingProjects()
    {
        Idx.Projects.RemoveAll(p => !File.Exists(ProjectFile(p.Id)));
    }

    public static ProjectRef RefOf(Project p) => new()
    {
        Id = p.Id, Name = p.Name, UpdatedAt = p.UpdatedAt,
        Entries = p.Entries?.Count ?? 0, Blocks = p.Blocks?.Count ?? 0
    };

    static string ProjectFile(string id) => Path.Combine(ProjectsDir, id + ".json");
    public static string RunsFile(string id) => Path.Combine(ProjectsDir, id + ".runs.jsonl");

    public static void SaveIndex()
    {
        try { AtomicWrite(IndexFile, Json.S(Idx)); }
        catch (Exception e) { Log("save index: " + e.Message); }
    }

    public static Project LoadProject(string id)
    {
        var f = ProjectFile(id);
        if (!File.Exists(f)) return null;
        try
        {
            var p = Json.R<Project>(File.ReadAllText(f));
            if (p == null) return null;
            Normalize(p);
            return p;
        }
        catch (Exception e)
        {
            Log("load project " + id + ": " + e.Message);
            return null;
        }
    }

    static void Normalize(Project p)
    {
        p.Entries ??= new();
        p.Blocks ??= new();
        p.Edges ??= new();
        p.Envs ??= new();
        p.Tasks ??= new();
        foreach (var e in p.Entries) { e.Tags ??= new(); }
        foreach (var e in p.Envs)
        {
            e.Funcs ??= new();
            foreach (var f in e.Funcs) { f.Picks ??= new(); f.Openers ??= new(); }
        }
        if (p.ViewScale <= 0.05 || p.ViewScale > 4) p.ViewScale = 1;
    }

    public static void SaveProject(Project p)
    {
        p.UpdatedAt = Now;
        try
        {
            AtomicWrite(ProjectFile(p.Id), Json.S(p));
            var r = Idx.Projects.FirstOrDefault(x => x.Id == p.Id);
            var fresh = RefOf(p);
            if (r == null) Idx.Projects.Add(fresh);
            else { r.Name = fresh.Name; r.UpdatedAt = fresh.UpdatedAt; r.Entries = fresh.Entries; r.Blocks = fresh.Blocks; }
            SaveIndex();
        }
        catch (Exception e) { Log("save project: " + e.Message); }
    }

    public static void DeleteProject(string id)
    {
        try
        {
            if (File.Exists(ProjectFile(id))) File.Delete(ProjectFile(id));
            if (File.Exists(RunsFile(id))) File.Delete(RunsFile(id));
            Idx.Projects.RemoveAll(p => p.Id == id);
            SaveIndex();
        }
        catch (Exception e) { Log("delete project: " + e.Message); }
    }

    public static void AppendRun(string projectId, RunRecord r)
    {
        try
        {
            Directory.CreateDirectory(ProjectsDir);
            File.AppendAllText(RunsFile(projectId),
                JsonSerializer.Serialize(r, new JsonSerializerOptions { Encoder = Json.Opt.Encoder }) + "\n");
        }
        catch (Exception e) { Log("append run: " + e.Message); }
    }

    public static List<RunRecord> RecentRuns(string projectId, int take)
    {
        var f = RunsFile(projectId);
        if (!File.Exists(f)) return new();
        try
        {
            var lines = File.ReadAllLines(f);
            return lines.Reverse().Take(take)
                .Select(l => { try { return Json.R<RunRecord>(l); } catch { return null; } })
                .Where(x => x != null).ToList();
        }
        catch { return new(); }
    }

    static void AtomicWrite(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, text);
        File.Move(tmp, path, true);
    }

    public static void Log(string msg)
    {
        try
        {
            Directory.CreateDirectory(DataDir);
            File.AppendAllText(Path.Combine(DataDir, "workspace.log"),
                DateTime.Now.ToString("HH:mm:ss") + " " + msg + "\n");
        }
        catch { }
    }
}
