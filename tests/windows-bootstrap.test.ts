// Guards against terminal allocation, broken argument quoting and lost child exit codes.
import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe.skipIf(process.platform !== "win32")("Windows GUI bootstrap", () => {
  it("starts a console child without a window and propagates arguments and exit code", () => {
    const root = mkdtempSync(join(tmpdir(), "tc bootstrap test "));
    const ps = join(
      process.env.SystemRoot!,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const helper = join(root, "helper.exe");
    const child = join(root, "child.exe");
    const resultFile = join(root, "result.txt");
    const childSource = `using System; using System.IO; using System.Runtime.InteropServices;
public static class Probe {
 [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
 public static int Main(string[] args) { Console.ReadLine(); File.WriteAllText(args[0], args[1]); return GetConsoleWindow() == IntPtr.Zero ? 37 : 38; }
}`;
    try {
      const compile = spawnSync(
        ps,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          '$ErrorActionPreference="Stop"; Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $env:TC_SOURCE) -OutputType WindowsApplication -OutputAssembly $env:TC_HELPER; Add-Type -TypeDefinition $env:TC_CHILD_SOURCE -OutputType ConsoleApplication -OutputAssembly $env:TC_CHILD',
        ],
        {
          windowsHide: true,
          encoding: "utf8",
          env: {
            ...process.env,
            TC_SOURCE: join(
              process.cwd(),
              "scripts",
              "windows",
              "bootstrap.cs",
            ),
            TC_HELPER: helper,
            TC_CHILD: child,
            TC_CHILD_SOURCE: childSource,
          },
        },
      );
      expect(compile.status, compile.stderr).toBe(0);
      const value = 'spaces and "quotes" and trailing \\';
      const execution = spawnSync(helper, [child, resultFile, value], {
        windowsHide: true,
        timeout: 10000,
      });
      expect(execution.status).toBe(37);
      expect(readFileSync(resultFile, "utf8")).toBe(value);
    } finally {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }, 20000);

  it("does not leave the child running when the GUI bootstrap is killed", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc bootstrap kill "));
    const ps = join(
      process.env.SystemRoot!,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const helper = join(root, "helper.exe");
    const child = join(root, "child.exe");
    const pidFile = join(root, "pid.txt");
    const source = `using System; using System.IO; using System.Threading; using System.Diagnostics;
public static class Probe { public static int Main(string[] args) { Console.ReadLine(); File.WriteAllText(args[0], Process.GetCurrentProcess().Id.ToString()); Thread.Sleep(30000); return 0; } }`;
    let pid = 0;
    let launcher: ReturnType<typeof spawn> | undefined;
    const alive = (id: number) => {
      try {
        process.kill(id, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      const compile = spawnSync(
        ps,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          '$ErrorActionPreference="Stop"; Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $env:TC_SOURCE) -OutputType WindowsApplication -OutputAssembly $env:TC_HELPER; Add-Type -TypeDefinition $env:TC_CHILD_SOURCE -OutputType ConsoleApplication -OutputAssembly $env:TC_CHILD',
        ],
        {
          windowsHide: true,
          encoding: "utf8",
          env: {
            ...process.env,
            TC_SOURCE: join(
              process.cwd(),
              "scripts",
              "windows",
              "bootstrap.cs",
            ),
            TC_HELPER: helper,
            TC_CHILD: child,
            TC_CHILD_SOURCE: source,
          },
        },
      );
      expect(compile.status, compile.stderr).toBe(0);
      launcher = spawn(helper, [child, pidFile], {
        windowsHide: true,
        stdio: "ignore",
      });
      for (let i = 0; i < 100 && !existsSync(pidFile); i++)
        await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(pidFile)).toBe(true);
      pid = Number(readFileSync(pidFile, "utf8"));
      expect(alive(pid)).toBe(true);
      launcher.kill();
      for (let i = 0; i < 100 && alive(pid); i++)
        await new Promise((r) => setTimeout(r, 50));
      expect(alive(pid)).toBe(false);
    } finally {
      if (launcher?.exitCode === null && launcher.signalCode === null) {
        launcher.kill();
        await new Promise<void>((resolve) =>
          launcher!.once("exit", () => resolve()),
        );
      }
      if (pid && alive(pid)) process.kill(pid);
      for (let i = 0; i < 100 && pid && alive(pid); i++)
        await new Promise((r) => setTimeout(r, 50));
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  }, 20000);
});
