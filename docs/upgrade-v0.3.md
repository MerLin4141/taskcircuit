# Upgrading to TaskCircuit v0.3

Stop the runtime and back up the complete TaskCircuit home before upgrading. Existing v0.2 configuration remains valid: plugins are additive, and declarative `apply` is optional. Existing Roots keep their pinned automation versions and remain valid. Schema remains 10; v0.3 introduces no database migration.

Install the new code and dependencies, build it, then restart the Hub and Worker with your existing trusted configuration. For optional rules, see [declarative automations](declarative-automation.md); for trusted external modules, see [plugin authoring](plugin-authoring.md). External plugins run with local user permissions and are not sandboxed. Loopback does not provide authentication.

For upgrades from v0.1.2, first follow the one-way storage transition and backup precautions in the [v0.2 upgrade guide](upgrade-v0.2.md).
