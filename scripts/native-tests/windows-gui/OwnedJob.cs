using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.IO;

public sealed class FluuxOwnedJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
        public BASIC_LIMIT Basic;
        public IO_COUNTERS IO;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint Faults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedPtr, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXTENDED_LIMIT info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out ACCOUNTING info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder args, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    IntPtr job, process;
    public uint ProcessId { get; private set; }
    public bool Cancelled { get; private set; }
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static void CheckDesktop() {
        var desktop = OpenInputDesktop(0, false, 1);
        Check(desktop != IntPtr.Zero);
        CloseDesktop(desktop);
        if (!Environment.UserInteractive || System.Diagnostics.Process.GetCurrentProcess().SessionId == 0)
            throw new InvalidOperationException("An interactive Windows desktop is required");
    }
    public FluuxOwnedJob() {
        job = CreateJobObject(IntPtr.Zero, null);
        Check(job != IntPtr.Zero);
        var limits = new EXTENDED_LIMIT();
        // KILL_ON_JOB_CLOSE also contains descendants if the supervisor itself is terminated.
        limits.Basic.Flags = 0x2000;
        try { Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))); }
        catch { Dispose(); throw; }
    }
    public void Start(string executable, string arguments, string cwd) {
        var startup = new STARTUPINFO();
        startup.Size = (uint)Marshal.SizeOf(startup);
        PROCESS_INFORMATION child;
        // Assign before resume: a fast child must not escape ownership by spawning first.
        Check(CreateProcess(executable, new StringBuilder("\"" + executable + "\" " + arguments), IntPtr.Zero, IntPtr.Zero, false, 4, IntPtr.Zero, cwd, ref startup, out child));
        process = child.Process;
        ProcessId = child.ProcessId;
        try {
            Check(AssignProcessToJobObject(job, process));
            if (ResumeThread(child.Thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
        } catch { TerminateProcess(process, 1); throw; }
        finally { CloseHandle(child.Thread); }
    }
    public uint Wait(int milliseconds, string cancelFile) {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        while (true) {
            var state = WaitForSingleObject(process, 100);
            if (state == 0) { uint code; Check(GetExitCodeProcess(process, out code)); return code; }
            if (state != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (File.Exists(cancelFile)) { Cancelled = true; return 124; }
            if (watch.ElapsedMilliseconds >= milliseconds) return 124;
        }
    }
    public uint ActiveProcesses() {
        ACCOUNTING info;
        Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero));
        return info.ActiveProcesses;
    }
    public void Stop() {
        Check(TerminateJobObject(job, 1));
        var watch = System.Diagnostics.Stopwatch.StartNew();
        while (ActiveProcesses() != 0) {
            if (watch.ElapsedMilliseconds > 10000) throw new TimeoutException("Owned Windows job did not stop");
            Thread.Sleep(50);
        }
    }
    public void Dispose() {
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
        if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
    }
}
