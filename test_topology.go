package main

// Generic topology support for `apteva test`.
//
// Legacy scenarios keep the original one-server/one-agent path. A scenario
// that declares setup.topology.nodes gets real isolated Apteva servers, one
// app install per node, and any number of responder agents. This is useful for
// federated apps without putting app-specific behavior in the runner.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type topologyPublicProxy struct {
	URL     string
	server  *httptest.Server
	appName string
	mu      sync.RWMutex
	target  string
}

func newTopologyPublicProxy(appName string) *topologyPublicProxy {
	p := &topologyPublicProxy{appName: appName}
	p.server = httptest.NewServer(http.HandlerFunc(p.serveHTTP))
	p.URL = p.server.URL
	return p
}

func (p *topologyPublicProxy) SetTarget(target string) {
	p.mu.Lock()
	p.target = strings.TrimRight(target, "/")
	p.mu.Unlock()
}

func (p *topologyPublicProxy) Close() { p.server.Close() }

func (p *topologyPublicProxy) serveHTTP(w http.ResponseWriter, incoming *http.Request) {
	p.mu.RLock()
	target := p.target
	p.mu.RUnlock()
	if target == "" {
		http.Error(w, "node app is starting", http.StatusServiceUnavailable)
		return
	}
	prefix := "/api/apps/" + p.appName
	path := strings.TrimPrefix(incoming.URL.Path, prefix)
	if path == incoming.URL.Path {
		http.NotFound(w, incoming)
		return
	}
	if path == "" {
		path = "/"
	}
	req, err := http.NewRequestWithContext(incoming.Context(), incoming.Method, target+path, incoming.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	req.URL.RawQuery = incoming.URL.RawQuery
	req.Header = incoming.Header.Clone()
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer res.Body.Close()
	for key, values := range res.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, res.Body)
}

type topologyAgentRuntime struct {
	Directive string
	Mode      string
	Node      string
	ID        string
	ProjectID string
	Server    *testServer
	Instance  *instanceResp
}

type topologyNodeRuntime struct {
	Dependencies   []depBundle
	DependencyMCP  []map[string]any
	Setup          ScenarioNodeSetup
	Server         *testServer
	DefaultProject string
	Projects       map[string]string
	Install        *installResp
	Sidecar        *localSidecar
	Proxy          *topologyPublicProxy
	Relays         map[string]*scopedAppMCPRelay
}

type topologyRuntime struct {
	Nodes        map[string]*topologyNodeRuntime
	Primary      *topologyNodeRuntime
	Agents       []*topologyAgentRuntime
	PrimaryAgent *topologyAgentRuntime
}

func topologyID(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "node"
	}
	return raw
}

func topologyProject(node *topologyNodeRuntime, label string) (string, bool) {
	label = strings.TrimSpace(label)
	if label == "" || label == "default" {
		return node.DefaultProject, true
	}
	projectID, ok := node.Projects[label]
	return projectID, ok
}

func topologyValues(nodes map[string]*topologyNodeRuntime, appName string) map[string]string {
	values := map[string]string{}
	for id, node := range nodes {
		values["NODE_"+id+"_URL"] = node.Proxy.URL
		values["NODE_"+id+"_APP_URL"] = node.Proxy.URL + "/api/apps/" + appName
		values["NODE_"+id+"_PROJECT_ID"] = node.DefaultProject
	}
	return values
}

func mergedTopologyConfig(base, override map[string]string, values map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range base {
		out[key] = value
	}
	for key, value := range override {
		out[key] = value
	}
	for key, value := range out {
		for name, replacement := range values {
			value = strings.ReplaceAll(value, "${"+name+"}", replacement)
		}
		out[key] = value
	}
	return out
}

func spawnTopologySidecar(binPath, appDir string, installID int64, projectID string, config, extraEnv map[string]string, gatewayURL, outboundToken string) (*localSidecar, error) {
	port, err := pickFreePort()
	if err != nil {
		return nil, err
	}
	cfgJSON, _ := json.Marshal(config)
	dataDir, err := os.MkdirTemp("", "apteva-topology-sidecar-*")
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(binPath)
	cmd.Dir = appDir
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("APTEVA_APP_PORT=%d", port),
		"APTEVA_APP_TOKEN=",
		"APTEVA_OUTBOUND_TOKEN="+outboundToken,
		"APTEVA_INSTALL_ID="+fmt.Sprintf("%d", installID),
		"APTEVA_PROJECT_ID="+projectID,
		"APTEVA_APP_CONFIG="+string(cfgJSON),
		"APTEVA_GATEWAY_URL="+gatewayURL,
		"DB_PATH="+filepath.Join(dataDir, "app.db"),
	)
	for key, value := range extraEnv {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	logFile, _ := os.Create(filepath.Join(dataDir, "sidecar.log"))
	cmd.Stdout, cmd.Stderr = logFile, logFile
	setProcGroup(cmd)
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		_ = os.RemoveAll(dataDir)
		return nil, err
	}
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	if err := waitHealthy(url+"/health", 10*time.Second); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		_ = logFile.Close()
		_ = os.RemoveAll(dataDir)
		return nil, err
	}
	return &localSidecar{URL: url, cmd: cmd, dataDir: dataDir}, nil
}

func topologyRelay(node *topologyNodeRuntime, appName, projectID string, spawnable bool) (*scopedAppMCPRelay, error) {
	if relay := node.Relays[projectID]; relay != nil {
		return relay, nil
	}
	relay, err := startScopedAppMCPRelayForProject(node.Server, appName, node.Install.InstallID, projectID)
	if err != nil {
		return nil, err
	}
	node.Relays[projectID] = relay
	return relay, nil
}

func runTopologyScenario(primaryServer *testServer, s Scenario, opts testOpts) (res ScenarioResult) {
	res = ScenarioResult{Name: s.Name, BudgetOK: true}
	started := time.Now()
	defer func() { res.ElapsedMs = time.Since(started).Milliseconds() }()

	if s.Setup.App.ReuseExisting {
		res.Error = "setup.topology does not support reuse_existing"
		return res
	}
	if len(s.Setup.Fixtures) > 0 || len(s.Setup.FakeMCPs) > 0 || len(s.Setup.SeedMCPCalls) > 0 || len(s.Setup.CleanupMCPCalls) > 0 || s.Setup.InitialWake != nil || s.Setup.Thread != nil {
		res.Error = "setup.topology does not support fixtures, fake MCP servers, seed/cleanup MCP calls, initial_wake, thread config"
		return res
	}
	if interaction := strings.TrimSpace(s.Setup.Interaction); interaction != "" && interaction != "autonomous" {
		res.Error = "setup.topology currently supports autonomous interaction only"
		return res
	}
	if len(s.Setup.Topology.Nodes) > 8 {
		res.Error = "setup.topology supports at most 8 nodes"
		return res
	}
	appDir := opts.appDir
	if s.Setup.App.Path != "" {
		appDir = s.Setup.App.Path
	}
	absAppDir, err := filepath.Abs(appDir)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	manifestYAML, err := os.ReadFile(filepath.Join(absAppDir, "apteva.yaml"))
	if err != nil {
		res.Error = fmt.Sprintf("read app manifest: %v", err)
		return res
	}
	appName := manifestNameFromYAML(manifestYAML)
	for _, node := range s.Setup.Topology.Nodes {
		if err := validateTopologyDependencies(node.Global, manifestYAML, s.Setup.App.Bindings); err != nil {
			res.Error = err.Error()
			return res
		}
	}

	buildDir, err := os.MkdirTemp("", "apteva-topology-build-*")
	if err != nil {
		res.Error = err.Error()
		return res
	}
	defer os.RemoveAll(buildDir)
	binPath := filepath.Join(buildDir, "app")
	buildOutput, buildErr := buildLocalSidecarBinary(absAppDir, binPath, false)
	if buildErr != nil && strings.Contains(string(buildOutput), "not one of the workspace modules listed in go.work") {
		buildOutput, buildErr = buildLocalSidecarBinary(absAppDir, binPath, true)
	}
	if buildErr != nil {
		res.Error = fmt.Sprintf("build app: %s", buildOutput)
		return res
	}

	runtime := &topologyRuntime{Nodes: map[string]*topologyNodeRuntime{}}
	var secondaryServers []*testServer
	var createdPrimaryProjects []string
	cleanup := func() {
		for i := len(runtime.Agents) - 1; i >= 0; i-- {
			agent := runtime.Agents[i]
			_ = stopInstanceAPI(agent.Server, agent.Instance.ID)
			if os.Getenv("APTEVA_TEST_KEEP") == "" {
				tcDeleteInstance(agent.Server, agent.Instance.ID)
			}
		}
		for _, node := range runtime.Nodes {
			for _, relay := range node.Relays {
				relay.Close()
			}
			if node.Sidecar != nil {
				node.Sidecar.Stop()
			}
			if node.Install != nil {
				uninstallApp(node.Server, node.Install.InstallID)
			}
			for i := len(node.Dependencies) - 1; i >= 0; i-- {
				dep := node.Dependencies[i]
				dep.sidecar.Stop()
				uninstallApp(node.Server, dep.installID)
			}
			if node.Proxy != nil {
				node.Proxy.Close()
			}
		}
		for _, projectID := range createdPrimaryProjects {
			deleteTestProject(primaryServer, projectID)
		}
		for i := len(secondaryServers) - 1; i >= 0; i-- {
			secondaryServers[i].Stop()
		}
	}
	defer cleanup()

	primaryIndex := 0
	primaryCount := 0
	for i, setup := range s.Setup.Topology.Nodes {
		if setup.Primary {
			primaryIndex, primaryCount = i, primaryCount+1
		}
	}
	if primaryCount > 1 {
		res.Error = "setup.topology may declare only one primary node"
		return res
	}

	// Allocate every server and public URL before expanding reciprocal config.
	for i, setup := range s.Setup.Topology.Nodes {
		setup.ID = topologyID(setup.ID)
		if _, exists := runtime.Nodes[setup.ID]; exists {
			res.Error = fmt.Sprintf("duplicate topology node %q", setup.ID)
			return res
		}
		nodeServer := primaryServer
		if i != primaryIndex {
			secondaryOpts := opts
			secondaryOpts.serverAddr = ""
			secondaryOpts.serverAPIKey = ""
			secondaryOpts.projectID = ""
			nodeServer, err = bootstrapServer(&secondaryOpts)
			if err != nil {
				res.Error = fmt.Sprintf("bootstrap node %s: %v", setup.ID, err)
				return res
			}
			secondaryServers = append(secondaryServers, nodeServer)
		}
		node := &topologyNodeRuntime{
			Setup: setup, Server: nodeServer, DefaultProject: nodeServer.projectID,
			Projects: map[string]string{}, Proxy: newTopologyPublicProxy(appName),
			Relays: map[string]*scopedAppMCPRelay{},
		}
		node.Projects["default"] = node.DefaultProject
		runtime.Nodes[setup.ID] = node
		if i == primaryIndex {
			runtime.Primary = node
		}
	}

	values := topologyValues(runtime.Nodes, appName)
	expandScenarioRuntime(&s, values)

	// Create any additional projects requested by responder agents.
	for _, node := range runtime.Nodes {
		for _, agent := range node.Setup.Agents {
			label := strings.TrimSpace(agent.Project)
			if label == "" || label == "default" {
				continue
			}
			if _, exists := node.Projects[label]; exists {
				continue
			}
			if !node.Setup.Global {
				res.Error = fmt.Sprintf("node %s needs global: true for agent project %q", node.Setup.ID, label)
				return res
			}
			projectID, createErr := createTestProject(node.Server)
			if createErr != nil {
				res.Error = fmt.Sprintf("create project %s.%s: %v", node.Setup.ID, label, createErr)
				return res
			}
			node.Projects[label] = projectID
			if node.Server == primaryServer {
				createdPrimaryProjects = append(createdPrimaryProjects, projectID)
			}
		}
	}

	// Install and start one isolated app sidecar per node.
	for _, setup := range s.Setup.Topology.Nodes {
		node := runtime.Nodes[topologyID(setup.ID)]
		node.Setup = setup
		config := mergedTopologyConfig(s.Setup.App.Config, node.Setup.Config, values)
		installProject := node.DefaultProject
		if node.Setup.Global {
			installProject = ""
		}
		var bindings map[string]any
		node.Dependencies, bindings, err = installDeps(node.Server, absAppDir, manifestYAML, s.Setup.App.Bindings)
		if err != nil {
			res.Error = fmt.Sprintf("install node %s dependencies: %v", node.Setup.ID, err)
			return res
		}
		for _, dep := range node.Dependencies {
			relay, e := startScopedAppMCPRelayForProject(node.Server, dep.name, dep.installID, node.DefaultProject)
			if e != nil {
				res.Error = e.Error()
				return res
			}
			node.Relays["dependency/"+dep.name] = relay
			node.DependencyMCP = append(node.DependencyMCP, scenarioAppMCPConfig(dep.name, relay.URL, false))
		}
		node.Install, err = installApp(node.Server, manifestYAML, absAppDir, installProject, config, bindings)
		if err != nil {
			res.Error = fmt.Sprintf("install app on %s: %v", node.Setup.ID, err)
			return res
		}
		node.Sidecar, err = spawnTopologySidecar(binPath, absAppDir, node.Install.InstallID, installProject, config, s.Setup.App.Env, "http://"+node.Server.addr, node.Install.OutboundToken)
		if err != nil {
			res.Error = fmt.Sprintf("start app on %s: %v", node.Setup.ID, err)
			return res
		}
		node.Proxy.SetTarget(node.Sidecar.URL)
		if err := setSidecarURL(node.Server, node.Install.InstallID, node.Sidecar.URL); err != nil {
			res.Error = fmt.Sprintf("mount app on %s: %v", node.Setup.ID, err)
			return res
		}
	}

	createAgent := func(node *topologyNodeRuntime, id, name, projectID, directive, mode string) (*topologyAgentRuntime, error) {
		if mode == "" {
			mode = "autonomous"
		}
		if name == "" {
			name = id
		}
		relay, err := topologyRelay(node, appName, projectID, s.Setup.App.Spawnable)
		if err != nil {
			return nil, err
		}
		mcp := topologyMCP(node, appName, relay.URL, s.Setup.App.Spawnable)
		// Bind the tested install so every agent receives its app skills; the
		// project-scoped relay preserves caller identity on MCP requests.
		instance, err := tcCreateInstance(node.Server, projectID, name, directive, mode, opts.provider, opts.model, mcp, []int64{node.Install.InstallID}, false, nil)
		if err != nil {
			return nil, err
		}
		if err := writeInstanceDiskConfig(node.Server, instance.ID, directive, mode, opts.provider, opts.model, mcp, false, nil); err != nil {
			tcDeleteInstance(node.Server, instance.ID)
			return nil, err
		}
		agent := &topologyAgentRuntime{Directive: directive, Mode: mode, Node: node.Setup.ID, ID: id, ProjectID: projectID, Server: node.Server, Instance: instance}
		runtime.Agents = append(runtime.Agents, agent)
		return agent, nil
	}

	agentIDs := map[string]bool{"primary": true}
	for _, setup := range s.Setup.Topology.Nodes {
		node := runtime.Nodes[topologyID(setup.ID)]
		for _, spec := range node.Setup.Agents {
			spec.ID = strings.TrimSpace(spec.ID)
			if spec.ID == "" {
				spec.ID = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(spec.Name), " ", "-"))
			}
			if spec.ID == "" || agentIDs[spec.ID] {
				res.Error = fmt.Sprintf("duplicate or empty topology agent id %q", spec.ID)
				return res
			}
			agentIDs[spec.ID] = true
			projectID, ok := topologyProject(node, spec.Project)
			if !ok {
				res.Error = fmt.Sprintf("unknown project %s.%s", node.Setup.ID, spec.Project)
				return res
			}
			if _, err := createAgent(node, spec.ID, spec.Name, projectID, spec.Directive, spec.Mode); err != nil {
				res.Error = fmt.Sprintf("create agent %s: %v", spec.ID, err)
				return res
			}
		}
	}

	mode := s.Setup.Mode
	if mode == "" {
		mode = "autonomous"
	}
	runtime.PrimaryAgent, err = createAgent(runtime.Primary, "primary", s.Name, runtime.Primary.DefaultProject, s.Directive, mode)
	if err != nil {
		res.Error = fmt.Sprintf("create primary agent: %v", err)
		return res
	}
	for key, value := range topologyAgentValues(runtime.Agents, runtime.PrimaryAgent) {
		values[key] = value
	}
	expandScenarioRuntime(&s, values)
	for _, agent := range runtime.Agents {
		directive := agent.Directive
		for key, value := range values {
			directive = strings.ReplaceAll(directive, "${"+key+"}", value)
		}
		node := runtime.Nodes[agent.Node]
		mcp := topologyMCP(node, appName, node.Relays[agent.ProjectID].URL, s.Setup.App.Spawnable)
		if err := writeInstanceDiskConfig(agent.Server, agent.Instance.ID, directive, agent.Mode, opts.provider, opts.model, mcp, false, nil); err != nil {
			res.Error = fmt.Sprintf("write agent %s config: %v", agent.ID, err)
			return res
		}
	}

	// Responders must be listening before the primary begins discovery.
	for _, agent := range runtime.Agents {
		if agent == runtime.PrimaryAgent {
			continue
		}
		if err := startInstanceAPI(agent.Server, agent.Instance.ID); err != nil {
			res.Error = fmt.Sprintf("start agent %s: %v", agent.ID, err)
			return res
		}
		if err := waitInstanceRunning(agent.Server, agent.Instance.ID, 10*time.Second); err != nil {
			res.Error = err.Error()
			return res
		}
	}
	if err := startInstanceAPI(runtime.PrimaryAgent.Server, runtime.PrimaryAgent.Instance.ID); err != nil {
		res.Error = fmt.Sprintf("start primary agent: %v", err)
		return res
	}
	if err := waitInstanceRunning(runtime.PrimaryAgent.Server, runtime.PrimaryAgent.Instance.ID, 10*time.Second); err != nil {
		res.Error = err.Error()
		return res
	}

	timeout := opts.timeout
	if s.Timeout != "" {
		if parsed, parseErr := time.ParseDuration(s.Timeout); parseErr == nil {
			timeout = parsed
		}
	}
	maxIterations := s.MaxIterations
	if maxIterations == 0 {
		maxIterations = 20
	}
	parentCtx := opts.ctx
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	ctx, cancel := context.WithTimeout(parentCtx, timeout)
	defer cancel()
	assertions := scenarioAssertions(s)
	seen := map[string]struct{}{}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	stopReason := ""
	var stableSince time.Time
	var settleFor time.Duration
	if s.SettleFor != "" {
		parsed, err := time.ParseDuration(s.SettleFor)
		if err != nil || parsed < 0 {
			res.Error = "invalid settle_for"
			return res
		}
		settleFor = parsed
	}
	for stopReason == "" {
		select {
		case <-ticker.C:
			for _, agent := range runtime.Agents {
				events, fetchErr := fetchStoredTelemetry(agent.Server, agent.Instance.ID, started.Add(-time.Second))
				if fetchErr != nil {
					continue
				}
				for _, event := range events {
					event.Node, event.Agent = agent.Node, agent.ID
					if acceptTelemetry(&res, event, seen) && event.Type == "tool.call" {
						fmt.Fprintf(os.Stderr, "    · %s/%s %s\n", event.Node, event.Agent, stringMapValue(event.Data, "name"))
					}
				}
			}
			if probeTopologyAsserts(runtime, assertions, &res) {
				if stableSince.IsZero() {
					stableSince = time.Now()
				}
				if time.Since(stableSince) >= settleFor {
					stopReason = "asserts passed"
				}
			} else {
				stableSince = time.Time{}
			}
			if stopReason == "" && scenarioIterationLimitReached(&res, maxIterations) {
				stopReason = fmt.Sprintf("max_iterations (%d) reached", maxIterations)
			}
		case <-ctx.Done():
			stopReason = "timeout"
		}
	}

	res.ElapsedMs = time.Since(started).Milliseconds()
	res.Asserts = runTopologyAsserts(runtime, assertions, &res)
	res.BudgetOK = checkBudget(s.Budget, res.Tokens, res.CostUSD)
	res.OK = stopReason == "asserts passed" && res.Error == "" && res.BudgetOK
	for _, assertion := range res.Asserts {
		if !assertion.OK {
			res.OK = false
		}
	}
	if opts.verbose {
		fmt.Fprintf(os.Stderr, "  topology stop_reason: %s\n", stopReason)
	}
	return res
}

func topologyAssertionTarget(runtime *topologyRuntime, clause AssertClause) (*topologyNodeRuntime, string, bool) {
	node := runtime.Primary
	if clause.Node != "" {
		node = runtime.Nodes[clause.Node]
	}
	if node == nil {
		return nil, "", false
	}
	projectID, ok := topologyProject(node, clause.Project)
	return node, projectID, ok
}

func probeTopologyAsserts(runtime *topologyRuntime, clauses []AssertClause, result *ScenarioResult) bool {
	if len(clauses) == 0 {
		return false
	}
	terminal := 0
	for _, clause := range clauses {
		switch {
		case clause.HTTP != "":
			node, projectID, ok := topologyAssertionTarget(runtime, clause)
			if !ok {
				return false
			}
			serverCopy := *node.Server
			serverCopy.projectID = projectID
			terminal++
			if !assertHTTP(&serverCopy, node.Install.InstallID, node.Sidecar.URL, clause).OK {
				return false
			}
		case clause.ToolCalled != "":
			terminal++
			if !assertToolCalled(clause, result).OK {
				return false
			}
		case clause.ToolCalledWith != nil:
			terminal++
			if !assertToolCallMatch(clause.ToolCalledWith, false, result).OK {
				return false
			}
		case responsePattern(clause) != "":
			terminal++
			if !assertResponseMatches(clause, result).OK {
				return false
			}
		case responseNeedle(clause) != "":
			terminal++
			if !assertResponseContains(clause, result).OK {
				return false
			}
		case clause.IterationsAtMost > 0, clause.FinishedWithin != "", clause.ToolNotCalled != "", clause.ToolNotCalledWith != nil:
			continue
		}
	}
	return terminal > 0
}

func runTopologyAsserts(runtime *topologyRuntime, clauses []AssertClause, result *ScenarioResult) []AssertResult {
	out := make([]AssertResult, 0, len(clauses))
	for _, clause := range clauses {
		node, projectID, ok := topologyAssertionTarget(runtime, clause)
		if !ok {
			out = append(out, AssertResult{Clause: clause.HTTP, OK: false, Note: "unknown topology node or project"})
			continue
		}
		serverCopy := *node.Server
		serverCopy.projectID = projectID
		assertions := runAsserts(&serverCopy, node.Install.InstallID, node.Sidecar.URL, "", []AssertClause{clause}, result)
		out = append(out, assertions[0])
	}
	return out
}

// Generated IDs let role-binding scenarios refer to real instances without
// guessing insertion order or requiring extra platform administration tools.
func topologyAgentValues(agents []*topologyAgentRuntime, primary *topologyAgentRuntime) map[string]string {
	values := map[string]string{"PRIMARY_AGENT_ID": strconv.FormatInt(primary.Instance.ID, 10)}
	for _, agent := range agents {
		values["AGENT_"+agent.ID+"_ID"] = strconv.FormatInt(agent.Instance.ID, 10)
	}
	return values
}

func topologyMCP(node *topologyNodeRuntime, name, url string, spawnable bool) []map[string]any {
	out := []map[string]any{scenarioAppMCPConfig(name, url, spawnable)}
	return append(out, node.DependencyMCP...)
}

func validateTopologyDependencies(global bool, manifest []byte, bindings map[string]string) error {
	if !global {
		return nil
	}
	refs, err := parseRequiredAppRefs(manifest)
	if err != nil {
		return err
	}
	if len(bindings) > 0 {
		return fmt.Errorf("topology app dependencies require project-scoped nodes")
	}
	for _, ref := range refs {
		if !ref.Optional {
			return fmt.Errorf("topology app dependencies require project-scoped nodes")
		}
	}
	return nil
}
