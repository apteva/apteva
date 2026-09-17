# Multi-step app scenarios

`apteva test` owns the server/project, app processes, installed skills, agents,
telemetry, assertions and teardown. For client workflows requiring several HTTP
or SSE interactions, a scenario can provide `setup.driver`:

```yaml
name: chat-attachment
setup:
  app:
    path: .
    spawnable: true
    config:
      attachment_storage: "true"
    bindings:
      storage: app
  apps:
    - path: ../tickets
      spawnable: true
      bindings:
        storage: app
  agents: 1
  driver: [go, -C, .., test, -tags=scenario, -run, '^TestScenario_ImageStorageTicket$', -count=1, .]
directive: Answer requests in the originating conversation.
timeout: 9m
trajectory_assert:
  - tool_called: tickets_add_attachment
```

App paths retain the existing runner convention (relative to the invoking working
directory). The driver runs in the YAML file's directory. `setup.apps` installs
additional test peers without changing the app's production dependencies. Peers
can specify config, env, optional bindings and spawnability; shared dependencies
are installed once and all installs are torn down in reverse order. Global-only
manifests receive global installs. Use a disposable spawned server for isolation.
`reuse_existing` is not supported for additional peers.

The driver is an argv list, not shell text. Exit 0 means its client assertions
passed; nonzero exit or cancellation fails the scenario. Its successful exit
never replaces the runner's YAML assertions or budget checks. It must not skip
or report success without executing the intended workflow.

The driver receives:

- `APTEVA_TEST_SERVER_URL`, `APTEVA_TEST_SERVER_API_KEY`
- `APTEVA_TEST_PROJECT_ID`, `APTEVA_TEST_INSTALL_ID`
- `APTEVA_TEST_INSTALLS`: JSON object mapping app names to exact install IDs
- `APTEVA_TEST_AGENT_IDS`: JSON array of runner-owned agents (default one)

Use `setup.agents` for multi-agent client workflows. Do not create agents inside
the driver. The runner binds its apps, captures telemetry from every agent, and
cleans up agents when the driver completes or is interrupted. Treat its owner
credential as a secret. Captured driver output is available as `driver_output`
in JSON results; the runner redacts the supplied server key.

A driver runs alongside the normal scenario interaction. Normally omit
`interaction`/`prompt` so it controls client messages itself. Runner-owned agents
start idle and receive requests through the actual app path. Existing declarative
single-prompt scenarios remain supported without a driver.

## Native frontend checks

An optional `apteva.test.yaml` extends the built-in Go commands. Each entry is an
argv command run in the app directory:

```yaml
native:
  "1":
    - [bun, test, ./ui]
  "2":
    - [bun, x, --no-install, playwright, test, --config, frontend/playwright.config.ts]
```

Only tiers 1 and 2 are accepted. Unknown keys, empty commands, and unsupported
tiers are errors. All requested checks run even when another fails, and the final
exit code stays nonzero if any check failed. `--tier all` also runs Tier 3 after
native failures and includes both in the aggregate result.
