param([Parameter(Mandatory=$true)][ValidateSet('install','inspect','start','uninstall')][string]$Action,[Parameter(Mandatory=$true)][string]$Name,[string]$Node,[string]$Launcher,[string]$RuntimeHome,[string]$AppDir,[string]$JobScript,[string]$WorkspaceRoot)
$ErrorActionPreference='Stop'
if($Name -notmatch '^TaskCircuit(?:-[a-zA-Z0-9-]+)?$'){throw 'Invalid task name'}
if($Action -eq 'install') {
 $existing=Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
 if($existing -and $existing.Description -ne 'TaskCircuit managed startup task'){throw 'Task name already belongs to another application'}
 foreach($value in @($Node,$Launcher,$RuntimeHome,$AppDir,$JobScript)){if(-not $value -or $value.Contains('"')){throw 'Invalid task path'}}
 $psExe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
 function Quote-TaskArg([string]$Value) { return '"' + ($Value -replace '(\\+)$','$1$1') + '"' }
 $arguments='-NoProfile -NonInteractive -WindowStyle Hidden -File ' + (Quote-TaskArg $JobScript) + ' -Node ' + (Quote-TaskArg $Node) + ' -Launcher ' + (Quote-TaskArg $Launcher) + ' -RuntimeHome ' + (Quote-TaskArg $RuntimeHome) + ' -AppDir ' + (Quote-TaskArg $AppDir)
 if($WorkspaceRoot){if($WorkspaceRoot.Contains('"')){throw 'Invalid workspace path'};$arguments += ' -WorkspaceRoot ' + (Quote-TaskArg $WorkspaceRoot)}
 $taskAction=New-ScheduledTaskAction -Execute $psExe -Argument $arguments -WorkingDirectory $AppDir
 $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
 $trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity
 $principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
 $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
 Register-ScheduledTask -TaskName $Name -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'TaskCircuit managed startup task' -Force | Out-Null
 [pscustomobject]@{installed=$true;name=$Name}|ConvertTo-Json -Compress
} elseif($Action -eq 'inspect') {
 $task=Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
 if(-not $task){[pscustomobject]@{installed=$false;name=$Name}|ConvertTo-Json -Compress;exit 0}
 $info=Get-ScheduledTaskInfo -TaskName $Name
 $isCurrentUser=$false
 try { $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $account=$task.Principal.UserId; if($account -match '^S-1-'){$taskSid=[System.Security.Principal.SecurityIdentifier]::new($account)}else{$taskSid=([System.Security.Principal.NTAccount]::new($account)).Translate([System.Security.Principal.SecurityIdentifier])};$isCurrentUser=$sid.Equals($taskSid) } catch { $isCurrentUser=$false }
 [pscustomobject]@{installed=$true;owned=($task.Description -eq 'TaskCircuit managed startup task');currentUser=$isCurrentUser;name=$Name;state=[string]$task.State;lastTaskResult=$info.LastTaskResult;lastRunTime=$info.LastRunTime.ToString('o');execute=$task.Actions[0].Execute;arguments=$task.Actions[0].Arguments;trigger=[string]$task.Triggers[0].CimClass.CimClassName;logonType=[string]$task.Principal.LogonType;runLevel=[string]$task.Principal.RunLevel}|ConvertTo-Json -Compress
} elseif($Action -eq 'start') {
 $existing=Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
 if(-not $existing){throw 'Windows Startup Task is not installed'}
 if($existing.Description -ne 'TaskCircuit managed startup task'){throw 'Task is not managed by TaskCircuit'}
 Start-ScheduledTask -TaskName $Name
 [pscustomobject]@{started=$true}|ConvertTo-Json -Compress
} else {
 $existing=Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
 if($existing){if($existing.Description -ne 'TaskCircuit managed startup task'){throw 'Task is not managed by TaskCircuit'};Unregister-ScheduledTask -TaskName $Name -Confirm:$false}
 [pscustomobject]@{removed=$true}|ConvertTo-Json -Compress
}
