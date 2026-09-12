# Multi-agent Tier 3 scenarios

`apteva test` accepts `setup.topology.nodes` for autonomous scenarios with real
Core instances. Each node owns an isolated server and one installation of the
app under test. The first node is primary unless another declares `primary: true`.
The top-level directive runs as the `primary` agent on that node. Responders are
created from `agents` and started before the primary agent.

```yaml
setup:
  app:
    path: ../apps/mcp/processes
  topology:
    nodes:
      - id: main
        primary: true
        agents:
          - id: writer
            name: Writer
            directive: Wait for assigned workflow steps and complete them.
          - id: reviewer
            name: Reviewer
            directive: Wait for assigned approval steps and review them.
directive: |
  Bind the writer role to ${AGENT_writer_ID}, reviewer to ${AGENT_reviewer_ID},
  and coordinator to ${PRIMARY_AGENT_ID}; then start the workflow.
trajectory_assert:
  - tool_called_with:
      node: main
      agent: writer
      tool: processes_step_update
      success: true
```

Agent aliases must be unique across the scenario; `primary` is reserved.
`${AGENT_<alias>_ID}` and `${PRIMARY_AGENT_ID}` expand to generated instance IDs
in directives and assertions before agents start. `--provider` and `--model`
apply to every agent. The tested install is bound to every agent, including its
skills; MCP relays preserve the actual caller identity. Generated IDs are local
to their node's server; cross-server routing still needs the destination node.

Tool assertions accept `node`, `agent`, `success`, `result_contains`, and
`result_not_contains`; result text is a truncated telemetry preview. Use saved
application state for full outcomes. HTTP assertions can select `node` and
`project`. Aggregate iteration, token, and cost accounting includes all agents.
`settle_for` requires terminal assertions to remain satisfied before completion.
Agents, app sidecars, and disposable servers are stopped during cleanup.

Multiple nodes can use `${NODE_<id>_APP_URL}` in app config to reach each other's
loopback app proxies. A node can declare `global: true` and responders can select
additional project labels through `project` for project-isolation scenarios.
The Processes collaboration case needs only one node and three agents.

Topology currently supports autonomous interaction, up to eight nodes, and no
fixtures, fake MCP servers, seed/cleanup MCP calls, initial wake, thread setup,
reuse of existing app installations, or app integration bindings. Prefer a
disposable server (omit `--server`) for authenticated app callbacks. Fleet node
provisioning/adoption is outside this implementation.

Validated with the Processes five-step scenario using `openai-codex` and
`gpt-5.6-terra`: three real instances, parallel inputs, dependency join, agent
approval, and simulated publication. It passed saved-state and per-agent
trajectory verification in 24 iterations on 2026-09-12.
