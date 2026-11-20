using System.Text.Json;

namespace Workspace;

// ---------------------------------------------------------------- data model
// Everything the UI knows is one of these. Files never leave their place on
// disk: a library only stores paths plus the stat needed to recognise them.

public class LibItem
{
    public string Id { get; set; }
    public string Path { get; set; }
    public string Kind { get; set; }          // file | dir
    public string Name { get; set; }
    public long Size { get; set; }
    public long Mtime { get; set; }
    public long AddedAt { get; set; }
}

public class Library
{
    public string Id { get; set; }
    public string Name { get; set; }
    public string Root { get; set; }          // may be null for loose collections
    public string ParentId { get; set; } = ""; // non-empty = child library, hidden from the sidebar
    public long CreatedAt { get; set; }
    public long UpdatedAt { get; set; }
    public List<LibItem> Items { get; set; } = new();
}

public class Settings
{
    public string DualPdfHome { get; set; } = "";
    public string PdfOpener { get; set; } = "dual-pdf";   // dual-pdf | system
    public string TextOpener { get; set; } = "system";
    public string Theme { get; set; } = "light";
    public string LastProjectId { get; set; } = "";
    public double WinW { get; set; } = 1440;
    public double WinH { get; set; } = 900;
}

public class ProjectRef
{
    public string Id { get; set; }
    public string Name { get; set; }
    public long UpdatedAt { get; set; }
    public int Entries { get; set; }
    public int Blocks { get; set; }
}

public class AppIndex
{
    public int Version { get; set; } = 1;
    public Settings Settings { get; set; } = new();
    public List<Library> Libraries { get; set; } = new();
    public List<ProjectRef> Projects { get; set; } = new();
}


public class Entry
{
    public string Id { get; set; }
    public string Title { get; set; } = "";
    public string Body { get; set; } = "";    // markdown, written by the user
    public List<string> Tags { get; set; } = new();
    public long CreatedAt { get; set; }
    public long UpdatedAt { get; set; }
}

/// <summary>One card on the canvas. Several blocks may point at one entry.</summary>
public class Block
{
    public string Id { get; set; }
    public string Kind { get; set; }          // entry | file | dir | library | environment
    public string RefId { get; set; }         // entry id / absolute path / library id / env id
    public double X { get; set; }
    public double Y { get; set; }
    public double W { get; set; } = 300;
    public double H { get; set; } = 200;
    public int Z { get; set; }
    public string Note { get; set; } = "";
}

public class Edge
{
    public string Id { get; set; }
    public string FromBlock { get; set; }
    public string FromSide { get; set; } = "r";   // l r t b
    public string ToBlock { get; set; }
    public string ToSide { get; set; } = "l";
    public string Kind { get; set; } = "ref";     // ref | works | derived
    public string Label { get; set; } = "";
}

/// <summary>
/// One thing an environment does. It either points at a block on the canvas
/// (file / folder / page / program / library) or holds a script the user wrote.
/// The environment block owns the configuration — a drawn edge is only the
/// visible consequence of an entry existing.
/// </summary>
public class EnvFunc
{
    public string Id { get; set; }
    public string Kind { get; set; } = "block";    // block | script
    public string BlockId { get; set; } = "";      // target block when kind=block
    public bool On { get; set; } = true;           // open it when the env runs
    public string Opener { get; set; } = "";       // "" = by extension; else system|dual-pdf|notepad|vscode|terminal
    public string Mode { get; set; } = "selector"; // library only: selector | enumerate
    public string Selector { get; set; } = "";     // library only
    public Dictionary<string, bool> Picks { get; set; } = new();
    public Dictionary<string, string> Openers { get; set; } = new();
    public string Command { get; set; } = "";      // kind=script
    public string Label { get; set; } = "";
}

/// <summary>A function from the blocks it is wired to, to a set of side effects.</summary>
public class Env
{
    public string Id { get; set; }
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public List<EnvFunc> Funcs { get; set; } = new();
    public long LastRunAt { get; set; }
}



/// <summary>A thing to push forward. Urgency only: no deadline, no timer, no links.</summary>
public class TaskItem
{
    public string Id { get; set; }
    public string Title { get; set; } = "";
    public string Level { get; set; } = "B";   // A | B | C
    public bool Done { get; set; }
    public long CreatedAt { get; set; }
}

public class Project
{
    public string Id { get; set; }
    public string Name { get; set; } = "";
    public long CreatedAt { get; set; }
    public long UpdatedAt { get; set; }
    public double ViewX { get; set; } = 80;
    public double ViewY { get; set; } = 80;
    public double ViewScale { get; set; } = 1;
    public List<Entry> Entries { get; set; } = new();
    public List<Block> Blocks { get; set; } = new();
    public List<Edge> Edges { get; set; } = new();
    public List<Env> Envs { get; set; } = new();
    public List<TaskItem> Tasks { get; set; } = new();
}

public class RunStep
{
    public string Label { get; set; }
    public string Target { get; set; }
    public bool Ok { get; set; }
    public bool Skipped { get; set; }
    public string Message { get; set; }
}

public class RunRecord
{
    public long Ts { get; set; }
    public string EnvId { get; set; }
    public string EnvName { get; set; }
    public string LibraryName { get; set; }
    public long DurationMs { get; set; }
    public bool Ok { get; set; }
    public List<RunStep> Steps { get; set; } = new();
}

public static class Json
{
    public static readonly JsonSerializerOptions Opt = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static string S(object o) => JsonSerializer.Serialize(o, Opt);
    public static T R<T>(string s) => string.IsNullOrWhiteSpace(s) ? default : JsonSerializer.Deserialize<T>(s, Opt);
    public static T R<T>(JsonElement e) => JsonSerializer.Deserialize<T>(e.GetRawText(), Opt);
}
