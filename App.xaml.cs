using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;

namespace Workspace;

public partial class App : Application
{
    Mutex _mutex;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // Everything this app spawns — including WebView2's six processes — dies
        // with the app. Without this a force-killed host leaves the renderer
        // behind, still holding memory and the profile folder.
        JobGuard.Attach();

        _mutex = new Mutex(true, "Global\\WorkspaceApp_v1", out var created);
        if (!created)
        {
            // Already running: bring that window forward instead of dying silently,
            // which is what made a double click look like "nothing happens".
            ActivateRunningInstance();
            Shutdown();
            return;
        }

        DispatcherUnhandledException += (_, ex) =>
        {
            Store.Log("UNHANDLED: " + ex.Exception);
            MessageBox.Show(ex.Exception.Message, "Workspace 出错", MessageBoxButton.OK, MessageBoxImage.Error);
            ex.Handled = true;
        };

        Store.Load();
        var win = new MainWindow();
        win.Show();
    }

    /// <summary>
    /// SetForegroundWindow is refused when the calling process is not the
    /// foreground one, so borrow the foreground thread's input state first.
    /// </summary>
    static void ActivateRunningInstance()
    {
        IntPtr hwnd = IntPtr.Zero;
        for (var i = 0; i < 20 && hwnd == IntPtr.Zero; i++)
        {
            hwnd = FindWindow(null, "Workspace");
            if (hwnd == IntPtr.Zero) Thread.Sleep(150);
        }
        if (hwnd == IntPtr.Zero) return;

        ShowWindow(hwnd, SW_RESTORE);
        var fg = GetForegroundWindow();
        var fgThread = GetWindowThreadProcessId(fg, out _);
        var me = GetCurrentThreadId();
        var attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        try
        {
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
        }
        finally
        {
            if (attached) AttachThreadInput(me, fgThread, false);
        }
        FlashWindowEx(hwnd);
    }

    const int SW_RESTORE = 9;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindow(string cls, string title);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr h, int cmd);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr h);

    [DllImport("user32.dll")]
    static extern bool BringWindowToTop(IntPtr h);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    static extern bool AttachThreadInput(uint attach, uint attachTo, bool doAttach);

    [StructLayout(LayoutKind.Sequential)]
    struct FLASHWINFO
    {
        public uint cbSize;
        public IntPtr hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }

    static void FlashWindowEx(IntPtr hwnd)
    {
        var info = new FLASHWINFO
        {
            cbSize = (uint)Marshal.SizeOf<FLASHWINFO>(),
            hwnd = hwnd,
            dwFlags = 0x00000002 | 0x0000000C, // FLASHW_TRAY | FLASHW_TIMERNOFG
            uCount = 3,
            dwTimeout = 0
        };
        FlashWindowExImpl(ref info);
    }

    [DllImport("user32.dll", EntryPoint = "FlashWindowEx")]
    static extern bool FlashWindowExImpl(ref FLASHWINFO info);
}
