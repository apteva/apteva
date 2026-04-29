package main

// `apteva test` — Tier 3 live-agent scenario runner.
//
// Spawns a clean apteva-server in a temp data dir, installs the local
// app from disk, runs every YAML scenario in the target directory:
// creates the agent with the directive, subscribes to telemetry SSE,
// waits for completion, runs the asserts, records token usage.
//
// Usage:
//   apteva test ./scenarios/                # whole directory
//   apteva test ./scenarios/01-create.yaml  # one scenario
//   apteva test ./scenarios/ --server addr  # use existing server (skips spawn)
//   apteva test ./scenarios/ --provider opencode-go
//   apteva test ./scenarios/ --max-budget-usd 0.50
//
// The scenario format is intentionally tiny so non-engineers can author:
//
//   name: create-contact
//   directive: |
//     Add Alice Cooper, alice@acme.com, to the CRM.
//   timeout: 90s
//   max_iterations: 8
//   assert:
//     - http: GET /api/apps/crm/contacts
//       expect_status: 200
//       expect_count_at: contacts
//       expect_count: 1
//   budget:
//     prompt_tokens: 8000
//     cost_usd: 0.10
//
// Exit code: 0 if every scenario passes (asserts + budget); 1 otherwise.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type testOpts struct {
	target       string
	serverAddr   string // empty = auto-spawn
	provider     string
	appDir       string
	timeout      time.Duration
	maxBudgetUSD float64
	verbose      bool
	jsonOutput   bool
}

type Scenario struct {
	Name          string         `yaml:"name"`
	Description   string         `yaml:"description"`
	Timeout       string         `yaml:"timeout"`        // duration string, default 90s
	MaxIterations int            `yaml:"max_iterations"` // default 10
	Setup         ScenarioSetup  `yaml:"setup"`
	Directive     string         `yaml:"directive"`
	Assert        []AssertClause `yaml:"assert"`
	Budget        Budget         `yaml:"budget"`

	// SourceDir — directory the YAML was read from. Used to resolve
	// relative paths in setup.fixtures.file. Set by readScenario, not
	// the YAML author.
	SourceDir string `yaml:"-"`
}

type ScenarioSetup struct {
	App      AppSetup          `yaml:"app"`
	Mode     string            `yaml:"mode"` // autonomous | cautious | learn
	Config   map[string]string `yaml:"config"`
	Fixtures []FixtureSpec     `yaml:"fixtures"` // pre-uploaded files / setup data
}

type AppSetup struct {
	Path   string            `yaml:"path"`   // local path to the app being tested
	Config map[string]string `yaml:"config"` // install-time config
}

// FixtureSpec — pre-loaded data that has to be in place before the
// agent runs. v0.1: upload a local file into a peer app via that
// app's MCP `files_upload` tool (or any tool with a similar shape).
// Path is relative to the scenario YAML file's dir.
type FixtureSpec struct {
	App    string            `yaml:"app"`    // app slug — must be the unit-under-test or a dep
	Tool   string            `yaml:"tool"`   // MCP tool name — e.g. files_upload
	File   string            `yaml:"file"`   // relative path to a binary fixture
	Args   map[string]any    `yaml:"args"`   // extra tool args (folder, content_type, …)
}

type AssertClause struct {
	HTTP            string         `yaml:"http"`              // "GET /path"
	ExpectStatus    int            `yaml:"expect_status"`     // default 200
	ExpectCountAt   string         `yaml:"expect_count_at"`   // JSON field name to count under
	ExpectCount     int            `yaml:"expect_count"`      // for the count_at clause
	ExpectFieldAt   string         `yaml:"expect_field_at"`   // dotted path
	ExpectFieldEq   any            `yaml:"expect_field_eq"`   // value to match
	ToolCalled      string         `yaml:"tool_called"`       // any of (a|b|c) — at least one
	FinishedWithin  string         `yaml:"finished_within"`   // duration
	IterationsAtMost int           `yaml:"iterations_at_most"`
}

type Budget struct {
	PromptTokens     int     `yaml:"prompt_tokens"`
	CompletionTokens int     `yaml:"completion_tokens"`
	TotalTokens      int     `yaml:"total_tokens"` // alias
	CostUSD          float64 `yaml:"cost_usd"`
}

type ScenarioResult struct {
	Name           string                  `json:"scenario"`
	OK             bool                    `json:"ok"`
	ElapsedMs      int64                   `json:"elapsed_ms"`
	Iterations     int                     `json:"iterations"`
	ToolCalls      []ToolCallResult        `json:"tool_calls"`
	Tokens         TokenSummary            `json:"tokens"`
	CostUSD        float64                 `json:"cost_usd"`
	Asserts        []AssertResult          `json:"asserts"`
	BudgetOK       bool                    `json:"budget_ok"`
	Error          string                  `json:"error,omitempty"`
}

type ToolCallResult struct {
	Name string `json:"name"`
	Ms   int64  `json:"ms"`
	OK   bool   `json:"ok"`
}

type TokenSummary struct {
	Prompt     int `json:"prompt"`
	Completion int `json:"completion"`
	Total      int `json:"total"`
}

type AssertResult struct {
	Clause string `json:"clause"`
	OK     bool   `json:"ok"`
	Got    any    `json:"got,omitempty"`
	Want   any    `json:"want,omitempty"`
	Note   string `json:"note,omitempty"`
}

func cmdTest(args []string) int {
	fs := flag.NewFlagSet("test", flag.ExitOnError)
	serverAddr := fs.String("server", "", "use an existing apteva-server at this address (default: spawn a clean one in a temp dir)")
	provider := fs.String("provider", "", "LLM provider name (e.g. opencode-go); default: whatever the spawned server picks up from env")
	appDir := fs.String("app-dir", ".", "path to the app under test (used when scenarios omit setup.app.path)")
	timeoutFlag := fs.Duration("timeout", 90*time.Second, "default per-scenario timeout")
	maxBudgetUSD := fs.Float64("max-budget-usd", 0, "abort when cumulative cost exceeds this (0 = unbounded)")
	verbose := fs.Bool("v", false, "verbose: stream telemetry events as they arrive")
	jsonOut := fs.Bool("json", false, "emit machine-readable results to stdout")
	fs.Parse(args)

	if fs.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: apteva test [flags] <scenarios-dir-or-file>")
		fs.Usage()
		return 2
	}
	target := fs.Arg(0)

	opts := testOpts{
		target:       target,
		serverAddr:   *serverAddr,
		provider:     *provider,
		appDir:       *appDir,
		timeout:      *timeoutFlag,
		maxBudgetUSD: *maxBudgetUSD,
		verbose:      *verbose,
		jsonOutput:   *jsonOut,
	}

	scenarios, err := loadScenarios(target)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load scenarios: %v\n", err)
		return 2
	}
	if len(scenarios) == 0 {
		fmt.Fprintln(os.Stderr, "no scenarios found")
		return 2
	}

	server, err := bootstrapServer(opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bootstrap: %v\n", err)
		return 1
	}
	defer server.Stop()

	cumulativeCost := 0.0
	results := []ScenarioResult{}
	allOK := true
	for _, s := range scenarios {
		fmt.Fprintf(os.Stderr, "▶ %s\n", s.Name)
		res := runScenario(server, s, opts)
		results = append(results, res)
		printSummary(os.Stderr, res, opts.verbose)
		cumulativeCost += res.CostUSD
		if !res.OK {
			allOK = false
		}
		if opts.maxBudgetUSD > 0 && cumulativeCost > opts.maxBudgetUSD {
			fmt.Fprintf(os.Stderr, "✗ cumulative cost $%.4f exceeds --max-budget-usd $%.4f — aborting\n",
				cumulativeCost, opts.maxBudgetUSD)
			allOK = false
			break
		}
	}

	if opts.jsonOutput {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
			"results":         results,
			"cumulative_cost": cumulativeCost,
			"ok":              allOK,
		})
	} else {
		fmt.Fprintf(os.Stderr, "\n=== summary ===\n")
		passed := 0
		for _, r := range results {
			if r.OK {
				passed++
			}
		}
		fmt.Fprintf(os.Stderr, "%d/%d scenarios passed · cumulative cost $%.4f\n",
			passed, len(results), cumulativeCost)
	}
	if !allOK {
		return 1
	}
	return 0
}

// ─── Scenario loading ──────────────────────────────────────────────

func loadScenarios(target string) ([]Scenario, error) {
	st, err := os.Stat(target)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		s, err := readScenario(target)
		if err != nil {
			return nil, err
		}
		return []Scenario{s}, nil
	}
	// Convenience: if target is an app dir (contains apteva.yaml)
	// and has a sibling scenarios/ folder, descend into it. That
	// way `apteva test ./` from inside an app loads the scenarios
	// the author actually meant.
	if _, err := os.Stat(filepath.Join(target, "apteva.yaml")); err == nil {
		if sc, err := os.Stat(filepath.Join(target, "scenarios")); err == nil && sc.IsDir() {
			target = filepath.Join(target, "scenarios")
		}
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		return nil, err
	}
	var out []Scenario
	files := []string{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		// `apteva.yaml` is the manifest, never a scenario — skip it
		// so callers can point at an app dir without us treating its
		// manifest as a 0-assertion scenario.
		if e.Name() == "apteva.yaml" {
			continue
		}
		files = append(files, e.Name())
	}
	sort.Strings(files)
	for _, f := range files {
		s, err := readScenario(filepath.Join(target, f))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		out = append(out, s)
	}
	return out, nil
}

func readScenario(path string) (Scenario, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return Scenario{}, err
	}
	var s Scenario
	if err := yaml.Unmarshal(body, &s); err != nil {
		return Scenario{}, err
	}
	if s.Name == "" {
		s.Name = strings.TrimSuffix(filepath.Base(path), ".yaml")
	}
	if abs, err := filepath.Abs(path); err == nil {
		s.SourceDir = filepath.Dir(abs)
	} else {
		s.SourceDir = filepath.Dir(path)
	}
	return s, nil
}

// ─── Server bootstrap ──────────────────────────────────────────────

type testServer struct {
	addr      string
	apiKey    string
	projectID string // user's default project, fetched at bootstrap
	dataDir   string
	cmd       *exec.Cmd
	teardown  func()
}

func (s *testServer) Stop() {
	if s.teardown != nil {
		s.teardown()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
		_ = s.cmd.Wait()
	}
	// Honour APTEVA_TEST_KEEP=1 to skip cleanup — useful when
	// debugging "agent didn't iterate" mysteries; lets the user
	// inspect the data dir + server log after the run.
	if s.dataDir != "" && os.Getenv("APTEVA_TEST_KEEP") == "" {
		_ = os.RemoveAll(s.dataDir)
	} else if s.dataDir != "" {
		fmt.Fprintf(os.Stderr, "kept data dir: %s\n", s.dataDir)
	}
}

func bootstrapServer(opts testOpts) (*testServer, error) {
	if opts.serverAddr != "" {
		// Caller pointed us at an existing server — register a test
		// user, return a client. No spawn, no teardown of state.
		key, err := registerTestUser(opts.serverAddr)
		if err != nil {
			return nil, fmt.Errorf("register on existing server: %w", err)
		}
		return &testServer{addr: opts.serverAddr, apiKey: key}, nil
	}
	// Spawn a clean instance.
	port, err := pickFreePort()
	if err != nil {
		return nil, err
	}
	dataDir, err := os.MkdirTemp("", "apteva-test-*")
	if err != nil {
		return nil, err
	}
	bin := findServerBinary("")
	if bin == "" {
		return nil, fmt.Errorf("apteva-server binary not found in PATH or sibling dirs")
	}
	cmd := exec.Command(bin)
	// Merge ~/.apteva/test.env on top of os.Environ so user-stashed
	// provider keys (OPENCODE_GO_API_KEY, FIREWORKS_API_KEY, …) are
	// picked up without exporting them in the shell. File format is
	// KEY=VALUE per line, # for comments — same as a .env file.
	baseEnv := append([]string{}, os.Environ()...)
	for k, v := range loadTestEnvFile() {
		if os.Getenv(k) == "" {
			baseEnv = append(baseEnv, k+"="+v)
		}
	}
	if !envHasProviderKey(baseEnv) {
		fmt.Fprintln(os.Stderr,
			"⚠ no LLM provider key in env or ~/.apteva/test.env — agent won't iterate.\n"+
				"  Set one of OPENCODE_GO_API_KEY / FIREWORKS_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY.")
	}
	cmd.Env = append(baseEnv,
		fmt.Sprintf("PORT=%d", port),
		"DB_PATH="+filepath.Join(dataDir, "apteva.db"),
		"DATA_DIR="+dataDir,
		"CORE_CMD="+findCoreBinary(""),
		"APPS_DIR="+findAppsDir(),
		"APTEVA_REGISTRATION=open",
		// Skip the local-spawn path for app installs — the test runner
		// wants to mount its own pre-built sidecar instead of having
		// the server clone+build the public repo. With this set the
		// install handler creates the row + returns; the runner then
		// POSTs /status to bind the local sidecar URL.
		"APTEVA_APPS_REMOTE=1",
		"NO_TUI=1",
		"NO_CONSOLE=1",
		"QUIET=1",
	)
	logFile, _ := os.Create(filepath.Join(dataDir, "server.log"))
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	setProcGroup(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	if err := waitHealthy("http://"+addr+"/health", 15*time.Second); err != nil {
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("server didn't become healthy: %w", err)
	}
	apiKey, err := registerTestUser(addr)
	if err != nil {
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("register user: %w", err)
	}
	srv := &testServer{addr: addr, apiKey: apiKey, dataDir: dataDir, cmd: cmd}
	pid, err := fetchDefaultProjectID(srv)
	if err != nil {
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("fetch default project: %w", err)
	}
	srv.projectID = pid
	fmt.Fprintf(os.Stderr, "spawned apteva-server at %s (data: %s, project: %s)\n", addr, dataDir, pid)
	return srv, nil
}

// registerTestUser creates a user, logs in to get a session cookie,
// then mints an API key (which is what every other helper sends as
// Bearer). Three round-trips, all needed because the server's auth
// surface is split: register doesn't return creds, login uses
// cookies, key-creation returns the bearer-shaped token.
// fetchDefaultProjectID returns the id of the user's first project
// (the one auto-created at registration). Tests use this rather than
// guessing a hardcoded id.
func fetchDefaultProjectID(server *testServer) (string, error) {
	req, _ := http.NewRequest("GET", "http://"+server.addr+"/api/projects", nil)
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var arr []struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&arr); err != nil {
		return "", err
	}
	if len(arr) == 0 {
		return "", fmt.Errorf("no projects on test user")
	}
	return arr[0].ID, nil
}

func registerTestUser(addr string) (string, error) {
	email := fmt.Sprintf("test-%d@apteva.test", time.Now().UnixNano())
	password := "test-password-1234"
	base := "http://" + addr

	// Register.
	if err := postJSON(base+"/api/auth/register", "",
		map[string]string{"email": email, "password": password}, nil); err != nil {
		return "", fmt.Errorf("register: %w", err)
	}

	// Login — captures session cookie.
	jar, _ := cookiejar.New(nil)
	loginClient := &http.Client{Jar: jar, Timeout: 10 * time.Second}
	loginBody, _ := json.Marshal(map[string]string{"email": email, "password": password})
	req, _ := http.NewRequest("POST", base+"/api/auth/login", bytes.NewReader(loginBody))
	req.Header.Set("Content-Type", "application/json")
	resp, err := loginClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("login: %w", err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("login: status %d", resp.StatusCode)
	}

	// Mint API key — uses the session cookie from the login.
	keyBody, _ := json.Marshal(map[string]string{"name": "test-runner"})
	req2, _ := http.NewRequest("POST", base+"/api/auth/keys", bytes.NewReader(keyBody))
	req2.Header.Set("Content-Type", "application/json")
	resp2, err := loginClient.Do(req2)
	if err != nil {
		return "", fmt.Errorf("create key: %w", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		raw, _ := io.ReadAll(resp2.Body)
		return "", fmt.Errorf("create key: status %d: %s", resp2.StatusCode, string(raw))
	}
	var keyResp struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&keyResp); err != nil {
		return "", err
	}
	if keyResp.Key == "" {
		return "", fmt.Errorf("create key: empty response")
	}
	return keyResp.Key, nil
}

// ─── Scenario execution ────────────────────────────────────────────

func runScenario(server *testServer, s Scenario, opts testOpts) (res ScenarioResult) {
	res = ScenarioResult{Name: s.Name}
	start := time.Now()
	// Named return so the deferred elapsed-time write actually
	// reaches the caller. Closures over a value-type local don't
	// propagate to a value-type return.
	defer func() { res.ElapsedMs = time.Since(start).Milliseconds() }()

	timeout := opts.timeout
	if s.Timeout != "" {
		if d, err := time.ParseDuration(s.Timeout); err == nil {
			timeout = d
		}
	}
	maxIter := s.MaxIterations
	if maxIter == 0 {
		maxIter = 10
	}

	// Resolve app path: scenario's setup.app.path overrides --app-dir.
	appDir := opts.appDir
	if s.Setup.App.Path != "" {
		appDir = s.Setup.App.Path
	}
	manifestPath := filepath.Join(appDir, "apteva.yaml")
	manifestYAML, err := os.ReadFile(manifestPath)
	if err != nil {
		res.Error = fmt.Sprintf("read manifest %s: %v", manifestPath, err)
		return res
	}

	// Install + spawn dependent apps first. The manifest's
	// requires.apps lists peer apps the unit under test calls
	// over HTTP (e.g. media → storage). Resolve each by sibling-
	// directory convention: for an app at <appDir>, look for the
	// dep at <appDir>/../<dep_name>/. Install order matters — the
	// dep must be 'running' before the main app's worker starts
	// trying to talk to it.
	deps, err := installDeps(server, appDir, manifestYAML)
	if err != nil {
		res.Error = fmt.Sprintf("install deps: %v", err)
		return res
	}
	defer func() {
		for i := len(deps) - 1; i >= 0; i-- {
			deps[i].sidecar.Stop()
			uninstallApp(server, deps[i].installID)
		}
	}()

	// Install the app under test. The server clones from the
	// configured source repo by default; for local-test we'd rather
	// it bind to the app at appDir directly. The install handler
	// accepts manifest_yaml inline; we then override the sidecar URL
	// to the local sidecar built from appDir.
	installed, err := installApp(server, manifestYAML, server.projectID, s.Setup.App.Config)
	if err != nil {
		res.Error = fmt.Sprintf("install app: %v", err)
		return res
	}
	defer uninstallApp(server, installed.InstallID)

	sidecar, err := spawnLocalSidecar(appDir, installed.InstallID, server.projectID, s.Setup.App.Config, "http://"+server.addr)
	if err != nil {
		res.Error = fmt.Sprintf("spawn local sidecar: %v", err)
		return res
	}
	defer sidecar.Stop()
	if err := setSidecarURL(server, installed.InstallID, sidecar.URL); err != nil {
		res.Error = fmt.Sprintf("set sidecar url: %v", err)
		return res
	}

	// Pre-upload fixtures before the agent starts. Lets a scenario
	// say "the catalog already has this clip in it" without burning
	// LLM iterations on the upload. Fixtures call MCP tools on the
	// peer apps directly, with the file's bytes shipped as
	// content_base64.
	mainAppName := manifestNameFromYAML(manifestYAML)
	sidecarsByApp := map[string]string{mainAppName: sidecar.URL}
	for _, d := range deps {
		sidecarsByApp[d.name] = d.sidecar.URL
	}
	if err := loadFixtures(s.Setup.Fixtures, s.SourceDir, server.projectID, sidecarsByApp); err != nil {
		res.Error = fmt.Sprintf("load fixtures: %v", err)
		return res
	}

	// Pick the project the agent runs in. testServer fetched it at
	// bootstrap so every scenario shares the same one — keeps the
	// CRM's per-project data isolated by run, not per-scenario.
	projectID := server.projectID

	// Create + start the agent. Pass the CRM sidecar's /mcp endpoint
	// as a system MCP server in the instance config so the agent's
	// tool list includes the CRM's tools. We also disable the
	// platform's default apteva-server + channels gateways for test
	// instances — keeps the agent focused on the app under test
	// instead of meta-tooling.
	mode := s.Setup.Mode
	if mode == "" {
		mode = "autonomous"
	}
	appName := manifestNameFromYAML(manifestYAML)
	if appName == "" {
		appName = "app"
	}
	mcpServers := []map[string]any{
		{
			"name":        appName,
			"transport":   "http",
			"url":         sidecar.URL + "/mcp",
			"main_access": true,
		},
	}
	// Dependent apps' MCP endpoints — main_access:false so their
	// tools are visible to the agent but the unit under test stays
	// the spotlight.
	for _, d := range deps {
		mcpServers = append(mcpServers, map[string]any{
			"name":        d.name,
			"transport":   "http",
			"url":         d.sidecar.URL + "/mcp",
			"main_access": false,
		})
	}
	inst, err := tcCreateInstance(server, projectID, s.Name, s.Directive, mode, mcpServers)
	if err != nil {
		res.Error = fmt.Sprintf("create instance: %v", err)
		return res
	}
	// Skip per-instance deletion when keep-data debug is on so the
	// agent's history/main.jsonl survives for inspection.
	if os.Getenv("APTEVA_TEST_KEEP") == "" {
		defer tcDeleteInstance(server, inst.ID)
	}

	// Write the instance's config.json with our mcp_servers BEFORE
	// starting the agent. instances.go's Start() reads disk first
	// then merges system entries; the body.config field on POST
	// /api/instances only carries server-side flags (include_apteva_
	// server, etc.), not the agent's tool list. The on-disk
	// config.json is the single source of truth core consumes.
	if err := writeInstanceDiskConfig(server, inst.ID, s.Directive, mode, mcpServers); err != nil {
		res.Error = fmt.Sprintf("write instance config.json: %v", err)
		return res
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	// Start the agent FIRST — the events endpoint refuses with
	// "instance not running" until status flips to running, so
	// hooking up SSE before /start gives a closed reader.
	if err := startInstanceAPI(server, inst.ID); err != nil {
		res.Error = fmt.Sprintf("start instance: %v", err)
		return res
	}
	// Wait for status=running so SSE doesn't immediately 4xx.
	if err := waitInstanceRunning(server, inst.ID, 5*time.Second); err != nil {
		res.Error = fmt.Sprintf("wait running: %v", err)
		return res
	}
	// Now subscribe — minor race: events emitted in the brief window
	// between status=running and SSE-open may be missed. Acceptable
	// because the assert poller is the authoritative correctness check;
	// telemetry is for token/cost accounting which trends over the run.
	telemetry, errCh, _ := streamTelemetry(ctx, server, inst.ID)

	// Wait for the asserts to pass (early-stop) OR max_iterations OR
	// timeout. We deliberately don't trust the agent's `paused` flag
	// as a "done" signal — autonomous agents loop forever; only the
	// asserts can tell us the task is actually complete.
	//
	// Three signals drive the early-stop:
	//   1. Background ticker every 500ms — catches outcomes in
	//      asserts that aren't tool-driven (e.g. timeouts).
	//   2. After every `tool.result` event — the most likely moment
	//      the task just finished. Probes immediately, no 500ms
	//      wait. This is the win for "agent did 3 tools and stopped"
	//      scenarios: we exit ~0.5s after the final tool, not ~2s.
	//   3. max_iterations hit OR timeout deadline.
	deadline := time.Now().Add(timeout)
	assertPoll := time.NewTicker(500 * time.Millisecond)
	defer assertPoll.Stop()
	stopReason := ""
	probeNow := func() {
		if probeAsserts(server, installed.InstallID, s.Assert, &res) {
			stopReason = "asserts passed"
		}
	}
	for time.Now().Before(deadline) {
		select {
		case ev, ok := <-telemetry:
			if !ok {
				// SSE closed — keep going; we still have the assert poller.
				telemetry = nil
				continue
			}
			applyTelemetry(&res, ev)
			if opts.verbose {
				fmt.Fprintf(os.Stderr, "  · %s\n", ev.Type)
			} else if ev.Type == "tool.call" {
				// Always show tool names live — gives the operator a
				// sense of progress without -v's full event firehose.
				if name, ok := ev.Data["name"].(string); ok {
					fmt.Fprintf(os.Stderr, "    · %d %s\n", res.Iterations, name)
				}
			}
			// On tool.result, probe immediately — the task may have
			// just completed, no point waiting for the next tick.
			if ev.Type == "tool.result" {
				probeNow()
			}
			if res.Iterations >= maxIter {
				stopReason = fmt.Sprintf("max_iterations (%d) reached", maxIter)
			}
		case err := <-errCh:
			if opts.verbose {
				fmt.Fprintf(os.Stderr, "  telemetry err: %v\n", err)
			}
		case <-assertPoll.C:
			probeNow()
		}
		if stopReason != "" {
			break
		}
	}
	cancel()
	if stopReason == "" {
		stopReason = "timeout"
	}

	// Stop the agent so the next scenario starts clean.
	_ = stopInstanceAPI(server, inst.ID)

	// Run asserts.
	res.Asserts = runAsserts(server, installed.InstallID, s.Assert, &res)

	// Budget check.
	res.BudgetOK = checkBudget(s.Budget, res.Tokens, res.CostUSD)

	// OK: every assert OK + budget OK + no scenario-level error.
	res.OK = res.Error == "" && res.BudgetOK
	for _, a := range res.Asserts {
		if !a.OK {
			res.OK = false
			break
		}
	}
	if opts.verbose {
		fmt.Fprintf(os.Stderr, "  stop_reason: %s\n", stopReason)
	}
	return res
}

// ─── Telemetry → result aggregation ────────────────────────────────

type telemetryEvent struct {
	Type string         `json:"type"`
	Data map[string]any `json:"data"`
}

func applyTelemetry(res *ScenarioResult, ev telemetryEvent) {
	switch ev.Type {
	case "llm.done":
		res.Iterations++
		if v, ok := ev.Data["tokens_in"].(float64); ok {
			res.Tokens.Prompt += int(v)
		}
		if v, ok := ev.Data["tokens_out"].(float64); ok {
			res.Tokens.Completion += int(v)
		}
		if v, ok := ev.Data["cost"].(float64); ok {
			res.CostUSD += v
		}
		res.Tokens.Total = res.Tokens.Prompt + res.Tokens.Completion
	case "tool.call":
		name, _ := ev.Data["name"].(string)
		res.ToolCalls = append(res.ToolCalls, ToolCallResult{Name: name})
	case "tool.result":
		name, _ := ev.Data["name"].(string)
		ok, _ := ev.Data["ok"].(bool)
		// Mark the most recent matching tool call as done.
		for i := len(res.ToolCalls) - 1; i >= 0; i-- {
			if res.ToolCalls[i].Name == name {
				res.ToolCalls[i].OK = ok
				break
			}
		}
	}
}

// ─── Asserts ───────────────────────────────────────────────────────

// probeAsserts returns true when EVERY assert clause passes right
// now — including tool_called clauses (matched against the running
// res.ToolCalls). Used by the run loop to decide whether the task
// is complete and the run can stop early. iteration_at_most is
// skipped here (always trivially "not yet violated" mid-run).
//
// Stopping early on partial success was a bug: scenario 2 stopped
// the moment HTTP count became 1 (Bob created), before the agent
// could call log_activity. The asserts collectively define
// "complete" — any one passing isn't enough.
func probeAsserts(server *testServer, installID int64, clauses []AssertClause, res *ScenarioResult) bool {
	if len(clauses) == 0 {
		return false
	}
	for _, c := range clauses {
		switch {
		case c.HTTP != "":
			if !assertHTTP(server, installID, c).OK {
				return false
			}
		case c.ToolCalled != "":
			if !assertToolCalled(c, res).OK {
				return false
			}
		case c.IterationsAtMost > 0:
			// Trivially passes during the run; only meaningful at
			// the final pass.
			continue
		}
	}
	return true
}

func runAsserts(server *testServer, installID int64, clauses []AssertClause, res *ScenarioResult) []AssertResult {
	out := []AssertResult{}
	for i, c := range clauses {
		ar := AssertResult{Clause: assertLabel(i, c)}
		switch {
		case c.HTTP != "":
			ar = assertHTTP(server, installID, c)
		case c.ToolCalled != "":
			ar = assertToolCalled(c, res)
		case c.IterationsAtMost > 0:
			ok := res.Iterations <= c.IterationsAtMost
			ar = AssertResult{
				Clause: fmt.Sprintf("iterations_at_most %d", c.IterationsAtMost),
				OK: ok, Got: res.Iterations, Want: c.IterationsAtMost,
			}
		default:
			ar.OK = false
			ar.Note = "unrecognised assert clause"
		}
		out = append(out, ar)
	}
	return out
}

func assertLabel(i int, c AssertClause) string {
	if c.HTTP != "" {
		return c.HTTP
	}
	if c.ToolCalled != "" {
		return "tool_called " + c.ToolCalled
	}
	return fmt.Sprintf("clause #%d", i+1)
}

func assertHTTP(server *testServer, installID int64, c AssertClause) AssertResult {
	parts := strings.SplitN(c.HTTP, " ", 2)
	if len(parts) != 2 {
		return AssertResult{Clause: c.HTTP, OK: false, Note: "expected 'METHOD /path'"}
	}
	method, path := parts[0], parts[1]
	// Translate /api/apps/<name>/* through the server's app proxy. We
	// need the install_id query param so the panel-style routing works.
	req, err := http.NewRequest(method, "http://"+server.addr+path, nil)
	if err != nil {
		return AssertResult{Clause: c.HTTP, OK: false, Note: err.Error()}
	}
	q := req.URL.Query()
	q.Set("install_id", fmt.Sprintf("%d", installID))
	q.Set("project_id", server.projectID)
	req.URL.RawQuery = q.Encode()
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return AssertResult{Clause: c.HTTP, OK: false, Note: err.Error()}
	}
	defer resp.Body.Close()
	want := c.ExpectStatus
	if want == 0 {
		want = 200
	}
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		return AssertResult{Clause: c.HTTP, OK: false, Got: resp.StatusCode, Want: want,
			Note: tcTruncate(string(body), 200)}
	}
	if c.ExpectCountAt != "" {
		var data map[string]any
		_ = json.Unmarshal(body, &data)
		arr, _ := data[c.ExpectCountAt].([]any)
		if len(arr) != c.ExpectCount {
			return AssertResult{Clause: c.HTTP + " count " + c.ExpectCountAt,
				OK: false, Got: len(arr), Want: c.ExpectCount}
		}
		return AssertResult{Clause: c.HTTP + " count " + c.ExpectCountAt,
			OK: true, Got: len(arr), Want: c.ExpectCount}
	}
	return AssertResult{Clause: c.HTTP, OK: true, Got: resp.StatusCode}
}

// assertToolCalled matches by exact name OR by suffix-after-underscore.
// The platform prefixes MCP tool names with the server's name, so a
// scenario that says `tool_called: contacts_create` matches
// `crm_contacts_create`, `mybusiness-crm_contacts_create`, etc.
// Pin the prefix explicitly when you want to disambiguate.
func assertToolCalled(c AssertClause, res *ScenarioResult) AssertResult {
	wants := strings.Split(c.ToolCalled, "|")
	for _, w := range wants {
		w = strings.TrimSpace(w)
		for _, t := range res.ToolCalls {
			if t.Name == w || strings.HasSuffix(t.Name, "_"+w) {
				return AssertResult{Clause: "tool_called " + c.ToolCalled, OK: true, Got: t.Name}
			}
		}
	}
	return AssertResult{Clause: "tool_called " + c.ToolCalled, OK: false,
		Got: toolCallNames(res.ToolCalls)}
}

func toolCallNames(tcs []ToolCallResult) []string {
	out := make([]string, 0, len(tcs))
	for _, t := range tcs {
		out = append(out, t.Name)
	}
	return out
}

// ─── Budget ────────────────────────────────────────────────────────

func checkBudget(b Budget, tokens TokenSummary, cost float64) bool {
	if b.PromptTokens > 0 && tokens.Prompt > b.PromptTokens {
		return false
	}
	if b.CompletionTokens > 0 && tokens.Completion > b.CompletionTokens {
		return false
	}
	if b.TotalTokens > 0 && tokens.Total > b.TotalTokens {
		return false
	}
	if b.CostUSD > 0 && cost > b.CostUSD {
		return false
	}
	return true
}

// ─── HTTP helpers (server's REST surface) ──────────────────────────

// depBundle bundles a running dependent app — install + sidecar — so
// the runner can wire it into the agent's MCP list and tear it down
// in reverse order at the end of the scenario.
type depBundle struct {
	name      string
	installID int64
	sidecar   *localSidecar
}

// installDeps walks the manifest's requires.apps and installs +
// spawns each dep before the unit-under-test. Dep paths follow the
// monorepo sibling convention: `<appDir>/../<dep_name>/`. Returns
// the deps in the order they were installed; the caller cleans up
// in reverse on scenario exit.
func installDeps(server *testServer, appDir string, manifestYAML []byte) ([]depBundle, error) {
	depNames := parseRequiresApps(manifestYAML)
	if len(depNames) == 0 {
		return nil, nil
	}
	parent := filepath.Dir(appDir)
	if abs, err := filepath.Abs(appDir); err == nil {
		parent = filepath.Dir(abs)
	}
	rollback := func(out []depBundle) {
		for i := len(out) - 1; i >= 0; i-- {
			out[i].sidecar.Stop()
			uninstallApp(server, out[i].installID)
		}
	}
	out := make([]depBundle, 0, len(depNames))
	for _, name := range depNames {
		depDir := filepath.Join(parent, name)
		manifestPath := filepath.Join(depDir, "apteva.yaml")
		depYAML, err := os.ReadFile(manifestPath)
		if err != nil {
			rollback(out)
			return nil, fmt.Errorf("dep %q manifest not found at %s — sibling-dir convention expects it next to the app under test", name, manifestPath)
		}
		installed, err := installApp(server, depYAML, server.projectID, nil)
		if err != nil {
			rollback(out)
			return nil, fmt.Errorf("install dep %q: %w", name, err)
		}
		sc, err := spawnLocalSidecar(depDir, installed.InstallID, server.projectID, nil, "http://"+server.addr)
		if err != nil {
			uninstallApp(server, installed.InstallID)
			rollback(out)
			return nil, fmt.Errorf("spawn dep %q: %w", name, err)
		}
		if err := setSidecarURL(server, installed.InstallID, sc.URL); err != nil {
			sc.Stop()
			uninstallApp(server, installed.InstallID)
			rollback(out)
			return nil, fmt.Errorf("set dep %q sidecar url: %w", name, err)
		}
		out = append(out, depBundle{name: name, installID: installed.InstallID, sidecar: sc})
	}
	return out, nil
}

// loadFixtures pre-uploads files declared in setup.fixtures. Each
// entry calls one MCP tool on a peer app's sidecar, with the file
// shipped as content_base64 alongside whatever extra args the
// scenario author passed.
//
// Used to seed e2e scenarios with realistic data without burning
// agent iterations on the upload itself — the directive can then
// focus on what's actually being tested (search, retrieval, etc.).
func loadFixtures(fixtures []FixtureSpec, sourceDir, projectID string, sidecars map[string]string) error {
	for _, f := range fixtures {
		if f.App == "" {
			return fmt.Errorf("fixture missing 'app' field")
		}
		if f.Tool == "" {
			return fmt.Errorf("fixture missing 'tool' field (target MCP tool, e.g. files_upload)")
		}
		if f.File == "" {
			return fmt.Errorf("fixture missing 'file' field")
		}
		sidecarURL, ok := sidecars[f.App]
		if !ok {
			return fmt.Errorf("fixture targets app %q but it isn't installed in this scenario (must be the unit-under-test or a declared dep)", f.App)
		}
		// Resolve relative to the scenario YAML dir.
		path := f.File
		if !filepath.IsAbs(path) {
			path = filepath.Join(sourceDir, path)
		}
		bytesBody, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("fixture %s: %w", path, err)
		}
		args := map[string]any{}
		for k, v := range f.Args {
			args[k] = v
		}
		// Fill in the bytes + a sensible default name. The scenario
		// can override either via Args.
		if _, has := args["name"]; !has {
			args["name"] = filepath.Base(f.File)
		}
		args["content_base64"] = base64.StdEncoding.EncodeToString(bytesBody)
		// Project ID gets passed via the MCP `_project_id` convention
		// every Apteva app supports; without it global-scope installs
		// can't tell which project to write to.
		if projectID != "" {
			args["_project_id"] = projectID
		}
		if err := callPeerMCP(sidecarURL, f.Tool, args); err != nil {
			return fmt.Errorf("fixture %s → %s.%s: %w", path, f.App, f.Tool, err)
		}
	}
	return nil
}

// callPeerMCP issues a tools/call against a sidecar's /mcp endpoint
// and returns when the call finishes. We're already authorised
// because the sidecar is in dev-mode (APTEVA_APP_TOKEN="").
func callPeerMCP(sidecarURL, tool string, args map[string]any) error {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": tool, "arguments": args},
	})
	resp, err := http.Post(sidecarURL+"/mcp", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(raw))
	}
	var parsed struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&parsed)
	if parsed.Error != nil {
		return fmt.Errorf("mcp %d: %s", parsed.Error.Code, parsed.Error.Message)
	}
	return nil
}

// parseRequiresApps grabs the names listed under `requires.apps:`
// in a manifest. Tiny line-scan rather than a full YAML parse —
// the shape is stable and any drift will show up loudly in
// install failures.
func parseRequiresApps(manifestYAML []byte) []string {
	lines := strings.Split(string(manifestYAML), "\n")
	inRequires, inApps := false, false
	var names []string
	for _, raw := range lines {
		line := strings.TrimRight(raw, " \t")
		trimmed := strings.TrimSpace(line)
		if len(line) > 0 && line[0] != ' ' && line[0] != '\t' {
			inRequires = trimmed == "requires:"
			inApps = false
			continue
		}
		if !inRequires {
			continue
		}
		// Two-space-indented child of requires:
		if strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "    ") {
			inApps = trimmed == "apps:"
			continue
		}
		if !inApps {
			continue
		}
		if !strings.HasPrefix(trimmed, "-") {
			continue
		}
		item := strings.TrimSpace(strings.TrimPrefix(trimmed, "-"))
		if strings.HasPrefix(item, "name:") {
			names = append(names, strings.TrimSpace(strings.TrimPrefix(item, "name:")))
			continue
		}
		// Inline `{ name: foo, version: "..." }` form — pick out name.
		if i := strings.Index(item, "name:"); i >= 0 {
			rest := item[i+len("name:"):]
			rest = strings.Trim(strings.TrimSpace(rest), `"',}`)
			if comma := strings.IndexAny(rest, ",}"); comma >= 0 {
				rest = rest[:comma]
			}
			names = append(names, strings.TrimSpace(rest))
		}
	}
	return names
}

type installResp struct {
	InstallID int64 `json:"install_id"`
	AppID     int64 `json:"app_id"`
}

func installApp(server *testServer, manifestYAML []byte, projectID string, config map[string]string) (*installResp, error) {
	body := map[string]any{
		"manifest_yaml": string(manifestYAML),
		"project_id":    projectID,
		"config":        config,
	}
	out := &installResp{}
	if err := postJSON("http://"+server.addr+"/api/apps/install", server.apiKey, body, out); err != nil {
		return nil, err
	}
	return out, nil
}

func uninstallApp(server *testServer, installID int64) {
	req, _ := http.NewRequest("DELETE",
		fmt.Sprintf("http://%s/api/apps/installs/%d?force=1", server.addr, installID), nil)
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err == nil {
		resp.Body.Close()
	}
}

func setSidecarURL(server *testServer, installID int64, url string) error {
	body := map[string]any{
		"status":       "running",
		"sidecar_url":  url,
		"service_name": fmt.Sprintf("test-sidecar-%d", installID),
	}
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest("PUT",
		fmt.Sprintf("http://%s/api/apps/installs/%d/status", server.addr, installID),
		bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("PUT /status %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

type instanceResp struct {
	ID int64 `json:"id"`
}

func tcCreateInstance(server *testServer, projectID, name, directive, mode string, mcpServers []map[string]any) (*instanceResp, error) {
	// config_json carries the agent's MCP servers + any other config
	// the core needs at boot. The platform writes this to the
	// instance dir's config.json; the core picks it up on start.
	config := map[string]any{}
	if len(mcpServers) > 0 {
		config["mcp_servers"] = mcpServers
	}
	configJSON, _ := json.Marshal(config)

	includeFalse := false
	body := map[string]any{
		"name":                  name,
		"directive":             directive,
		"mode":                  mode,
		"project_id":            projectID,
		"start":                 false, // we start it ourselves so SSE is wired up first
		"config":                string(configJSON),
		"include_apteva_server": &includeFalse, // lean instance — only the app under test
		"include_channels":      &includeFalse,
	}
	out := &instanceResp{}
	if err := postJSON("http://"+server.addr+"/api/instances", server.apiKey, body, out); err != nil {
		return nil, err
	}
	return out, nil
}

// writeInstanceDiskConfig writes <dataDir>/instance_<id>/config.json
// with the directive, mode, and mcp_servers a fresh agent needs to
// see the app's tools at boot. instances.go:Start reads this file
// before merging in the system MCP entries, so anything we put here
// flows into the agent's tool surface.
//
// Only effective when bootstrapServer spawned the apteva-server
// itself (we know dataDir then). When testServer.dataDir is empty
// (existing-server mode), we no-op — the operator owns disk state.
func writeInstanceDiskConfig(server *testServer, instanceID int64, directive, mode string, mcpServers []map[string]any) error {
	if server.dataDir == "" {
		return nil
	}
	dir := filepath.Join(server.dataDir, fmt.Sprintf("instance_%d", instanceID))
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	cfg := map[string]any{
		"directive":   directive,
		"mode":        mode,
		"mcp_servers": mcpServers,
	}
	body, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "config.json"), body, 0644)
}

// manifestNameFromYAML is a tiny YAML field grab — we already have
// the manifest bytes from the scenario step; pulling `name:` is a
// one-line scan rather than re-parsing through gopkg.in/yaml.v3.
func manifestNameFromYAML(body []byte) string {
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "name:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "name:"))
		}
	}
	return ""
}

func startInstanceAPI(server *testServer, id int64) error {
	return postJSON(fmt.Sprintf("http://%s/api/instances/%d/start", server.addr, id),
		server.apiKey, nil, nil)
}

func stopInstanceAPI(server *testServer, id int64) error {
	return postJSON(fmt.Sprintf("http://%s/api/instances/%d/stop", server.addr, id),
		server.apiKey, nil, nil)
}

func tcDeleteInstance(server *testServer, id int64) {
	req, _ := http.NewRequest("DELETE",
		fmt.Sprintf("http://%s/api/instances/%d", server.addr, id), nil)
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err == nil {
		resp.Body.Close()
	}
}

// waitInstanceRunning polls the platform's /api/instances list until
// the instance with the given id shows status=running, or until the
// deadline elapses. Used to gate SSE-subscribe on a bootable agent.
func waitInstanceRunning(server *testServer, id int64, deadline time.Duration) error {
	end := time.Now().Add(deadline)
	for time.Now().Before(end) {
		req, _ := http.NewRequest("GET", "http://"+server.addr+"/api/instances", nil)
		req.Header.Set("Authorization", "Bearer "+server.apiKey)
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			var arr []struct {
				ID     int64  `json:"id"`
				Status string `json:"status"`
			}
			json.NewDecoder(resp.Body).Decode(&arr)
			resp.Body.Close()
			for _, i := range arr {
				if i.ID == id && i.Status == "running" {
					return nil
				}
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("instance %d never reached status=running", id)
}

func getInstanceStatus(server *testServer, id int64) (map[string]any, error) {
	req, _ := http.NewRequest("GET",
		fmt.Sprintf("http://%s/api/instances/%d/status", server.addr, id), nil)
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// ─── Telemetry SSE ─────────────────────────────────────────────────

func streamTelemetry(ctx context.Context, server *testServer, instanceID int64) (<-chan telemetryEvent, <-chan error, <-chan struct{}) {
	out := make(chan telemetryEvent, 256)
	errs := make(chan error, 1)
	connected := make(chan struct{}) // closed when the SSE response is open
	go func() {
		defer close(out)
		req, err := http.NewRequestWithContext(ctx, "GET",
			fmt.Sprintf("http://%s/api/instances/%d/events", server.addr, instanceID), nil)
		if err != nil {
			close(connected)
			errs <- err
			return
		}
		req.Header.Set("Authorization", "Bearer "+server.apiKey)
		req.Header.Set("Accept", "text/event-stream")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			close(connected)
			errs <- err
			return
		}
		defer resp.Body.Close()
		// Signal the caller — fine to start the agent now, we won't
		// miss its early `llm.done` events.
		close(connected)
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 256*1024), 4*1024*1024)
		dbg := os.Getenv("APTEVA_TEST_DEBUG_SSE") != ""
		var current strings.Builder
		for scanner.Scan() {
			line := scanner.Text()
			if dbg {
				fmt.Fprintf(os.Stderr, "[SSE raw] %q\n", line)
			}
			// SSE frame terminator. A frame can span multiple lines:
			// `event:`, `data:` (one or more), `id:`, plus blank line.
			// We only care about `data:` payloads — concatenate them
			// into a single JSON blob (per SSE spec, separated by \n).
			if line == "" {
				if current.Len() > 0 {
					raw := current.String()
					var ev telemetryEvent
					if err := json.Unmarshal([]byte(raw), &ev); err == nil {
						select {
						case out <- ev:
						case <-ctx.Done():
							return
						}
					} else if dbg {
						fmt.Fprintf(os.Stderr, "[SSE parse err] %v body=%q\n", err, raw)
					}
					current.Reset()
				}
				continue
			}
			if strings.HasPrefix(line, "data:") {
				// Strip the prefix — `data: ` (space optional per spec).
				payload := strings.TrimPrefix(line, "data:")
				payload = strings.TrimPrefix(payload, " ")
				if current.Len() > 0 {
					current.WriteByte('\n')
				}
				current.WriteString(payload)
			}
			// Lines that aren't `data:` (event:, id:, retry:, comments
			// starting with :) are intentionally ignored.
		}
	}()
	return out, errs, connected
}

// ─── Local sidecar ─────────────────────────────────────────────────

type localSidecar struct {
	URL  string
	cmd  *exec.Cmd
	stop func()
}

func (s *localSidecar) Stop() {
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
		_ = s.cmd.Wait()
	}
	if s.stop != nil {
		s.stop()
	}
}

func spawnLocalSidecar(appDir string, installID int64, projectID string, config map[string]string, gatewayURL string) (*localSidecar, error) {
	abs, err := filepath.Abs(appDir)
	if err != nil {
		return nil, err
	}
	binPath := filepath.Join(abs, "_test_sidecar_bin")
	build := exec.Command("go", "build", "-o", binPath, ".")
	build.Dir = abs
	if out, err := build.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("go build %s: %s", appDir, string(out))
	}
	port, err := pickFreePort()
	if err != nil {
		return nil, err
	}
	cfgJSON, _ := json.Marshal(config)
	dataDir, _ := os.MkdirTemp("", "apteva-scenario-*")
	cmd := exec.Command(binPath)
	cmd.Dir = abs
	// Two tokens, two roles:
	//
	//   APTEVA_APP_TOKEN — what the sidecar's withTokenAuth checks
	//   on inbound requests. Empty in tests because the agent calls
	//   /mcp directly (no auth header); empty triggers the SDK's
	//   dev-mode pass-through.
	//
	//   APTEVA_OUTBOUND_TOKEN — what the sidecar attaches as Bearer
	//   on calls it makes to peers via the platform proxy. We use
	//   the install-token format ("dev-<id>"); the platform's
	//   authMiddleware accepts those for /api/apps/* and the proxy
	//   then swaps to the destination install's token.
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
	logFile, _ := os.Create(filepath.Join(dataDir, "sidecar.log"))
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	setProcGroup(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	if err := waitHealthy(url+"/health", 10*time.Second); err != nil {
		_ = cmd.Process.Kill()
		return nil, err
	}
	return &localSidecar{URL: url, cmd: cmd, stop: func() {
		_ = os.RemoveAll(dataDir)
		_ = os.Remove(binPath)
	}}, nil
}

// ─── Misc ──────────────────────────────────────────────────────────

func postJSON(url, apiKey string, body, out any) error {
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest("POST", url, reader)
	if err != nil {
		return err
	}
	if reader != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("%d: %s", resp.StatusCode, tcTruncate(string(raw), 300))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func waitHealthy(url string, deadline time.Duration) error {
	end := time.Now().Add(deadline)
	for time.Now().Before(end) {
		resp, err := http.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("not healthy after %s", deadline)
}

// loadTestEnvFile reads ~/.apteva/test.env. Missing file returns an
// empty map — no error, the runner just proceeds with whatever's in
// the shell env. Lines starting with # are comments; blank lines
// skipped; everything else is KEY=VALUE (no quoting handled — keys
// are bytes-as-typed).
func loadTestEnvFile() map[string]string {
	out := map[string]string{}
	home, err := os.UserHomeDir()
	if err != nil {
		return out
	}
	body, err := os.ReadFile(filepath.Join(home, ".apteva", "test.env"))
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 1 {
			continue
		}
		out[strings.TrimSpace(line[:eq])] = strings.TrimSpace(line[eq+1:])
	}
	return out
}

// envHasProviderKey reports whether at least one LLM provider key is
// present in the env slice. Mirrors the auto-detect order in the
// core's provider.go so the warning matches what'd actually be picked.
func envHasProviderKey(env []string) bool {
	keys := []string{
		"OPENCODE_GO_API_KEY", "FIREWORKS_API_KEY", "ANTHROPIC_API_KEY",
		"GOOGLE_API_KEY", "OPENAI_API_KEY", "NVIDIA_API_KEY", "OLLAMA_HOST",
	}
	have := map[string]bool{}
	for _, kv := range env {
		eq := strings.IndexByte(kv, '=')
		if eq > 0 {
			have[kv[:eq]] = true
		}
	}
	for _, k := range keys {
		if have[k] {
			return true
		}
	}
	return false
}

func pickFreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func tcTruncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func printSummary(w io.Writer, r ScenarioResult, verbose bool) {
	mark := "✓"
	if !r.OK {
		mark = "✗"
	}
	fmt.Fprintf(w, "%s %s · %dms · %d iter · %d tokens · $%.4f\n",
		mark, r.Name, r.ElapsedMs, r.Iterations, r.Tokens.Total, r.CostUSD)
	if r.Error != "" {
		fmt.Fprintf(w, "    error: %s\n", r.Error)
	}
	for _, a := range r.Asserts {
		m := "  ✓"
		if !a.OK {
			m = "  ✗"
		}
		if a.Got != nil || a.Want != nil {
			fmt.Fprintf(w, "%s %s — got=%v want=%v\n", m, a.Clause, a.Got, a.Want)
		} else {
			fmt.Fprintf(w, "%s %s\n", m, a.Clause)
		}
		if a.Note != "" {
			fmt.Fprintf(w, "       note: %s\n", a.Note)
		}
	}
	if !r.BudgetOK {
		fmt.Fprintf(w, "  ✗ budget exceeded\n")
	}
}
