using System.Diagnostics;
using System.IO;
using System.Text;

namespace Workspace;

/// <summary>
/// The only contract with the outside world: "here is a path, open it with this".
/// Each program gets its own adapter because they start in different ways —
/// Dual PDF needs its launcher plus DP_OPEN, everything else is ShellExecute.
/// </summary>
public static class Openers
{
    public const string SystemDefault = "system";
    public const string DualPdf = "dual-pdf";
    public const string Notepad = "notepad";
    public const string VSCode = "vscode";
    public const string Custom = "custom";

    public static (bool ok, string msg) OpenFile(string path, string opener, Settings s, string customCommand = "")
    {
        if (string.IsNullOrWhiteSpace(path)) return (false, "路径为空");
        if (!File.Exists(path) && !Directory.Exists(path)) return (false, "文件不在了：" + path);

        switch (opener)
        {
            case DualPdf: return LaunchDual(path, s);
            case Notepad: return StartSimple("notepad.exe", "\"" + path + "\"");
            case VSCode: return StartSimple("code", "\"" + path + "\"", shell: true);
            case Custom:
                if (string.IsNullOrWhiteSpace(customCommand)) return (false, "没有配置自定义命令");
                var cmd = customCommand.Replace("{path}", path);
                return StartSimple("cmd.exe", "/d /s /c \"" + cmd + "\"", verbatim: true);
            default: return Shell(path);
        }
    }

    public static (bool ok, string msg) OpenDir(string path)
    {
        if (!Directory.Exists(path)) return (false, "文件夹不在了：" + path);
        return Shell(path);
    }

    public static (bool ok, string msg) OpenUrl(string url)
    {
        if (!url.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return (false, "不是网址：" + url);
        return Shell(url);
    }

    public static (bool ok, string msg) OpenApp(string exe)
    {
        if (!File.Exists(exe)) return (false, "程序不在：" + exe);
        return Shell(exe);
    }

    public static (bool ok, string msg) OpenTerminal(string cwd)
    {
        var dir = Directory.Exists(cwd) ? cwd : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var psi = new ProcessStartInfo("cmd.exe")
        {
            UseShellExecute = true,
            Arguments = "/k cd /d \"" + dir + "\"",
            WorkingDirectory = dir
        };
        try { Process.Start(psi); return (true, ""); }
        catch (Exception e) { return (false, e.Message); }
    }

    public static (bool ok, string msg) Shell(string target)
    {
        try
        {
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
            return (true, "");
        }
        catch (Exception e) { return (false, e.Message); }
    }

    static (bool ok, string msg) StartSimple(string exe, string args, bool shell = false, bool verbatim = false)
    {
        try
        {
            var psi = new ProcessStartInfo(exe)
            {
                UseShellExecute = shell,
                Arguments = args,
                CreateNoWindow = !shell
            };
            if (verbatim) psi.Arguments = args;
            Process.Start(psi);
            return (true, "");
        }
        catch (Exception e) { return (false, e.Message); }
    }

    // ---------------------------------------------------------------- Dual PDF
    // It is a local page plus a launcher, not a normal executable:
    // start.cjs brings up the service if needed and opens a window at ?open=<path>.
    public static (bool ok, string msg) LaunchDual(string path, Settings s)
    {
        var root = string.IsNullOrWhiteSpace(s.DualPdfHome) ? DetectDualHome() : s.DualPdfHome;
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
            return Shell(path);

        var launcher = Path.Combine(root, "local", "start.cjs");
        if (!File.Exists(launcher)) return (false, "找不到 dual 的启动器：" + launcher);

        var node = FindNode();
        if (node == null) return (false, "找不到 node.exe，无法启动 Dual PDF");

        try
        {
            var psi = new ProcessStartInfo(node)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = root,
                Arguments = "\"" + launcher + "\""
            };
            psi.Environment["DP_OPEN"] = path;
            Process.Start(psi);
            return (true, "");
        }
        catch (Exception e) { return (false, e.Message); }
    }

    public static string DetectDualHome()
    {
        var guesses = new List<string>();
        var docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        guesses.Add(Path.Combine(docs, "Codex", "2026-10-31", "ai-urology-systematic-v2", "dual-pdf-viewer"));
        foreach (var g in guesses)
            if (Directory.Exists(Path.Combine(g, "local")))
                return g;
        return "";
    }

    static string FindNode()
    {
        var candidates = new List<string> { "node.exe", "node" };
        candidates.Add(@"D:\Node js\node.exe");
        candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        candidates.Add(Path.Combine(local, "Microsoft", "WinGet", "Links", "node.exe"));
        foreach (var c in candidates)
        {
            try
            {
                if (Path.IsPathRooted(c)) { if (File.Exists(c)) return c; }
                else
                {
                    var p = Environment.GetEnvironmentVariable("PATH") ?? "";
                    foreach (var dir in p.Split(';'))
                    {
                        if (string.IsNullOrWhiteSpace(dir)) continue;
                        var full = Path.Combine(dir.Trim('"'), c);
                        if (File.Exists(full)) return full;
                    }
                }
            }
            catch { }
        }
        return null;
    }

    // ------------------------------------------------------------------ script
    /// <summary>Runs a command through cmd.exe and waits, capturing output.</summary>
    public static (bool ok, string output) RunScript(string command, string cwd, int timeoutMs = 180000)
    {
        if (string.IsNullOrWhiteSpace(command)) return (false, "命令为空");
        try
        {
            var psi = new ProcessStartInfo("cmd.exe")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                WorkingDirectory = Directory.Exists(cwd) ? cwd : Environment.CurrentDirectory,
                Arguments = "/d /s /c \"" + command + "\""
            };
            using var p = Process.Start(psi);
            var outTask = p.StandardOutput.ReadToEndAsync();
            var errTask = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(timeoutMs))
            {
                try { p.Kill(true); } catch { }
                return (false, "超时（" + (timeoutMs / 1000) + " 秒）被终止");
            }
            var text = (outTask.Result + "\n" + errTask.Result).Trim();
            if (text.Length > 4000) text = text.Substring(text.Length - 4000);
            return (p.ExitCode == 0, text);
        }
        catch (Exception e) { return (false, e.Message); }
    }
}
