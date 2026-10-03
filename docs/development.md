# CLI development

This repository is the CLI and release entry point for Apteva. The server, agent runtime, dashboard, apps, and integrations live in separate repositories; links are in the [main README](../README.md).

## Repository layout

```text
main.go                  Small executable entry point
internal/cli/            CLI implementation and Go tests
cli.js                   npm command wrapper
install.js               Native release installer
package.json             npm package and CLI version source
version.json             Public platform update manifest
deploy/                  Docker build definitions
docs/                    Development, deployment, and app testing
scripts/                 Version maintenance
.github/workflows/       CLI checks and platform releases
```

The root entry point preserves `go build .`, `go run .`, and source installation of `github.com/apteva/apteva`. It passes `main.Version` to the internal CLI, so existing release flags such as `-X main.Version=0.80.0` still work.

## Build and test

Use the Go version required by `go.mod` or a newer compatible version. Run these commands from this repository:

```bash
go build -o apteva .
go test ./...
./apteva --help
```

Tests live alongside the implementation under `internal/cli/`. Use `go test ./...` to include them; `go test .` only selects the root entry point.

To test version injection:

```bash
go build -ldflags "-X main.Version=0.80.0" -o apteva .
./apteva version
```

A CLI-only source build needs companion `apteva-server` and `apteva-core` binaries to start a local workspace. Put them beside the CLI or set `APTEVA_SERVER_BIN` and `APTEVA_CORE_BIN`. The npm installer downloads the release binaries together.

To connect to an existing server:

```bash
./apteva --no-spawn --server localhost:5280
```

`TestStartupFlow` is opt-in with `RUN_STARTUP_TEST=1`; it starts real server and core processes. Normal unit tests do not require a running platform. See [app scenarios](testing-scenarios.md) and [multi-agent topology](test-topology.md) for the CLI's app test runner.

## Releases and compatibility

The release workflow checks out the companion repositories as siblings, builds the dashboard and integration assets before embedding them in the server, and packages the native binaries. Build commands still target the root CLI package.

Keep `package.json`, `cli.js`, and `install.js` together at the repository root. The npm installer reads that package version and retains its current binary lookup paths.

Keep `version.json` at the repository root. Installed CLIs and servers fetch `https://raw.githubusercontent.com/apteva/apteva/main/version.json`; moving it would break update discovery for existing installations. Preserve release archive and binary names as well.

Docker builds use `deploy/Dockerfile.server`; the [deployment guide](deployment.md) describes its sibling checkout context.
