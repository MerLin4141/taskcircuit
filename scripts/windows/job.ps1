param([Parameter(Mandatory=$true)][string]$Node,[Parameter(Mandatory=$true)][string]$Launcher,[Parameter(Mandatory=$true)][string]$RuntimeHome,[Parameter(Mandatory=$true)][string]$AppDir,[string]$WorkspaceRoot,[switch]$WaitForBootstrap,[string]$ConfigPath,[switch]$UseDefaultConfig)
$ErrorActionPreference = 'Stop'
if($WaitForBootstrap -and [Console]::ReadLine() -ne 'start'){throw 'Bootstrap handshake failed'}
trap {
 try { $dir=Join-Path $RuntimeHome 'logs';New-Item -ItemType Directory -Force -Path $dir | Out-Null; $detail=[pscustomobject]@{timestamp=[DateTime]::UtcNow.ToString('o');component='windows-job';level='error';message='Job launcher failed';errorType=$_.Exception.GetType().Name;errorCode=$_.Exception.HResult;nativeCode=$_.Exception.NativeErrorCode;stage=$step};Add-Content -LiteralPath (Join-Path $dir 'runtime.log') -Value ($detail | ConvertTo-Json -Compress) -Encoding utf8 } catch {}
 exit 1
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TaskCircuitJob {
 [StructLayout(LayoutKind.Sequential)] public struct Basic { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] public struct Io { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
 [StructLayout(LayoutKind.Sequential)] public struct Extended { public Basic BasicLimitInformation; public Io IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job,int infoClass,ref Extended info,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
 public static IntPtr Create() { var job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new System.ComponentModel.Win32Exception(); var info=new Extended();info.BasicLimitInformation.LimitFlags=0x2000; if(!SetInformationJobObject(job,9,ref info,(uint)Marshal.SizeOf(typeof(Extended)))) { CloseHandle(job);throw new System.ComponentModel.Win32Exception(); }return job; }
}
"@
$step='create-job'
$jobHandle=[TaskCircuitJob]::Create()
$process=$null
try {
 $env:TASKCIRCUIT_HOME=$RuntimeHome
 if($ConfigPath){$env:TASKCIRCUIT_CONFIG=$ConfigPath;Remove-Item Env:TASKCIRCUIT_CONFIG_DEFAULT -ErrorAction SilentlyContinue}
 elseif($UseDefaultConfig){Remove-Item Env:TASKCIRCUIT_CONFIG -ErrorAction SilentlyContinue;$env:TASKCIRCUIT_CONFIG_DEFAULT='1'}
 if($WorkspaceRoot){$env:TASKCIRCUIT_WORKSPACE_ROOT=$WorkspaceRoot}
 $start=[System.Diagnostics.ProcessStartInfo]::new()
 $start.FileName=$Node
 $start.Arguments='"' + $Launcher.Replace('"','\"') + '"'
 $start.WorkingDirectory=$AppDir
 $start.UseShellExecute=$false
 $start.CreateNoWindow=$true
 $start.RedirectStandardInput=$true
 $step='start-process'
 $process=[System.Diagnostics.Process]::Start($start)
 $step='assign-job'
 if(-not [TaskCircuitJob]::AssignProcessToJobObject($jobHandle,$process.Handle)) { throw [System.ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
 $process.StandardInput.WriteLine('start')
 $process.StandardInput.Close()
 $process.WaitForExit()
 exit $process.ExitCode
} finally {
 if($jobHandle -ne [IntPtr]::Zero){[void][TaskCircuitJob]::CloseHandle($jobHandle)}
 if($process){$process.Dispose()}
}
