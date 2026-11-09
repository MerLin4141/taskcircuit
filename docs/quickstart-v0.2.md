# TaskCircuit v0.2 Quick Start

This walkthrough uses the Mock Agent and needs no Codex/Claude login or API credential. It uses a fresh, isolated home and workspace. Node.js 24 or newer is required. For Windows background startup, see [Windows runtime](windows-runtime.md).

## 1. Build and prepare a trusted local configuration

Open PowerShell in the TaskCircuit checkout:

```powershell
npm ci
npm run build
$env:TC_PROJECT = (Get-Location).Path
$env:TC_DEMO = Join-Path $env:TEMP 'taskcircuit-v02-example'
if (Test-Path -LiteralPath $env:TC_DEMO) { throw 'Choose an unused TC_DEMO directory.' }
New-Item -ItemType Directory -Path $env:TC_DEMO | Out-Null
$env:TASKCIRCUIT_HOME = Join-Path $env:TC_DEMO 'state'
$workspace = Join-Path $env:TC_DEMO 'workspace'
New-Item -ItemType Directory -Path $workspace | Out-Null
$config = @{
  agents = @{ 'mock-demo' = @{ adapter = 'mock'; isolation = 'trusted-local' } }
  routes = @(@{ id = 'loop'; event = @{ source = 'local'; type = 'demo.loop' }; agent = 'mock-demo'; title = 'Demo loop' })
  policyWorkspaces = @{ demo = @{ path = $workspace; allowedRoot = $workspace; allowedCapabilities = @('read_files') } }
}
[IO.File]::WriteAllText((Join-Path $env:TC_DEMO 'taskcircuit.config.json'), ($config | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
Set-Location $env:TC_DEMO
node "$env:TC_PROJECT/dist/cli.js" doctor
node "$env:TC_PROJECT/dist/cli.js" hub
```

The Hub reads `taskcircuit.config.json` from its working directory at startup. This walkthrough creates a new configuration in the isolated demo directory; it does not overwrite the checkout's configuration. Doctor may warn that the Hub, Worker, or optional Agent CLIs are unavailable before startup.

## 2. Start a Worker

Open a second PowerShell terminal **in the checkout**:

```powershell
$env:TC_PROJECT = (Get-Location).Path
$env:TC_DEMO = Join-Path $env:TEMP 'taskcircuit-v02-example'
$env:TASKCIRCUIT_HOME = Join-Path $env:TC_DEMO 'state'
Set-Location $env:TC_DEMO
node "$env:TC_PROJECT/dist/cli.js" worker
```

## 3. Create an Automation and emit an Event

Open a third PowerShell terminal **in the checkout**:

```powershell
$env:TC_PROJECT = (Get-Location).Path
$env:TC_DEMO = Join-Path $env:TEMP 'taskcircuit-v02-example'
$env:TASKCIRCUIT_HOME = Join-Path $env:TC_DEMO 'state'
Set-Location $env:TC_DEMO
$workspace = Join-Path $env:TC_DEMO 'workspace'
node "$env:TC_PROJECT/dist/cli.js" automation create demo --event demo.loop --agent mock-demo --workspace $workspace
node "$env:TC_PROJECT/dist/cli.js" event emit demo.loop --automation demo
```

Copy the Root ID from the event response. The default limits are 8 runs and 2 hours; `--max-runs` and `--deadline` select finite alternatives. Automation creation requires the Agent profile, event type and workspace to be registered in the trusted Hub configuration.

## 4. Inspect the Root

```powershell
node "$env:TC_PROJECT/dist/cli.js" root list
node "$env:TC_PROJECT/dist/cli.js" root show <root-id>
node "$env:TC_PROJECT/dist/cli.js" watch
```

Replace `<root-id>` with the actual ID without angle brackets. The Mock Agent requests Continue twice, then completes. `--json` is supported on Automation and Root commands. Watch renders available changes but does not provide a complete Event/Root/Continue timeline. If a real Agent asks for input, use `inbox` and `answer <interaction-id> <answer>`.

Stop Hub and Worker with Ctrl+C in their terminals. Keep or remove the isolated demo directory yourself after stopping them. For real agents, install and authenticate the CLI yourself and add its profile and route to trusted configuration; provider usage may consume quota. Trusted Local is not an OS sandbox.
