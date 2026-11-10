# TaskCircuit v0.3 Quick Start

This example runs the built-in Mock Agent with Node.js 24 or newer; no agent credentials are required. Run it from a checkout and choose an unused local port. The configuration, database and workspace below are isolated from your normal TaskCircuit home.

## 1. Prepare trusted configuration and rules

In PowerShell in the checkout:

```powershell
npm ci
npm run build
$env:TC_PROJECT = (Get-Location).Path
$env:TC_DEMO = Join-Path $env:TEMP 'taskcircuit-v03-example'
if (Test-Path -LiteralPath $env:TC_DEMO) { throw 'Choose an unused TC_DEMO directory.' }
New-Item -ItemType Directory -Path $env:TC_DEMO | Out-Null
$env:TASKCIRCUIT_HOME = Join-Path $env:TC_DEMO 'state'
$env:TASKCIRCUIT_PORT = '54321'
$workspace = Join-Path $env:TC_DEMO 'workspace'
New-Item -ItemType Directory -Path $workspace | Out-Null
$config = @{
  agents = @{ 'mock-demo' = @{ adapter = 'mock'; isolation = 'trusted-local' } }
  routes = @(@{ id = 'loop'; event = @{ source = 'local'; type = 'demo.loop' }; agent = 'mock-demo'; title = 'Demo loop' })
  policyWorkspaces = @{ demo = @{ path = $workspace; allowedRoot = $workspace; allowedCapabilities = @('read_files') } }
}
$rules = @{
  schemaVersion = 1; id = 'example'; rules = @(@{
    name = 'demo'; when = @{ source = 'local'; type = 'demo.loop' }
    agent = 'mock-demo'; workspace = 'demo'; instruction = 'Run the mock demo'
    loop = @{ maxRuns = 8; deadline = '2h' }
  })
}
[IO.File]::WriteAllText((Join-Path $env:TC_DEMO 'taskcircuit.config.json'), ($config | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $env:TC_DEMO 'rules.json'), ($rules | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
Set-Location $env:TC_DEMO
node "$env:TC_PROJECT/dist/cli.js" hub
```

The Hub reads trusted configuration from its working directory. If the selected port is occupied, choose another port and use it in every terminal.

## 2. Start a Worker

In another PowerShell terminal in the checkout:

```powershell
$env:TC_PROJECT = (Get-Location).Path
$env:TC_DEMO = Join-Path $env:TEMP 'taskcircuit-v03-example'
$env:TASKCIRCUIT_HOME = Join-Path $env:TC_DEMO 'state'
$env:TASKCIRCUIT_PORT = '54321'
Set-Location $env:TC_DEMO
node "$env:TC_PROJECT/dist/cli.js" worker
```

## 3. Apply rules and run the demo

In a third terminal in the checkout, set the same variables and directory as in step 2, then run:

```powershell
node "$env:TC_PROJECT/dist/cli.js" apply .\rules.json --dry-run
node "$env:TC_PROJECT/dist/cli.js" apply .\rules.json
node "$env:TC_PROJECT/dist/cli.js" apply .\rules.json
node "$env:TC_PROJECT/dist/cli.js" event emit demo.loop --automation demo
node "$env:TC_PROJECT/dist/cli.js" root list
node "$env:TC_PROJECT/dist/cli.js" root show <root-id>
```

Replace `<root-id>` with the ID from the event output. The second apply is unchanged. The Mock Agent continues twice and finishes. Stop the Hub and Worker with Ctrl+C when done. For real agents, install and authenticate the CLI yourself; calls may use provider quota.

Only load external plugins you trust: their top-level code executes with your local user permissions. Trusted Local is not an OS sandbox, and loopback is not authentication. See [declarative rules](declarative-automation.md) and [plugin authoring](plugin-authoring.md).
