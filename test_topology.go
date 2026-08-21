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
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	Node      string
	ID        string
	ProjectID string
	Server    *testServer
	Instance  *instanceResp
}

type topologyNodeRuntime struct {
	Setup          ScenarioNodeSetup
	Server         *testServer
	DefaultProject string
	Projects       map[string]string
	Install        *installResp
	Sidecar        *localSidecar
	Proxy          *topologyPublicProxy
	Relays         map[string]*scopedAppMCPRelay
	Companions     map[string]*topologyAppRuntime
	Provisioned    bool
	Provision      *topologyProvisionRuntime
}

type topologyAppRuntime struct {
	Name    string
	Install *installResp
	Sidecar *localSidecar
}

type topologyProvisionRuntime struct {
	Source  *topologyAppRuntime
	Cleanup *ScenarioProvisionCleanup
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

func mergedTestEnvironment() []string {
	env := append([]string(nil), os.Environ()...)
	for key, value := range loadTestEnvFile() {
		if os.Getenv(key) == "" {
			env = append(env, key+"="+value)
		}
	}
	return env
}

func cloneProvisionCleanup(cleanup *ScenarioProvisionCleanup, result map[string]any) *ScenarioProvisionCleanup {
	if cleanup == nil {
		return nil
	}
	replace := func(value string) string {
		for key, replacement := range result {
			value = strings.ReplaceAll(value, "${RESULT."+key+"}", fmt.Sprint(replacement))
		}
		return value
	}
	args, _ := replaceStringValues(cleanup.Args, replace).(map[string]any)
	return &ScenarioProvisionCleanup{Tool: replace(cleanup.Tool), Args: args}
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

func spawnTopologySidecar(binPath, appDir string, installID int64, projectID string, config, extraEnv map[string]string, gatewayURL string) (*localSidecar, error) {
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
		"APTEVA_OUTBOUND_TOKEN="+fmt.Sprintf("dev-%d", installID),
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
	if len(s.Setup.Fixtures) > 0 || len(s.Setup.FakeMCPs) > 0 || len(s.Setup.SeedMCPCalls) > 0 || s.Setup.InitialWake != nil {
		res.Error = "setup.topology does not support fixtures, fake MCP servers, seed MCP calls, or initial_wake"
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
		}
		// Provisioner cleanup must run while its companion sidecar and source
		// server are still alive. Agents are already stopped above.
		for _, node := range runtime.Nodes {
			if node.Provision == nil || node.Provision.Cleanup == nil || node.Provision.Source == nil {
				continue
			}
			_, _ = callPeerMCPResult(node.Provision.Source.Sidecar.URL,
				node.Provision.Cleanup.Tool, node.Provision.Cleanup.Args, nil)
		}
		for _, node := range runtime.Nodes {
			if !node.Provisioned {
				for _, companion := range node.Companions {
					if companion.Sidecar != nil {
						companion.Sidecar.Stop()
					}
					if companion.Install != nil && node.Server != nil {
						uninstallApp(node.Server, companion.Install.InstallID)
					}
				}
				if node.Sidecar != nil {
					node.Sidecar.Stop()
				}
				if node.Install != nil && node.Server != nil {
					uninstallApp(node.Server, node.Install.InstallID)
				}
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

	primaryCount := 0
	bootstrapIndex := -1
	for i, setup := range s.Setup.Topology.Nodes {
		if setup.Primary {
			primaryCount++
		}
		if bootstrapIndex < 0 && setup.Provision == nil {
			bootstrapIndex = i
		}
	}
	if primaryCount > 1 {
		res.Error = "setup.topology may declare only one primary node"
		return res
	}
	if bootstrapIndex < 0 {
		res.Error = "setup.topology needs at least one directly bootstrapped node"
		return res
	}

	// Allocate every server and public URL before expanding reciprocal config.
	for i, setup := range s.Setup.Topology.Nodes {
		setup.ID = topologyID(setup.ID)
		if _, exists := runtime.Nodes[setup.ID]; exists {
			res.Error = fmt.Sprintf("duplicate topology node %q", setup.ID)
			return res
		}
		var nodeServer *testServer
		if setup.Provision == nil && i == bootstrapIndex {
			nodeServer = primaryServer
		} else if setup.Provision == nil {
			secondaryOpts := opts
			secondaryOpts.serverAddr = ""
			secondaryOpts.serverAPIKey = ""
			secondaryOpts.projectID = ""
			nodeServer, err = bootstrapServer(secondaryOpts)
			if err != nil {
				res.Error = fmt.Sprintf("bootstrap node %s: %v", setup.ID, err)
				return res
			}
			secondaryServers = append(secondaryServers, nodeServer)
		}
		node := &topologyNodeRuntime{
			Setup: setup, Server: nodeServer,
			Projects: map[string]string{}, Proxy: newTopologyPublicProxy(appName),
			Relays: map[string]*scopedAppMCPRelay{}, Companions: map[string]*topologyAppRuntime{},
		}
		if nodeServer != nil {
			node.DefaultProject = nodeServer.projectID
			node.Projects["default"] = node.DefaultProject
		}
		runtime.Nodes[setup.ID] = node
		if setup.Primary || (primaryCount == 0 && i == bootstrapIndex) {
			runtime.Primary = node
		}
	}

	values := topologyValues(runtime.Nodes, appName)
	expandScenarioRuntime(&s, values)

	// Create any additional projects requested by responder agents.
	for _, node := range runtime.Nodes {
		if node.Server == nil {
			continue
		}
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

	// Install and start one isolated app-under-test sidecar per directly
	// bootstrapped node. Provisioned nodes receive that app from their
	// provisioner and are adopted below.
	for _, setup := range s.Setup.Topology.Nodes {
		node := runtime.Nodes[topologyID(setup.ID)]
		node.Setup = setup
		if node.Server == nil {
			continue
		}
		config := mergedTopologyConfig(s.Setup.App.Config, node.Setup.Config, values)
		installProject := node.DefaultProject
		if node.Setup.Global {
			installProject = ""
		}
		node.Install, err = installApp(node.Server, manifestYAML, absAppDir, installProject, config)
		if err != nil {
			res.Error = fmt.Sprintf("install app on %s: %v", node.Setup.ID, err)
			return res
		}
		node.Sidecar, err = spawnTopologySidecar(binPath, absAppDir, node.Install.InstallID, installProject, config, s.Setup.App.Env, "http://"+node.Server.addr)
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

	// Companion apps are installed after the app under test so bindings can
	// refer to it by manifest name (for example a control plane bound to A2A).
	for _, setup := range s.Setup.Topology.Nodes {
		node := runtime.Nodes[topologyID(setup.ID)]
		if node.Server == nil {
			continue
		}
		installed := map[string]*topologyAppRuntime{
			appName: {Name: appName, Install: node.Install, Sidecar: node.Sidecar},
			"app":   {Name: appName, Install: node.Install, Sidecar: node.Sidecar},
		}
		for _, spec := range setup.Apps {
			companionDir := spec.Path
			if !filepath.IsAbs(companionDir) {
				companionDir = filepath.Join(absAppDir, companionDir)
			}
			companionDir, err = filepath.Abs(companionDir)
			if err != nil {
				res.Error = fmt.Sprintf("resolve companion app %s: %v", spec.ID, err)
				return res
			}
			companionManifest, readErr := os.ReadFile(filepath.Join(companionDir, "apteva.yaml"))
			if readErr != nil {
				res.Error = fmt.Sprintf("read companion app %s: %v", spec.ID, readErr)
				return res
			}
			companionName := manifestNameFromYAML(companionManifest)
			alias := strings.TrimSpace(spec.ID)
			if alias == "" {
				alias = companionName
			}
			bindings := map[string]any{}
			for role, target := range spec.Bindings {
				bound := installed[strings.TrimSpace(target)]
				if bound == nil || bound.Install == nil {
					res.Error = fmt.Sprintf("companion %s binding %s refers to unknown app %q", alias, role, target)
					return res
				}
				bindings[role] = bound.Install.InstallID
			}
			projectID := node.DefaultProject
			if spec.Global {
				projectID = ""
			}
			config := mergedTopologyConfig(nil, spec.Config, values)
			install, installErr := installAppWithBindings(node.Server, companionManifest, companionDir, projectID, config, bindings)
			if installErr != nil {
				res.Error = fmt.Sprintf("install companion %s on %s: %v", alias, node.Setup.ID, installErr)
				return res
			}
			bin := filepath.Join(buildDir, node.Setup.ID+"-"+alias)
			output, buildErr := buildLocalSidecarBinary(companionDir, bin, false)
			if buildErr != nil && strings.Contains(string(output), "not one of the workspace modules listed in go.work") {
				output, buildErr = buildLocalSidecarBinary(companionDir, bin, true)
			}
			if buildErr != nil {
				res.Error = fmt.Sprintf("build companion %s: %s", alias, output)
				return res
			}
			sidecar, spawnErr := spawnTopologySidecar(bin, companionDir, install.InstallID, projectID, config, spec.Env, "http://"+node.Server.addr)
			if spawnErr != nil {
				res.Error = fmt.Sprintf("start companion %s on %s: %v", alias, node.Setup.ID, spawnErr)
				return res
			}
			if mountErr := setSidecarURL(node.Server, install.InstallID, sidecar.URL); mountErr != nil {
				res.Error = fmt.Sprintf("mount companion %s on %s: %v", alias, node.Setup.ID, mountErr)
				return res
			}
			runtimeApp := &topologyAppRuntime{Name: companionName, Install: install, Sidecar: sidecar}
			node.Companions[alias] = runtimeApp
			installed[alias] = runtimeApp
			installed[companionName] = runtimeApp
		}
	}

	// Provision and adopt tool-created nodes after all source-node companion
	// apps are live. Result fields default to base_url/api_key/tenant_id.
	for _, setup := range s.Setup.Topology.Nodes {
		if setup.Provision == nil {
			continue
		}
		node := runtime.Nodes[topologyID(setup.ID)]
		provision := setup.Provision
		source := runtime.Nodes[topologyID(provision.From)]
		if source == nil || source.Server == nil {
			res.Error = fmt.Sprintf("provision node %s has unknown source %q", setup.ID, provision.From)
			return res
		}
		provisioner := source.Companions[provision.App]
		if provisioner == nil {
			res.Error = fmt.Sprintf("provision node %s has unknown source app %q", setup.ID, provision.App)
			return res
		}
		result, callErr := callPeerMCPResult(provisioner.Sidecar.URL, provision.Tool, provision.Args, nil)
		if callErr != nil {
			res.Error = fmt.Sprintf("provision node %s via %s.%s: %v", setup.ID, provision.App, provision.Tool, callErr)
			return res
		}
		// Register cleanup as soon as provisioning succeeds so a later
		// adoption/configuration failure cannot leak the created server.
		node.Provision = &topologyProvisionRuntime{
			Source: provisioner, Cleanup: cloneProvisionCleanup(provision.Cleanup, result),
		}
		baseField, keyField := provision.BaseURLField, provision.APIKeyField
		if baseField == "" {
			baseField = "base_url"
		}
		if keyField == "" {
			keyField = "api_key"
		}
		baseURL, _ := result[baseField].(string)
		apiKey, _ := result[keyField].(string)
		parsedURL, parseErr := url.Parse(strings.TrimSpace(baseURL))
		if parseErr != nil || parsedURL.Host == "" || strings.TrimSpace(apiKey) == "" {
			res.Error = fmt.Sprintf("provision node %s returned invalid %s/%s fields", setup.ID, baseField, keyField)
			return res
		}
		if connectHost := strings.TrimSpace(provision.ConnectHost); connectHost != "" {
			if port := parsedURL.Port(); port != "" {
				parsedURL.Host = net.JoinHostPort(connectHost, port)
			} else {
				parsedURL.Host = connectHost
			}
		}
		connectBaseURL := strings.TrimRight(parsedURL.String(), "/")
		node.Server = &testServer{addr: parsedURL.Host, apiKey: apiKey}
		projectID, projectErr := fetchDefaultProjectID(node.Server)
		if projectErr != nil {
			res.Error = fmt.Sprintf("read provisioned node %s project: %v", setup.ID, projectErr)
			return res
		}
		node.Server.projectID = projectID
		node.DefaultProject = projectID
		node.Projects["default"] = projectID
		if providerErr := configureSpawnedTestProvider(node.Server, opts.provider, mergedTestEnvironment()); providerErr != nil {
			res.Error = fmt.Sprintf("configure provisioned node %s provider: %v", setup.ID, providerErr)
			return res
		}
		install, findErr := findExistingAppInstall(node.Server, appName)
		if findErr != nil {
			res.Error = fmt.Sprintf("find %s on provisioned node %s: %v", appName, setup.ID, findErr)
			return res
		}
		node.Install = install
		node.Sidecar = &localSidecar{}
		node.Proxy.SetTarget(connectBaseURL + "/api/apps/" + appName)
		node.Provisioned = true
	}

	values = topologyValues(runtime.Nodes, appName)
	expandScenarioRuntime(&s, values)

	// Provisioned nodes only learn their project ids after adoption.
	for _, node := range runtime.Nodes {
		if !node.Provisioned {
			continue
		}
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
		}
	}

	createAgent := func(node *topologyNodeRuntime, id, name, projectID, directive, mode string) (*topologyAgentRuntime, error) {
		if mode == "" {
			mode = "autonomous"
		}
		if name == "" {
			name = id
		}
		var mcp []map[string]any
		if !node.Provisioned {
			relay, err := topologyRelay(node, appName, projectID, s.Setup.App.Spawnable)
			if err != nil {
				return nil, err
			}
			mcp = []map[string]any{scenarioAppMCPConfig(appName, relay.URL, s.Setup.App.Spawnable)}
		}
		// Topology sidecars are mounted manually and supplied as an explicit,
		// project-scoped MCP relay. They are not install-picker inventory rows,
		// so binding the install ID would make agent creation reject an otherwise
		// valid relay before Core starts.
		instance, err := tcCreateInstance(node.Server, projectID, name, directive, mode, opts.provider, mcp, nil, false, nil)
		if err != nil {
			return nil, err
		}
		if !node.Provisioned {
			if err := writeInstanceDiskConfig(node.Server, instance.ID, directive, mode, mcp, false, nil); err != nil {
				tcDeleteInstance(node.Server, instance.ID)
				return nil, err
			}
		}
		agent := &topologyAgentRuntime{Node: node.Setup.ID, ID: id, ProjectID: projectID, Server: node.Server, Instance: instance}
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
	values["PRIMARY_AGENT_ID"] = strconv.FormatInt(runtime.PrimaryAgent.Instance.ID, 10)
	expandScenarioRuntime(&s, values)
	if !runtime.Primary.Provisioned {
		if err := writeInstanceDiskConfig(runtime.Primary.Server, runtime.PrimaryAgent.Instance.ID, s.Directive, mode,
			[]map[string]any{scenarioAppMCPConfig(appName, runtime.Primary.Relays[runtime.Primary.DefaultProject].URL, s.Setup.App.Spawnable)}, false, nil); err != nil {
			res.Error = fmt.Sprintf("write primary agent config: %v", err)
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
					acceptTelemetry(&res, event, seen)
				}
			}
			if probeTopologyAsserts(runtime, assertions, &res) {
				stopReason = "asserts passed"
			} else if scenarioIterationLimitReached(&res, maxIterations) {
				stopReason = fmt.Sprintf("max_iterations (%d) reached", maxIterations)
			}
		case <-ctx.Done():
			stopReason = "timeout"
		}
	}

	res.ElapsedMs = time.Since(started).Milliseconds()
	res.Asserts = runTopologyAsserts(runtime, assertions, &res)
	res.BudgetOK = checkBudget(s.Budget, res.Tokens, res.CostUSD)
	res.OK = res.Error == "" && res.BudgetOK
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
