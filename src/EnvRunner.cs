using System.IO;
using System.Text.RegularExpressions;

namespace Workspace;

public static class Fs
{
    public static long ToUnixMs(this DateTime dt) => new DateTimeOffset(DateTime.SpecifyKind(dt, DateTimeKind.Utc)).ToUnixTimeMilliseconds();

    public static object Stat(string path)
    {
        try
        {
            if (Directory.Exists(path))
                return new { exists = true, kind = "dir", name = Path.GetFileName(path), path, size = 0L, mtime = Directory.GetLastWriteTimeUtc(path).ToUnixMs() };
            if (File.Exists(path))
            {
                var fi = new FileInfo(path);
                return new { exists = true, kind = "file", name = fi.Name, path, size = fi.Length, mtime = fi.LastWriteTimeUtc.ToUnixMs() };
            }
        }
        catch { }
        return new { exists = false, kind = "", name = "", path, size = 0L, mtime = 0L };
    }

    /// <summary>One level of a folder, folders first — the tree asks for this lazily.</summary>
    public static List<object> Children(string path)
    {
        var list = new List<object>();
        try
        {
            foreach (var d in Directory.GetDirectories(path))
            {
                var di = new DirectoryInfo(d);
                list.Add(new { name = di.Name, path = d, kind = "dir", size = 0L, mtime = di.LastWriteTimeUtc.ToUnixMs() });
            }
            foreach (var f in Directory.GetFiles(path))
            {
                var fi = new FileInfo(f);
                list.Add(new { name = fi.Name, path = f, kind = "file", size = fi.Length, mtime = fi.LastWriteTimeUtc.ToUnixMs() });
            }
        }
        catch (Exception e) { Store.Log("children " + path + ": " + e.Message); }
        return list;
    }

    /// <summary>Every file a library can see, with a path relative to its root.</summary>
    public static List<(string path, string rel)> Match(Library lib, string selector, int max = 400)
    {
        var result = new List<(string, string)>();
        if (lib == null) return result;
        foreach (var item in lib.Items)
        {
            if (Directory.Exists(item.Path))
                Walk(item.Path, Path.GetFileName(item.Path), selector, result, max, 0);
            else if (File.Exists(item.Path))
            {
                var rel = Path.GetFileName(item.Path);
                if (Matches(rel, selector)) result.Add((item.Path, rel));
            }
            if (result.Count >= max) break;
        }
        return result;
    }

    static void Walk(string dir, string relBase, string selector, List<(string, string)> acc, int max, int depth)
    {
        if (acc.Count >= max || depth > 8) return;
        try
        {
            foreach (var f in Directory.GetFiles(dir))
            {
                var rel = relBase + "/" + Path.GetFileName(f);
                if (Matches(rel, selector)) acc.Add((f, rel));
                if (acc.Count >= max) return;
            }
            foreach (var d in Directory.GetDirectories(dir))
                Walk(d, relBase + "/" + Path.GetFileName(d), selector, acc, max, depth + 1);
        }
        catch { }
    }

    /// <summary>
    /// Everything a library contains, folders included, sorted so a folder sits
    /// right before its contents ("按子文件夹排序" in the enumerate editor).
    /// </summary>
    public static List<(string path, string rel, string kind)> Entries(Library lib, string selector, int max = 800)
    {
        var all = new List<(string path, string rel, string kind)>();
        if (lib == null) return all;
        foreach (var item in lib.Items)
        {
            if (!Directory.Exists(item.Path)) continue;
            var baseName = Path.GetFileName(item.Path.TrimEnd('\\', '/'));
            all.Add((item.Path, baseName, "dir"));
            WalkAll(item.Path, baseName, all, max, 0);
            if (all.Count >= max) break;
        }
        return all
            .Where(x => Matches(x.rel, selector) || x.kind == "dir")
            .OrderBy(x => x.rel, StringComparer.OrdinalIgnoreCase)
            .Take(max)
            .ToList();
    }

    static void WalkAll(string dir, string relBase, List<(string, string, string)> acc, int max, int depth)
    {
        if (acc.Count >= max || depth > 8) return;
        try
        {
            foreach (var d in Directory.GetDirectories(dir))
            {
                var rel = relBase + "/" + Path.GetFileName(d);
                acc.Add((d, rel, "dir"));
                if (acc.Count >= max) return;
                WalkAll(d, rel, acc, max, depth + 1);
            }
            foreach (var f in Directory.GetFiles(dir))
            {
                acc.Add((f, relBase + "/" + Path.GetFileName(f), "file"));
                if (acc.Count >= max) return;
            }
        }
        catch { }
    }

    /// <summary>
    /// Empty selector = everything. Without wildcards it is a folder prefix,
    /// with wildcards it is matched against the relative path.
    /// </summary>
    public static bool Matches(string rel, string selector)
    {
        rel = rel.Replace('\\', '/');
        if (string.IsNullOrWhiteSpace(selector)) return true;
        var sel = selector.Replace('\\', '/').Trim().Trim('/');
        if (sel.Length == 0) return true;
        if (!sel.Contains('*') && !sel.Contains('?'))
            return rel.Equals(sel, StringComparison.OrdinalIgnoreCase)
                || rel.StartsWith(sel + "/", StringComparison.OrdinalIgnoreCase);
        var rx = "^" + Regex.Escape(sel).Replace("\\*", ".*").Replace("\\?", ".") + "$";
        return Regex.IsMatch(rel, rx, RegexOptions.IgnoreCase);
    }
}

/// <summary>
/// Turns an environment into concrete steps, twice: once to show the user what
/// is about to happen, once to actually do it. The environment has no actions of
/// its own — every step comes from a block it is wired to, or from a script the
/// user typed into it.
/// </summary>
public static class EnvRunner
{
    public static Library LibraryOf(string libId, AppIndex idx)
        => string.IsNullOrWhiteSpace(libId) ? null : idx.Libraries.FirstOrDefault(l => l.Id == libId);

    /// <summary>Expand the environment against the canvas into (source, step) pairs.</summary>
    public static List<(EnvFunc func, RunStep step)> Plan(Env env, Project project, AppIndex idx)
    {
        var pairs = new List<(EnvFunc, RunStep)>();
        if (env == null) return pairs;
        var blocks = project?.Blocks ?? new List<Block>();

        foreach (var f in env.Funcs)
        {
            if (f.Kind == "script")
            {
                if (string.IsNullOrWhiteSpace(f.Command)) continue;
                pairs.Add((f, new RunStep { Label = string.IsNullOrWhiteSpace(f.Label) ? "脚本" : f.Label, Target = f.Command, Ok = true }));
                continue;
            }

            var block = blocks.FirstOrDefault(b => b.Id == f.BlockId);
            if (block == null)
            {
                pairs.Add((f, new RunStep { Label = "（已删除的块）", Target = "", Ok = false, Message = "这个作用项指向的块已经不在了" }));
                continue;
            }

            // A library is the only target that can produce many steps.
            if (block.Kind == "library")
            {
                var lib = LibraryOf(block.RefId, idx);
                if (lib == null)
                {
                    pairs.Add((f, new RunStep { Label = "（文库不存在）", Target = "", Ok = false, Message = "这个块指向的文库找不到了" }));
                    continue;
                }
                if (f.Mode == "enumerate")
                {
                    var entries = Fs.Entries(lib, "");
                    if (entries.Count == 0)
                        pairs.Add((f, new RunStep { Label = lib.Name, Target = "", Ok = false, Message = "文库是空的" }));
                    foreach (var (path, rel, kind) in entries)
                    {
                        var on = f.Picks.TryGetValue(path, out var picked) && picked;
                        if (!on) continue;   // everything untouched stays closed
                        var ok = kind == "dir" ? Directory.Exists(path) : File.Exists(path);
                        pairs.Add((f, new RunStep
                        {
                            Label = (kind == "dir" ? "📁 " : "") + Path.GetFileName(path),
                            Target = path,
                            Ok = ok
                        }));
                    }
                }
                else
                {
                    var files = Fs.Match(lib, f.Selector);
                    if (files.Count == 0)
                        pairs.Add((f, new RunStep { Label = lib.Name + " · " + (f.Selector ?? ""), Target = "", Ok = false, Message = "选择器没匹配到文件" }));
                    foreach (var (path, rel) in files)
                        pairs.Add((f, new RunStep { Label = Path.GetFileName(path), Target = path, Ok = File.Exists(path) }));
                }
                continue;
            }

            var label = block.Kind == "url" ? block.RefId : (block.RefId ?? "").Split('\\', '/').LastOrDefault() ?? "";
            if (!f.On)
            {
                pairs.Add((f, new RunStep { Label = label, Target = block.RefId, Ok = true, Skipped = true, Message = "关着，跳过" }));
                continue;
            }

            var exists = block.Kind == "url"
                ? block.RefId.StartsWith("http", StringComparison.OrdinalIgnoreCase)
                : (File.Exists(block.RefId) || Directory.Exists(block.RefId));
            pairs.Add((f, new RunStep
            {
                Label = label,
                Target = block.RefId,
                Ok = exists,
                Message = exists ? "" : "目标不存在了"
            }));
        }
        return pairs;
    }

    public static RunRecord Execute(Env env, Project project, AppIndex idx, Settings s)
    {
        var pairs = Plan(env, project, idx);
        var rec = new RunRecord
        {
            Ts = Store.Now,
            EnvId = env.Id,
            EnvName = env.Name,
            Steps = pairs.Select(p => p.step).ToList()
        };
        var sw = System.Diagnostics.Stopwatch.StartNew();
        rec.Ok = pairs.Count > 0;

        foreach (var (f, step) in pairs)
        {
            if (step.Skipped) continue;

            (bool ok, string msg) res;
            if (f.Kind == "script")
            {
                var cwd = GuessWorkingDir(env, project);
                res = Openers.RunScript(f.Command, cwd);
            }
            else
            {
                var block = project.Blocks.FirstOrDefault(b => b.Id == f.BlockId);
                if (block == null) { step.Ok = false; step.Message = "块不在了"; rec.Ok = false; break; }
                // A library function produces one step per file/folder, so the
                // target path decides how it opens — not the block.
                if (block.Kind == "library")
                {
                    var p = step.Target;
                    if (Directory.Exists(p)) res = Openers.OpenDir(p);
                    else
                    {
                        var op = f.Openers != null && f.Openers.TryGetValue(p, out var chosen) && !string.IsNullOrWhiteSpace(chosen)
                            ? chosen : ByExtension(p, s);
                        res = Openers.OpenFile(p, op, s);
                    }
                }
                else res = OpenTarget(block, f, s);
            }
            step.Ok = res.ok;
            step.Message = res.msg;
            if (!res.ok) { rec.Ok = false; break; }
        }
        sw.Stop();
        rec.DurationMs = sw.ElapsedMilliseconds;
        return rec;
    }

    static (bool ok, string msg) OpenTarget(Block block, EnvFunc f, Settings s)
    {
        switch (block.Kind)
        {
            case "url": return Openers.OpenUrl(block.RefId);
            case "dir": return Openers.OpenDir(block.RefId);
            case "app": return Openers.OpenApp(block.RefId);
            case "library": return (true, "");
            default:
                var path = block.RefId;
                var opener = string.IsNullOrWhiteSpace(f.Opener) ? ByExtension(path, s) : f.Opener;
                return Openers.OpenFile(path, opener, s);
        }
    }

    /// <summary>PDF goes to the configured reader, everything else to the system.</summary>
    public static string ByExtension(string path, Settings s)
    {
        var ext = (Path.GetExtension(path) ?? "").ToLowerInvariant();
        if (ext == ".pdf") return s.PdfOpener;
        if (ext is ".exe" or ".lnk" or ".bat" or ".cmd") return Openers.SystemDefault;
        return s.TextOpener;
    }

    /// <summary>Scripts run in the project's main folder: the first folder block, else the first library root.</summary>
    public static string GuessWorkingDir(Env env, Project project)
    {
        var dir = project?.Blocks?.FirstOrDefault(b => b.Kind == "dir" && Directory.Exists(b.RefId));
        if (dir != null) return dir.RefId;
        var lib = project?.Blocks?.FirstOrDefault(b => b.Kind == "library");
        if (lib != null)
        {
            var l = Store.Idx.Libraries.FirstOrDefault(x => x.Id == lib.RefId);
            if (l != null && Directory.Exists(l.Root)) return l.Root;
        }
        return Environment.CurrentDirectory;
    }

    public static string Fill(string text, string root)
        => (text ?? "").Replace("{root}", root ?? "");
}
