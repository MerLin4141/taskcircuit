using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

internal static class TaskCircuitBootstrap
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Basic
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Io
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Extended
    {
        public Basic BasicLimitInformation;
        public Io IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            slashes = 0;
            result.Append(c);
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static int Main(string[] args)
    {
        if (args.Length == 0) return 1;
        IntPtr job = IntPtr.Zero;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return 1;
            var info = new Extended();
            info.BasicLimitInformation.LimitFlags = 0x2000;
            if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)))) return 1;
            var arguments = new string[args.Length - 1];
            for (int i = 1; i < args.Length; i++) arguments[i - 1] = Quote(args[i]);
            var start = new ProcessStartInfo(args[0], string.Join(" ", arguments));
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            using (var process = Process.Start(start))
            {
                if (process == null) return 1;
                if (!AssignProcessToJobObject(job, process.Handle))
                {
                    process.Kill();
                    process.WaitForExit();
                    return 1;
                }
                process.StandardInput.WriteLine("start");
                process.StandardInput.Close();
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch { return 1; }
        finally { if (job != IntPtr.Zero) CloseHandle(job); }
    }
}
