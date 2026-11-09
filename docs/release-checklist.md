# v0.2 Release Checklist

- [ ] Format, typecheck, full tests, build and npm audit passed on the release candidate.
- [ ] Node 24 Windows and Ubuntu CI passed; real Agent E2E is local/manual, not a CI credential requirement.
- [ ] Verify schema 10, future schema rejection, and no Migration 11.
- [ ] Back up a genuine v0.1.2 store, verify one-way cutover and legacy write quarantine, and test historic data preservation.
- [ ] Fresh isolated install, Mock autonomous loop and Root inspection passed.
- [ ] Phase 6 real Codex / Claude evidence and loop-limit limitations are current.
- [ ] Windows isolated runtime and restart-recovery evidence is current; actual reboot/logon limitation is stated.
- [ ] README, Chinese README, architecture, roadmap, quick start, upgrade guide and release notes match implementation.
- [ ] Secret, identity/path and runtime-data scans completed; LOCAL_ONLY file excluded from the explicit staging list.
- [ ] License, version, package metadata, remote URLs and release notes checked.
- [ ] Explicitly review staged file list and diff; obtain authorization before commit, tag, push or release.
