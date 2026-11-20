using System.IO;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Win32;

namespace Workspace;

/// <summary>
/// The only path between the page and the machine: one JSON message in, one out.
/// The page never touches the filesystem — it asks here, so every path stays
/// absolute and nothing depends on browser sandbox rules.
/// </summary>
public class Bridge
{
    readonly MainWindow _win;
    readonly WebView2 _wv;
    readonly List<FileSystemWatcher> _watchers = new();
    DateTime _lastChange = DateTime.MinValue;

    public Bridge(MainWindow win, WebView2 wv) { _win = win; _wv = wv; }

    public class BridgeError : Exception
    {
        public BridgeError(string m) : base(m) { }
    }

    public async Task<object> Handle(string method, JsonElement p)
    {
        switch (method)
        {
            // ------------------------------------------------------------ app
            case "app.init":
                RebuildWatchers();
                return new
                {
                    dataDir = Store.DataDir,
                    settings = Store.Idx.Settings,
                    libraries = Store.Idx.Libraries,
                    projects = Store.Idx.Projects,
                    dualDetected = Openers.DetectDualHome()
                };

            case "app.saveSettings":
                {
                    var s = Json.R<Settings>(p.GetProperty("settings"));
                    Store.Idx.Settings = s ?? new Settings();
                    Store.SaveIndex();
                    return new { ok = true };
                }

            // -------------------------------------------------------- libraries
            case "lib.list":
                return Store.Idx.Libraries;

            case "lib.create":
                {
                    var name = Str(p, "name");
                    var root = Str(p, "root");
                    if (string.IsNullOrWhiteSpace(name)) name = string.IsNullOrWhiteSpace(root) ? "新文库" : Path.GetFileName(root.TrimEnd('\\', '/'));
                    var lib = new Library
                    {
                        Id = Store.NewId("lib"),
                        Name = name,
                        Root = root,
                        CreatedAt = Store.Now,
                        UpdatedAt = Store.Now
                    };
                    if (!string.IsNullOrWhiteSpace(root) && Directory.Exists(root))
                        lib.Items.Add(MakeItem(root));
                    Store.Idx.Libraries.Add(lib);
                    Store.SaveIndex();
                    RebuildWatchers();
                    return lib;
                }

            case "lib.createSub":
                {
                    // A child library is a slice of its parent: the paths the user
                    // ticked, stored as ordinary items. It is not a copy — the
                    // folder is walked again on every read, so new files under it
                    // show up without any sync step.
                    var parent = Store.Idx.Libraries.FirstOrDefault(l => l.Id == Str(p, "parentId"))
                                 ?? throw new BridgeError("父文库不存在");
                    if (!string.IsNullOrEmpty(parent.ParentId))
                        throw new BridgeError("子文库不能再往下拆");
                    var paths = StrList(p, "paths");
                    if (paths.Count == 0) throw new BridgeError("至少勾一个文件夹或文件");

                    // Only things the parent can actually see: a folder item, or
                    // something under one. Refuse stray absolute paths.
                    var roots = parent.Items.Where(i => i.Kind == "dir")
                        .Select(i => i.Path.TrimEnd('\\', '/'))
                        .Where(x => x.Length > 0).ToList();
                    bool Inside(string raw)
                    {
                        var full = raw.TrimEnd('\\', '/');
                        foreach (var r in roots)
                        {
                            if (string.Equals(full, r, StringComparison.OrdinalIgnoreCase)) return true;
                            if (full.StartsWith(r + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return true;
                            if (full.StartsWith(r + "/", StringComparison.OrdinalIgnoreCase)) return true;
                        }
                        return false;
                    }
                    if (paths.Any(x => !Inside(x)))
                        throw new BridgeError("有勾选项不在这个文库的文件夹里");

                    var subName = Str(p, "name");
                    var sub = new Library
                    {
                        Id = Store.NewId("lib"),
                        Name = string.IsNullOrWhiteSpace(subName) ? "子文库" : subName.Trim(),
                        Root = "",
                        ParentId = parent.Id,
                        CreatedAt = Store.Now,
                        UpdatedAt = Store.Now
                    };
                    foreach (var path in paths)
                    {
                        if (!File.Exists(path) && !Directory.Exists(path)) continue;
                        if (sub.Items.Any(i => string.Equals(i.Path, path, StringComparison.OrdinalIgnoreCase))) continue;
                        sub.Items.Add(MakeItem(path));
                    }
                    if (sub.Items.Count == 0) throw new BridgeError("勾选的项目都已经不在磁盘上了");
                    Store.Idx.Libraries.Add(sub);
                    Store.SaveIndex();
                    return sub;
                }

            case "lib.addPaths":
                {
                    var libId = Str(p, "libId");
                    var lib = Store.Idx.Libraries.FirstOrDefault(l => l.Id == libId)
                              ?? throw new BridgeError("文库不存在");
                    if (!string.IsNullOrEmpty(lib.ParentId))
                        throw new BridgeError("子文库是拆出来的子集，不能再往里加东西");
                    int added = 0;
                    foreach (var path in StrList(p, "paths"))
                    {
                        if (!File.Exists(path) && !Directory.Exists(path)) continue;
                        if (lib.Items.Any(i => string.Equals(i.Path, path, StringComparison.OrdinalIgnoreCase))) continue;
                        lib.Items.Add(MakeItem(path));
                        added++;
                    }
                    lib.UpdatedAt = Store.Now;
                    Store.SaveIndex();
                    RebuildWatchers();
                    return new { added, library = lib };
                }

            case "lib.refresh":
                {
                    var lib = Store.Idx.Libraries.FirstOrDefault(l => l.Id == Str(p, "libId"))
                              ?? throw new BridgeError("文库不存在");
                    lib.Items.RemoveAll(i => !File.Exists(i.Path) && !Directory.Exists(i.Path));
                    foreach (var it in lib.Items)
                    {
                        try
                        {
                            it.Name = Path.GetFileName(it.Path.TrimEnd('\\', '/'));
                            if (Directory.Exists(it.Path))
                            {
                                it.Size = 0;
                                it.Mtime = new DirectoryInfo(it.Path).LastWriteTimeUtc.ToUnixMs();
                            }
                            else if (File.Exists(it.Path))
                            {
                                var fi = new FileInfo(it.Path);
                                it.Size = fi.Length;
                                it.Mtime = fi.LastWriteTimeUtc.ToUnixMs();
                            }
                        }
                        catch { }
                    }
                    lib.UpdatedAt = Store.Now;
                    Store.SaveIndex();
                    RebuildWatchers();
                    return lib;
                }

            case "lib.removeItem":
                {
                    var lib = Store.Idx.Libraries.FirstOrDefault(l => l.Id == Str(p, "libId"));
                    if (lib == null) throw new BridgeError("文库不存在");
                    var itemId = Str(p, "itemId");
                    lib.Items.RemoveAll(i => i.Id == itemId);
                    lib.UpdatedAt = Store.Now;
                    Store.SaveIndex();
                    return new { ok = true };
                }

            case "lib.remove":
                {
                    var id = Str(p, "libId");
                    // A parent takes its children with it: they are hidden from
                    // the sidebar, so an orphaned child would be unreachable.
                    Store.Idx.Libraries.RemoveAll(l => l.Id == id || l.ParentId == id);
                    Store.SaveIndex();
                    return new { ok = true };
                }

            case "lib.rename":
                {
                    var lib = Store.Idx.Libraries.FirstOrDefault(l => l.Id == Str(p, "libId"));
                    if (lib == null) throw new BridgeError("文库不存在");
                    lib.Name = Str(p, "name");
                    lib.UpdatedAt = Store.Now;
                    Store.SaveIndex();
                    return lib;
                }

            case "lib.children":
                return Fs.Children(Str(p, "path"));

            case "lib.stat":
                return Fs.Stat(Str(p, "path"));

            case "lib.statMany":
                {
                    var paths = StrList(p, "paths");
                    return paths.ToDictionary(x => x, x => Fs.Stat(x));
                }

            // --------------------------------------------------------- dialogs
            case "pick.folder":
                {
                    var dlg = new OpenFolderDialog { Title = "选择文件夹" };
                    if (dlg.ShowDialog(_win) == true) return dlg.FolderName;
                    return "";
                }

            case "pick.files":
                {
                    var dlg = new OpenFileDialog { Title = "选择文件", Multiselect = true, Filter = "所有文件|*.*" };
                    if (dlg.ShowDialog(_win) == true) return dlg.FileNames;
                    return new string[0];
                }

            // -------------------------------------------------------- projects
            case "proj.list":
                return Store.Idx.Projects.OrderByDescending(x => x.UpdatedAt).ToList();

            case "proj.create":
                {
                    var name = Str(p, "name");
                    if (string.IsNullOrWhiteSpace(name)) name = "未命名项目";
                    var proj = new Project
                    {
                        Id = Store.NewId("prj"),
                        Name = name,
                        CreatedAt = Store.Now,
                        UpdatedAt = Store.Now
                    };
                    // Give a fresh project one blank entry so the canvas is not empty.
                    proj.Entries.Add(new Entry
                    {
                        Id = Store.NewId("e"),
                        Title = "第一张条目",
                        Body = "# 第一张条目\n\n双击画布空白处可以再加一张。\n",
                        CreatedAt = Store.Now,
                        UpdatedAt = Store.Now
                    });
                    Store.SaveProject(proj);
                    return proj;
                }

            case "proj.load":
                {
                    var id = Str(p, "id");
                    var proj = Store.LoadProject(id) ?? throw new BridgeError("项目不存在");
                    return new
                    {
                        project = proj,
                        runs = Store.RecentRuns(id, 40),
                        libraries = Store.Idx.Libraries
                    };
                }

            case "proj.save":
                {
                    var proj = Json.R<Project>(p.GetProperty("project"));
                    if (proj == null) throw new BridgeError("项目为空");
                    Store.SaveProject(proj);
                    return new { ok = true, updatedAt = proj.UpdatedAt };
                }

            case "proj.delete":
                Store.DeleteProject(Str(p, "id"));
                return new { ok = true };

            case "proj.rename":
                {
                    var proj = Store.LoadProject(Str(p, "id")) ?? throw new BridgeError("项目不存在");
                    proj.Name = Str(p, "name");
                    Store.SaveProject(proj);
                    return new { ok = true };
                }

            // ----------------------------------------------------------- open
            case "open.file":
                {
                    var path = Str(p, "path");
                    var opener = Str(p, "opener");
                    if (string.IsNullOrWhiteSpace(opener))
                        opener = Path.GetExtension(path).ToLowerInvariant() == ".pdf"
                            ? Store.Idx.Settings.PdfOpener
                            : Store.Idx.Settings.TextOpener;
                    var r = Openers.OpenFile(path, opener, Store.Idx.Settings);
                    if (!r.ok) throw new BridgeError(r.msg);
                    return new { ok = true };
                }

            case "open.dir":
                {
                    var r = Openers.OpenDir(Str(p, "path"));
                    if (!r.ok) throw new BridgeError(r.msg);
                    return new { ok = true };
                }

            case "open.url":
                {
                    var r = Openers.OpenUrl(Str(p, "url"));
                    if (!r.ok) throw new BridgeError(r.msg);
                    return new { ok = true };
                }

            case "open.app":
                {
                    var r = Openers.OpenApp(Str(p, "path"));
                    if (!r.ok) throw new BridgeError(r.msg);
                    return new { ok = true };
                }

            case "open.term":
                {
                    var r = Openers.OpenTerminal(Str(p, "cwd"));
                    if (!r.ok) throw new BridgeError(r.msg);
                    return new { ok = true };
                }

            case "open.reveal":
                {
                    var path = Str(p, "path");
                    if (File.Exists(path))
                        System.Diagnostics.Process.Start("explorer.exe", "/select,\"" + path + "\"");
                    else if (Directory.Exists(path))
                        System.Diagnostics.Process.Start("explorer.exe", "\"" + path + "\"");
                    else throw new BridgeError("路径不存在");
                    return new { ok = true };
                }

            // --------------------------------------------------- environments
            case "env.plan":
                {
                    var projectId = Str(p, "projectId");
                    var envId = Str(p, "envId");
                    var proj = Store.LoadProject(projectId) ?? throw new BridgeError("项目不存在");
                    var env = proj.Envs.FirstOrDefault(e => e.Id == envId) ?? throw new BridgeError("环境不存在");
                    var pairs = EnvRunner.Plan(env, proj, Store.Idx);
                    return new
                    {
                        envName = env.Name,
                        steps = pairs.Select(x => x.step).ToList()
                    };
                }

            case "env.run":
                {
                    var projectId = Str(p, "projectId");
                    var envId = Str(p, "envId");
                    var proj = Store.LoadProject(projectId) ?? throw new BridgeError("项目不存在");
                    var env = proj.Envs.FirstOrDefault(e => e.Id == envId) ?? throw new BridgeError("环境不存在");
                    var rec = await Task.Run(() => EnvRunner.Execute(env, proj, Store.Idx, Store.Idx.Settings));
                    Store.AppendRun(projectId, rec);
                    // Remember the run time on the environment itself.
                    var fresh = Store.LoadProject(projectId);
                    var fe = fresh?.Envs.FirstOrDefault(e => e.Id == envId);
                    if (fe != null) { fe.LastRunAt = Store.Now; Store.SaveProject(fresh); }
                    return rec;
                }

            case "env.files":
                {
                    // What a library block can offer: used by the "enumerate" editor.
                    var libId = Str(p, "libId");
                    var lib = Store.Idx.Libraries.FirstOrDefault(l => l.Id == libId);
                    if (lib == null) return new List<object>();
                    return Fs.Entries(lib, "").Select(x => new { path = x.path, rel = x.rel, name = Path.GetFileName(x.path), kind = x.kind }).ToList();
                }

            case "env.runs":
                return Store.RecentRuns(Str(p, "projectId"), 40);

            // --------------------------------------------------------- export
            case "export.text":
                {
                    var dlg = new SaveFileDialog
                    {
                        Title = "导出",
                        FileName = Str(p, "name"),
                        Filter = Str(p, "filter") is { Length: > 0 } f ? f : "Markdown|*.md|所有文件|*.*"
                    };
                    if (dlg.ShowDialog(_win) != true) return new { ok = false };
                    File.WriteAllText(dlg.FileName, Str(p, "text"), new System.Text.UTF8Encoding(false));
                    return new { ok = true, path = dlg.FileName };
                }

            case "export.image":
                {
                    var dlg = new SaveFileDialog { Title = "导出画布", FileName = Str(p, "name"), Filter = "PNG 图片|*.png" };
                    if (dlg.ShowDialog(_win) != true) return new { ok = false };
                    var data = Str(p, "dataUrl");
                    var comma = data.IndexOf(',');
                    var b64 = comma >= 0 ? data.Substring(comma + 1) : data;
                    File.WriteAllBytes(dlg.FileName, Convert.FromBase64String(b64));
                    return new { ok = true, path = dlg.FileName };
                }

            case "clip.text":
                Clipboard.SetText(Str(p, "text"));
                return new { ok = true };

            // --------------------------------------------------------- window
            case "win.min": _win.WindowState = WindowState.Minimized; return new { ok = true };
            case "win.max": _win.ToggleMax(); return new { ok = _win.WindowState == WindowState.Maximized };
            case "win.drag": _win.StartWindowDrag(); return new { ok = true };
            case "win.resize": _win.StartWindowResize(Str(p, "edge")); return new { ok = true };
            case "win.close": _win.Close(); return new { ok = true };
            case "win.state": return new { maximized = _win.WindowState == WindowState.Maximized };

            case "log":
                Store.Log(Str(p, "msg"));
                return new { ok = true };
        }
        throw new BridgeError("未知方法 " + method);
    }

    static readonly string[] AppExts = { ".exe", ".lnk", ".bat", ".cmd", ".msc", ".ps1" };

    /// <summary>The disk changes, so the library list should follow. Debounced.</summary>
    public void RebuildWatchers()
    {
        foreach (var w in _watchers) { try { w.Dispose(); } catch { } }
        _watchers.Clear();
        foreach (var lib in Store.Idx.Libraries)
        {
            // A child's folders are already watched through its parent.
            if (!string.IsNullOrEmpty(lib.ParentId)) continue;
            foreach (var it in lib.Items)
            {
                if (it.Kind != "dir" || !Directory.Exists(it.Path)) continue;
                try
                {
                    var w = new FileSystemWatcher(it.Path)
                    {
                        IncludeSubdirectories = true,
                        NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite,
                        EnableRaisingEvents = true
                    };
                    w.Created += (_, __) => NotifyLibraryChanged();
                    w.Deleted += (_, __) => NotifyLibraryChanged();
                    w.Changed += (_, __) => NotifyLibraryChanged();
                    w.Renamed += (_, __) => NotifyLibraryChanged();
                    _watchers.Add(w);
                }
                catch { }
            }
        }
    }

    void NotifyLibraryChanged()
    {
        if ((DateTime.Now - _lastChange).TotalMilliseconds < 800) return;
        _lastChange = DateTime.Now;
        _wv.Dispatcher.BeginInvoke(new Action(() =>
        {
            try { _wv.CoreWebView2?.PostWebMessageAsJson(Json.S(new { @event = "libraryChanged" })); }
            catch { }
        }));
    }

    static LibItem MakeItem(string path)
    {
        var isDir = Directory.Exists(path);
        long size = 0, mtime = 0;
        try
        {
            if (isDir)
            {
                var di = new DirectoryInfo(path);
                mtime = di.LastWriteTimeUtc.ToUnixMs();
            }
            else
            {
                var fi = new FileInfo(path);
                size = fi.Length;
                mtime = fi.LastWriteTimeUtc.ToUnixMs();
            }
        }
        catch { }

        // A shortcut or an executable is a "program": it gets its own colour and
        // the only sensible verb is "run it".
        var kind = isDir ? "dir"
            : AppExts.Contains(Path.GetExtension(path).ToLowerInvariant()) ? "app"
            : "file";

        return new LibItem
        {
            Id = Store.NewId("it"),
            Path = path,
            Kind = kind,
            Name = Path.GetFileName(path.TrimEnd('\\', '/')),
            Size = size,
            Mtime = mtime,
            AddedAt = Store.Now
        };
    }

    static string Str(JsonElement p, string key)
        => p.ValueKind == JsonValueKind.Object && p.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : "";

    static List<string> StrList(JsonElement p, string key)
    {
        var list = new List<string>();
        if (p.ValueKind == JsonValueKind.Object && p.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Array)
            foreach (var e in v.EnumerateArray())
                if (e.ValueKind == JsonValueKind.String) list.Add(e.GetString());
        return list;
    }
}
