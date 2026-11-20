using System.Runtime.InteropServices;

namespace Workspace;

/// <summary>
/// Puts the process into a job object flagged "kill everything when the job
/// closes". Child processes inherit the job, so WebView2's renderer, GPU and
/// utility processes are torn down together with the host — even if the host is
/// killed from Task Manager rather than closed by the user.
/// </summary>
internal static class JobGuard
{
    // The handle must stay open for the lifetime of the process; closing it is
    // exactly what triggers the kill, so it is deliberately never disposed.
    static IntPtr _job = IntPtr.Zero;

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    public static void Attach()
    {
        try
        {
            if (_job != IntPtr.Zero) return;
            _job = CreateJobObject(IntPtr.Zero, null);
            if (_job == IntPtr.Zero) return;

            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            var size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
            var buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, buffer, false);
                if (!SetInformationJobObject(_job, JobObjectExtendedLimitInformation, buffer, (uint)size))
                {
                    Store.Log("job: SetInformationJobObject failed " + Marshal.GetLastWin32Error());
                    return;
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }

            // Nesting is allowed since Windows 8; if the process already sits in a
            // job that forbids it, we simply go on unguarded.
            if (!AssignProcessToJobObject(_job, GetCurrentProcess()))
                Store.Log("job: AssignProcessToJobObject failed " + Marshal.GetLastWin32Error());
        }
        catch (Exception ex) { Store.Log("job: " + ex.Message); }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
}
