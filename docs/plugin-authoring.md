# Trusted local plugins

Plugins execute as the TaskCircuit user. They are trusted local code, **not an OS sandbox**. Module top-level code runs before the manifest is checked. Install or copy only code you trust; TaskCircuit does not download or install plugins.

A trusted `taskcircuit.config.json` may declare Hub Source/Channel and Worker Agent modules. Module references are local absolute paths, paths relative to the config directory, or installed package names resolved from that directory. URLs are rejected. Installed packages use Node ESM resolution anchored to the configuration directory; resolution uses a short-lived Node subprocess.

```json
{
  "plugins": {
    "worker": [
      { "id": "example-agent", "kind": "agent", "module": "./agent.mjs" }
    ],
    "hub": [
      { "id": "example-channel", "kind": "channel", "module": "./channel.mjs" }
    ]
  },
  "agents": {
    "example": { "adapter": "example-agent", "isolation": "trusted-local" }
  },
  "channels": { "alerts": { "type": "example-channel" } },
  "routes": []
}
```

Each ESM module exports one default synchronous factory. The factory returns one plugin with a matching manifest. Minimal examples:

```js
// agent.mjs
export default function createPlugin() {
  return {
    manifest: {
      id: "example-agent",
      kind: "agent",
      apiVersion: 1,
      version: "1.0.0",
    },
    async execute(input, signal) {
      signal?.throwIfAborted();
      return {
        type: "completed",
        sessionId: input.externalSessionId ?? "example-session",
        output: "done",
      };
    },
  };
}
```

```js
// channel.mjs
export default function createPlugin() {
  return {
    manifest: {
      id: "example-channel",
      kind: "channel",
      apiVersion: 1,
      version: "1.0.0",
    },
    createChannel({ id }) {
      return {
        id,
        async deliver(_input) {
          return { ok: true };
        },
      };
    },
  };
}
```

The Agent and Channel examples are illustrative; use unique session IDs and implement actual delivery for a real integration. A Source can be declared and registered in the Hub with an `ingest` method, but there is no generic active Source lifecycle or configured ingress binding yet. Do not treat a successful plugin load as validation of untrusted code.

For an end-to-end local setup, see the [v0.3 Quick Start](quickstart-v0.3.md). External plugin top-level code executes as trusted local code; it is not sandboxed.
