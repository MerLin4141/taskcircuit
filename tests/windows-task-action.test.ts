// Prevent interactive scheduled tasks from opening a persistent console window.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe.skipIf(process.platform !== "win32")(
  "scheduled runtime action",
  () => {
    it("starts Windows PowerShell hidden and noninteractive with the Job launcher", () => {
      const powershell = join(
        process.env.SystemRoot!,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const script = join(process.cwd(), "scripts", "windows", "task.ps1");
      const harness = `
function Get-ScheduledTask { param($TaskName) }
function New-Item { param($ItemType,$Path,[switch]$Force) }
function Test-Path { param($LiteralPath) return $false }
function Add-Type { param($TypeDefinition,$OutputType,$OutputAssembly) }
function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory) [pscustomobject]@{execute=$Execute; arguments=$Argument; workingDirectory=$WorkingDirectory} }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User) return 'trigger' }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) return 'principal' }
function New-ScheduledTaskSettingsSet { param($MultipleInstances, $ExecutionTimeLimit) return 'settings' }
function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Principal,$Settings,$Description,[switch]$Force) [Console]::Error.WriteLine(($Action | ConvertTo-Json -Compress)) }
& $env:TC_TEST_SCRIPT -Action install -Name TaskCircuit-Test-Fake -Node 'C:\\workspace\\node.exe' -Launcher 'C:\\workspace\\launcher.js' -RuntimeHome 'C:\\workspace\\state' -AppDir 'C:\\workspace' -JobScript 'C:\\workspace\\job.ps1' -ConfigPath 'C:\\User Automation Project\\taskcircuit.config.json'
`;
      const result = spawnSync(
        powershell,
        ["-NoProfile", "-NonInteractive", "-Command", harness],
        {
          env: {
            ...process.env,
            TC_TEST_SCRIPT: script,
            TASKCIRCUIT_GITHUB_WEBHOOK_SECRET: "synthetic-task-argument-secret",
          },
          encoding: "utf8",
          windowsHide: true,
        },
      );
      expect(result.status).toBe(0);
      const action = JSON.parse(result.stderr.trim()) as {
        execute: string;
        arguments: string;
        workingDirectory: string;
      };
      expect(action.execute).toMatch(
        /TaskCircuitBootstrap-[a-f0-9]{16}\.exe$/i,
      );
      expect(action.arguments.toLowerCase()).toContain(
        powershell.toLowerCase(),
      );
      expect(action.arguments).toMatch(/(?:^|\s)-NoProfile(?:\s|$)/i);
      expect(action.arguments).toMatch(/(?:^|\s)-NonInteractive(?:\s|$)/i);
      expect(action.arguments).toMatch(
        /(?:^|\s)-WindowStyle\s+Hidden(?:\s|$)/i,
      );
      expect(action.arguments).toMatch(/-File\s+"C:\\workspace\\job\.ps1"/i);
      expect(action.arguments).toContain(
        '-ConfigPath "C:\\User Automation Project\\taskcircuit.config.json"',
      );
      expect(action.arguments).not.toContain("synthetic-task-argument-secret");
      expect(action.workingDirectory).toBe("C:\\workspace");
    });
  },
);
