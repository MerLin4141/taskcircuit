# Upgrade from TaskCircuit v0.3 to v0.4

1. Stop the old Hub and Worker. Back up the complete TaskCircuit home and keep a copy of your trusted configuration and rule files.
2. Install dependencies and build v0.4. Existing v0.3 configuration, local events, API 1 plugins and schema-1 rule files remain usable. Database Schema remains 10, with no new migration. Existing Roots retain their original Automation versions. Plan any rollback from the backup and the matching v0.3 binary.
3. Run `taskcircuit doctor --config <path>` to check your configuration. Hub and Worker accept the same flag. The precedence is `--config`, `TASKCIRCUIT_CONFIG`, a config in the current directory, and built-in defaults. Explicit files must exist. Relative external plugin paths use the selected file's directory.
4. If you use the Windows startup task, stop it before switching binaries. Reinstall with `taskcircuit runtime install --config <path>` to pin a project config. The new task uses that selection on later starts. An old task without a pin can still use the historical application-directory fallback. Use `taskcircuit runtime status` to confirm the pinned path.
5. Start Hub and Worker. For existing declarative rules, use `taskcircuit apply <file> --dry-run`. Identical rules report unchanged. Review the plan before applying any edits.

GitHub, Generic Webhook and Feishu are optional. When using them, set the referenced credentials in the Hub's launch environment, including the scheduled user's environment for managed Windows. Restart after rotation. Keep the management port local and forward only the intended integration path from your HTTPS proxy.

[Quick Start](quickstart-v0.4.md) · [GitHub Source](github-source.md) · [Generic Webhook](webhook-source.md) · [Feishu Channel](feishu-channel.md) · [v0.4 release notes](releases/v0.4.0.md)
