using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;

namespace Workspace;

public partial class MainWindow : Window
{
    Bridge _bridge;
    bool _ready;

    public MainWindow()
    {
        InitializeComponent();
        Store.Log("window ctor");
        Width = 1440;
        Height = 900;
        try
        {
            // Fit the work area: high DPI panels can leave far less room than the
            // numbers suggest (a 1707x960 screen at 175% is only ~975x548 in DIPs).
            var wa = SystemParameters.WorkArea;
            Width = Math.Min(Math.Max(900, Store.Idx.Settings.WinW), Math.Max(900, wa.Width - 24));
            Height = Math.Min(Math.Max(620, Store.Idx.Settings.WinH), Math.Max(620, wa.Height - 24));
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
        }
        catch { }
        SourceInitialized += (_, __) => ApplyChrome();
        Loaded += async (_, __) => await Boot();
        Closing += (_, __) =>
        {
            try
            {
                Store.Idx.Settings.WinW = RestoreBounds.Width > 0 ? RestoreBounds.Width : Width;
                Store.Idx.Settings.WinH = RestoreBounds.Height > 0 ? RestoreBounds.Height : Height;
                Store.SaveIndex();
            }
            catch { }
        };
    }

    void ApplyChrome()
    {
        var src = (HwndSource)PresentationSource.FromVisual(this);
        src?.AddHook(WndProc);
    }

    /// <summary>
    /// Top strip drags the window natively; the traffic lights stay clickable.
    /// Also pins the minimum size at the OS level: WPF's MinWidth alone is
    /// bypassed by a native resize, and a degenerate window leaves the WebView
    /// surface blank with no way back.
    /// </summary>
    IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        const int WM_NCHITTEST = 0x0084;
        const int WM_GETMINMAXINFO = 0x0024;

        if (msg == WM_GETMINMAXINFO)
        {
            var dpi = VisualTreeHelper.GetDpi(this);
            var mmi = Marshal.PtrToStructure<MINMAXINFO>(lParam);
            mmi.ptMinTrackSize.x = (int)Math.Ceiling(MinWidth * dpi.DpiScaleX);
            mmi.ptMinTrackSize.y = (int)Math.Ceiling(MinHeight * dpi.DpiScaleY);
            Marshal.StructureToPtr(mmi, lParam, true);
            handled = true;
            return IntPtr.Zero;
        }

        if (msg != WM_NCHITTEST) return IntPtr.Zero;

        var x = (short)(lParam.ToInt64() & 0xFFFF);
        var y = (short)((lParam.ToInt64() >> 16) & 0xFFFF);
        var p = PointFromScreen(new Point(x, y));

        if (p.Y >= 0 && p.Y <= 46 && p.X > 118 && p.X < ActualWidth - 240)
        {
            handled = true;
            return (IntPtr)2; // HTCAPTION
        }
        return IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MINMAXINFO
    {
        public POINT ptReserved;
        public POINT ptMaxSize;
        public POINT ptMaxPosition;
        public POINT ptMinTrackSize;
        public POINT ptMaxTrackSize;
    }

    async Task Boot()
    {
        Store.Log("boot start");
        try
        {
            // Each run gets its own WebView2 profile folder. A leftover render
            // process from a previous run keeps a lock on the shared folder, and
            // Windows then refuses the new one with ERROR_BUSY (0x800700AA).
            var root = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "workspace", "webview2");
            Directory.CreateDirectory(root);
            CleanOldProfiles(root);
            var userData = Path.Combine(root, Environment.ProcessId.ToString());
            Directory.CreateDirectory(userData);

            var options = new CoreWebView2EnvironmentOptions("--disable-features=ElasticOverscroll");
            CoreWebView2Environment env = null;
            for (var attempt = 0; attempt < 3 && env == null; attempt++)
            {
                try { env = await CoreWebView2Environment.CreateAsync(null, userData, options); }
                catch (Exception ex)
                {
                    Store.Log("webview2 create attempt " + attempt + ": " + ex.Message);
                    if (attempt < 2) await Task.Delay(800);
                }
            }
            if (env == null) throw new InvalidOperationException("WebView2 创建环境失败（缓存目录被占用）");
            await Web.EnsureCoreWebView2Async(env);

            var core = Web.CoreWebView2;
            // A previous Ctrl+wheel may have left the page zoomed in; the factor is
            // remembered per origin, so clear it explicitly on every start.
            try { Web.ZoomFactor = 1.0; } catch { }
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = true;
            core.Settings.IsSwipeNavigationEnabled = false;

            core.SetVirtualHostNameToFolderMapping("app.local", AssetsDir(),
                CoreWebView2HostResourceAccessKind.Allow);

            // Let the page receive the drop: it can hand the file handles back to
            // the host, which is the only way to get a real path out of WebView2.
            Web.AllowExternalDrop = true;

            core.NavigationStarting += (_, e) => Store.Log("nav start " + e.Uri);
            core.NavigationCompleted += async (_, e) =>
            {
                Store.Log("nav done ok=" + e.IsSuccess + " status=" + e.WebErrorStatus);
                if (!e.IsSuccess)
                {
                    var html = "<body style='font:14px Segoe UI;padding:40px;color:#333'>页面没加载成功：" +
                               e.WebErrorStatus + "<br><br>assets: " + AssetsDir() + "</body>";
                    core.NavigateToString(html);
                    return;
                }
                // --probe <file.js> runs one script after the page settles and logs
                // its string result. Same contract as --diag: opt-in, read-only.
                var argv = Environment.GetCommandLineArgs();
                var probeAt = Array.IndexOf(argv, "--probe");
                if (probeAt >= 0 && probeAt + 1 < argv.Length && File.Exists(argv[probeAt + 1]))
                {
                    try
                    {
                        await Task.Delay(2200);
                        var script = File.ReadAllText(argv[probeAt + 1], System.Text.Encoding.UTF8);
                        var result = await core.ExecuteScriptAsync(script);
                        Store.Log("probe " + result);
                    }
                    catch (Exception ex) { Store.Log("probe failed " + ex.Message); }
                    return;
                }

                // Self check, opt-in with --diag: never touches selection or state.
                if (!Environment.GetCommandLineArgs().Contains("--diag")) return;                try
                {
                    await Task.Delay(1500);
                    var probe = @"(function(){var q=function(s){var e=document.querySelector(s);return e?Math.round(e.getBoundingClientRect().width):-1};
                      var err=document.getElementById('boot-error');var sb=document.querySelector('.sidebar');
                      var sh=document.querySelector('.shell');var r=sb?sb.getBoundingClientRect():{left:0,top:0,width:0,height:0};
                      var pillInfo='';
                      try{var seg=[].slice.call(document.querySelectorAll('#view-seg .seg-item')).filter(function(b){return b.dataset.view==='ledger'})[0];
                        if(seg) seg.click();
                        var p=document.querySelector('.pill.app');
                        if(p){var cs=getComputedStyle(p);var rr=p.getBoundingClientRect();
                          var par=p.parentElement;
                          var chain=[];var n2=p;for(var k=0;k<5&&n2;k++){var r2=n2.getBoundingClientRect();chain.push(n2.tagName+'.'+(n2.className||'')+':'+Math.round(r2.width)+'x'+Math.round(r2.height));n2=n2.parentElement;}
                          pillInfo='txt='+p.textContent+' lh='+cs.lineHeight+' pd='+cs.padding+' chain='+chain.join(' | ')
                            +' parent='+par.tagName+'.'+par.className+' pd='+getComputedStyle(par).display+' ph='+Math.round(par.getBoundingClientRect().height);}
                        else pillInfo='none';}catch(e){pillInfo='ERR '+e.message}
                      var inspErr='';var funcRows=0;
                      try{var ws0=window.__ws;var st0=ws0.state;var lb=(st0.libraries||[])[0];
                        if(lb){ws0.call('env.files',{libId:lb.id}).then(function(list){
                          var kinds={};list.forEach(function(x){kinds[x.kind]=(kinds[x.kind]||0)+1});
                          var dirs=0,files=0;list.forEach(function(x){if(x.kind==='dir')dirs++;else files++;});
                          window.__libInfo='n='+list.length+' dirs='+dirs+' files='+files+' first='+list.slice(0,4).map(function(x){return x.rel}).join(' , ');
                        });}}catch(e){inspErr='libprob '+e.message}
                      try{var ws=window.__ws;var st=ws.state;var env=(st.project.envs||[])[0];
                        if(env){st.insp={mode:'env',id:env.id};ws.renderInspector();
                          funcRows=document.querySelectorAll('#inspector .act-row').length;}}catch(e){inspErr=String(e.message||e)}
                      var zoomBefore=(document.getElementById('zoom-label')||{}).textContent||'';
                      var zin=document.querySelector(""#zoom-ctl button[data-zoom='in']"");
                      if(zin) zin.click();
                      var zoomAfter=(document.getElementById('zoom-label')||{}).textContent||'';
                      var zout=document.querySelector(""#zoom-ctl button[data-zoom='out']"");
                      if(zout) zout.click();
                      return JSON.stringify({iw:innerWidth,ih:innerHeight,shell:q('.shell'),side:q('.sidebar'),stage:q('.stage'),insp:q('.inspector'),
                        zoom:zoomBefore+'>'+zoomAfter,funcRows:funcRows,inspErr:inspErr,pill:pillInfo,lib:window.__libInfo||'',
                        cols:sh?getComputedStyle(sh).gridTemplateColumns:'',sbLeft:Math.round(r.left),sbTop:Math.round(r.top),sbH:Math.round(r.height),
                        sbBg:sb?getComputedStyle(sb).backgroundColor:'',sbVis:sb?getComputedStyle(sb).display:'',
                        booted:!!window.__booted, state:window.__initState||'', errs:(window.__errs||[]).slice(0,5),
                        rows:document.querySelectorAll('#sidebar .row').length,labels:document.querySelectorAll('#sidebar .side-label').length,
                        firstLabel:(document.querySelector('#sidebar .side-label')||{}).textContent||'',
                        blocks:document.querySelectorAll('.block').length,
                        err:err&&!err.classList.contains('hidden')?err.textContent.slice(0,300):''});})()";
                    var res = await core.ExecuteScriptAsync(probe);
                    Store.Log("diag " + res);
                    await Task.Delay(900);   // the library probe resolves asynchronously
                    var libRes = await core.ExecuteScriptAsync("window.__libInfo||'(pending)'");
                    Store.Log("lib-diag " + libRes);
                }
                catch (Exception ex) { Store.Log("diag failed " + ex.Message); }
            };
            core.ProcessFailed += (_, e) => Store.Log("PROCESS FAILED " + e.ProcessFailedKind);

            core.WebMessageReceived += OnMessage;
            core.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(e.Uri) { UseShellExecute = true }); }
                catch { }
            };

            // With --diag, report the canvas layout again after every resize,
            // so "the canvas went blank" can be told apart from "it is empty".
            if (Environment.GetCommandLineArgs().Contains("--diag"))
            {
                var lastProbe = DateTime.MinValue;
                Web.SizeChanged += async (_, __) =>
                {
                    if ((DateTime.Now - lastProbe).TotalMilliseconds < 700) return;
                    lastProbe = DateTime.Now;
                    await Task.Delay(700);
                    try
                    {
                        var js = @"(function(){var v=document.querySelector('.canvas-viewport');var w=document.querySelector('#world');
                          var b=document.querySelector('.stage-body');var n=document.querySelectorAll('.block').length;
                          var vr=v?v.getBoundingClientRect():{width:0,height:0,left:0,top:0};
                          var br=b?b.getBoundingClientRect():{width:0,height:0,left:0,top:0};
                          return JSON.stringify({iw:innerWidth,ih:innerHeight,vw:Math.round(vr.width),vh:Math.round(vr.height),
                            vl:Math.round(vr.left),vt:Math.round(vr.top),bw:Math.round(br.width),bh:Math.round(br.height),
                            tf:w?getComputedStyle(w).transform:'none',blocks:n,
                            bg:v?getComputedStyle(v).backgroundColor:'',world:w?Math.round(w.getBoundingClientRect().width):-1});})()";
                        var res = await Web.CoreWebView2.ExecuteScriptAsync(js);
                        Store.Log("resize-diag " + res);
                    }
                    catch (Exception ex) { Store.Log("resize-diag failed " + ex.Message); }
                };
            }

            _bridge = new Bridge(this, Web);
            _ready = true;
            core.Navigate("https://app.local/index.html");
        }
        catch (Exception e)
        {
            Store.Log("boot: " + e);
            MessageBox.Show("WebView2 启动失败：\n" + e.Message, "Workspace", MessageBoxButton.OK, MessageBoxImage.Error);
            Application.Current.Shutdown();
        }
    }

    /// <summary>Leftover profile folders from earlier runs can still be locked; skip those.</summary>
    static void CleanOldProfiles(string root)
    {
        var keep = Environment.ProcessId.ToString();
        foreach (var dir in Directory.GetDirectories(root))
        {
            var name = Path.GetFileName(dir);
            if (name == keep) continue;
            if (!int.TryParse(name, out _)) continue;
            try { Directory.Delete(dir, true); }
            catch { /* still locked by a dying render process — next start will get it */ }
        }
    }

    /// <summary>During development the assets folder next to the sources wins, so edits show on reload.</summary>
    static string AssetsDir()
    {
        var exe = AppContext.BaseDirectory;
        var dev = Path.GetFullPath(Path.Combine(exe, "..", "..", "..", "assets"));
        if (Directory.Exists(dev)) return dev;
        var local = Path.Combine(exe, "assets");
        return Directory.Exists(local) ? local : dev;
    }

    async void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!_ready) return;
        string id = "";
        try
        {
            var raw = e.WebMessageAsJson;
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            id = root.TryGetProperty("id", out var idEl) ? idEl.ToString() : "";
            var method = root.TryGetProperty("method", out var mEl) ? mEl.GetString() : "";
            var paramsEl = root.TryGetProperty("params", out var pEl) ? pEl : default;

            // Dropped files arrive here: the page hands over FileSystemHandles and
            // the host reads their real paths.
            if (method == "files.dropped")
            {
                var paths = new List<string>();
                var kinds = new List<string>();
                foreach (var obj in e.AdditionalObjects)
                {
                    var t = obj == null ? "NULL" : obj.GetType().FullName;
                    if (obj is CoreWebView2FileSystemHandle h)
                    {
                        kinds.Add(t + ":handle:" + h.Kind + ":len=" + (h.Path ?? "").Length);
                        if (!string.IsNullOrEmpty(h.Path)) paths.Add(h.Path);
                    }
                    else if (obj is CoreWebView2File cf)
                    {
                        kinds.Add(t + ":file:" + (cf.Path ?? "").Length);
                        if (!string.IsNullOrEmpty(cf.Path)) paths.Add(cf.Path);
                    }
                    else kinds.Add(t);
                }
                Store.Log("drop types n=" + e.AdditionalObjects.Count + " :: " + string.Join(" | ", kinds));
                var px = paramsEl.ValueKind == JsonValueKind.Object && paramsEl.TryGetProperty("x", out var xe) ? xe.GetDouble() : 0;
                var py = paramsEl.ValueKind == JsonValueKind.Object && paramsEl.TryGetProperty("y", out var ye) ? ye.GetDouble() : 0;
                Store.Log("drop " + paths.Count + " item(s)");
                Post(new { @event = "filesDropped", paths, x = px, y = py });
                return;
            }

            var result = await _bridge.Handle(method, paramsEl);
            Post(new { id, ok = true, result });
        }
        catch (Exception ex)
        {
            var message = ex is Bridge.BridgeError ? ex.Message : ex.Message;
            if (ex is not Bridge.BridgeError) Store.Log("bridge: " + ex);
            Post(new { id, ok = false, error = message });
        }
    }

    void Post(object o)
    {
        try
        {
            var text = Json.S(o);
            Web.CoreWebView2?.PostWebMessageAsJson(text);
        }
        catch (Exception ex) { Store.Log("POST FAILED: " + ex); }
    }

    public void ToggleMax()
    {
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    }

    // ------------------------------------------------------------ window chrome
    // The WebView2 child window covers the client area, so WM_NCHITTEST never
    // reaches the parent. The page asks for a drag/resize instead, and we start
    // Windows' own non-client loop — that keeps snapping and aero-snap working.

    [DllImport("user32.dll")]
    static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    IntPtr Handle => new WindowInteropHelper(this).Handle;

    public void StartWindowDrag()
    {
        ReleaseCapture();
        SendMessage(Handle, 0x00A1 /* WM_NCLBUTTONDOWN */, (IntPtr)2 /* HTCAPTION */, IntPtr.Zero);
    }

    public void StartWindowResize(string edge)
    {
        var code = edge switch
        {
            "t" => 12, "b" => 15, "l" => 10, "r" => 11,
            "tl" => 13, "tr" => 14, "bl" => 16, "br" => 17,
            _ => 0
        };
        if (code == 0) return;
        ReleaseCapture();
        SendMessage(Handle, 0x00A1, (IntPtr)code, IntPtr.Zero);
    }

}
