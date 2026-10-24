# Stable-host releases

The optional fifth release binary, `apteva-host`, owns ingress while versioned
management servers hand over the same installation database and running apps.
The public commands remain `apteva`, `apteva update`, `apteva update --dry-run`,
`apteva rollback`, and `apteva service ...`.

The server implementation, data guarantees, conversion procedure and opt-in
real-server test are documented in
[server/docs/blue-green-host.md](https://github.com/apteva/server/blob/main/docs/blue-green-host.md).

New service installations use the sibling host when present. Existing customized
services require a reviewed one-time conversion and restart; do not regenerate
their units/plists blindly. Container entrypoints retain existing behavior.
Compatible subsequent server updates queue requests during a single-writer
handoff. Long-running calls may defer an update, and schema migrations require
maintenance. This does not promise 100% uptime through host or machine failures.

Hosted update/rollback failures never silently fall back to a service restart or
restore an old database backup. CLI symlinks advance only after the host commits
the new serving version. Older release archives remain readable, but a release
without the standby protocol cannot be activated through the host. Hosted updates
retain version directories so they cannot prune the running host or rollback
binaries. The host itself upgrades on an explicit service restart.

`workspace-host-build.patch` contains the companion changes for the workspace
root build/release scripts and Dockerfiles (the root is not a Git repository).
They conditionally build/package the host when its source exists, preserving
builds of older sibling server checkouts. They leave container entrypoints as-is.
