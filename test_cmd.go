package main

// `apteva test` — native app tests plus Tier 3 live-agent scenarios.
//
// Spawns a clean apteva-server in a temp data dir, installs the local
// app from disk, runs every YAML scenario in the target directory:
// creates the agent with the directive, subscribes to telemetry SSE,
// waits for completion, runs the asserts, records token usage.
//
// Usage:
//   apteva test --tier 1 ./                 # fast in-process app tests
//   apteva test --tier 2 ./                 # real sidecar integration tests
//   apteva test --tier 2 --profile live-carrier ./ # opt-in real carrier loop
//   apteva test --tier 1,2 ./               # both native tiers
//   apteva test ./scenarios/                # Tier 3 scenarios (default)
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
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type testOpts struct {
	ctx          context.Context
	target       string
	serverAddr   string // empty = auto-spawn
	serverAPIKey string // existing-server owner auth; never logged
	projectID    string
	provider     string
	appDir       string
	timeout      time.Duration
	maxBudgetUSD float64
	artifactsDir string
	verbose      bool
	jsonOutput   bool
}

type Scenario struct {
	Name             string         `yaml:"name"`
	Description      string         `yaml:"description"`
	Timeout          string         `yaml:"timeout"`            // duration string, default 90s
	SettleFor        string         `yaml:"settle_for"`         // assertions must remain true for this duration
	MaxIterations    int            `yaml:"max_iterations"`     // default 10
	Runs             int            `yaml:"runs"`               // default 1
	RequiredPassRate float64        `yaml:"required_pass_rate"` // default 1.0
	Setup            ScenarioSetup  `yaml:"setup"`
	Directive        string         `yaml:"directive"`
	Prompt           string         `yaml:"prompt"` // user input when setup.interaction=conversation
	Assert           []AssertClause `yaml:"assert"`
	OutcomeAssert    []AssertClause `yaml:"outcome_assert"`
	TrajectoryAssert []AssertClause `yaml:"trajectory_assert"`
	Budget           Budget         `yaml:"budget"`

	// SourceDir — directory the YAML was read from. Used to resolve
	// relative paths in setup.fixtures.file. Set by readScenario, not
	// the YAML author.
	SourceDir  string `yaml:"-"`
	SourcePath string `yaml:"-"`
}

type ScenarioSetup struct {
	App             AppSetup            `yaml:"app"`
	Mode            string              `yaml:"mode"`        // autonomous | cautious | learn
	Interaction     string              `yaml:"interaction"` // autonomous (default) | thread | conversation (legacy)
	Thread          *ScenarioThreadSpec `yaml:"thread"`
	Config          map[string]string   `yaml:"config"`
	Fixtures        []FixtureSpec       `yaml:"fixtures"` // pre-uploaded files / setup data
	FakeMCPs        []FakeMCPServerSpec `yaml:"fake_mcp_servers"`
	InitialWake     *InitialWakeSpec    `yaml:"initial_wake"`
	SeedMCPCalls    []SeedMCPCallSpec   `yaml:"seed_mcp_calls"`
	CleanupMCPCalls []SeedMCPCallSpec   `yaml:"cleanup_mcp_calls"`
	RequiredEnv     []string            `yaml:"required_env"`
}

// ScenarioThreadSpec describes a test-owned Core thread. The runner creates it
// through Core's authenticated /threads API and queues Scenario.Prompt in the
// same request, so the first model iteration cannot race ahead of its input or
// capability profile. This is the preferred interaction mode for app tests;
// it has no dependency on a user-facing channel implementation.
type ScenarioThreadSpec struct {
	ID        string   `yaml:"id"`
	Directive string   `yaml:"directive"`
	Tools     []string `yaml:"tools"`
	MCP       []string `yaml:"mcp"`
}

// FakeMCPServerSpec adds a deterministic, in-process MCP server to a live
// scenario. It is useful when the app under test coordinates a worker that
// must combine authoritative app data with a separate domain capability.
// Fake MCPs are spawnable by default; set no_spawn only for access-control
// scenarios that explicitly need the opposite behavior.
type FakeMCPServerSpec struct {
	Name    string            `yaml:"name"`
	NoSpawn bool              `yaml:"no_spawn"`
	Tools   []FakeMCPToolSpec `yaml:"tools"`
}

type FakeMCPToolSpec struct {
	Name        string   `yaml:"name"`
	Description string   `yaml:"description"`
	Required    []string `yaml:"required"`
	Result      string   `yaml:"result"`
}

type AppSetup struct {
	Path          string            `yaml:"path"`           // local path to the app being tested
	Config        map[string]string `yaml:"config"`         // install-time config
	Env           map[string]string `yaml:"env"`            // sidecar process environment
	Bindings      map[string]string `yaml:"bindings"`       // optional app dependency name -> "app"
	ReuseExisting bool              `yaml:"reuse_existing"` // use the server's installed app and state
	Spawnable     bool              `yaml:"spawnable"`      // allow agent-created workers to attach this app's MCP
}

// FixtureSpec — pre-loaded data that has to be in place before the
// agent runs. v0.1: upload a local file into a peer app via that
// app's MCP `files_upload` tool (or any tool with a similar shape).
// Path is relative to the scenario YAML file's dir.
type FixtureSpec struct {
	App  string         `yaml:"app"`  // app slug — must be the unit-under-test or a dep
	Tool string         `yaml:"tool"` // MCP tool name — e.g. files_upload
	File string         `yaml:"file"` // relative path to a binary fixture
	Args map[string]any `yaml:"args"` // extra tool args (folder, content_type, …)
}

// InitialWakeSpec preloads Core's durable main-thread timer before the agent
// starts. It is intentionally a relative duration so scenarios remain
// repeatable and do not depend on the wall-clock minute in which they run.
type InitialWakeSpec struct {
	After string `yaml:"after"`
	Sleep string `yaml:"sleep"`
}

// SeedMCPCallSpec invokes an app tool as the not-yet-started test agent. This
// seeds durable app state without spending an LLM iteration on setup and, in
// combination with InitialWakeSpec, can align an app event with a Core timer.
type SeedMCPCallSpec struct {
	App      string         `yaml:"app"`
	Tool     string         `yaml:"tool"`
	ThreadID string         `yaml:"thread_id"`
	Args     map[string]any `yaml:"args"`
}

type AssertClause struct {
	HTTP                  string             `yaml:"http"`            // "GET /path"
	ExpectStatus          int                `yaml:"expect_status"`   // default 200
	ExpectCountAt         string             `yaml:"expect_count_at"` // dotted JSON path to count under
	ExpectCount           *int               `yaml:"expect_count"`    // exact size, including zero
	ExpectCountMin        int                `yaml:"expect_count_min"`
	ExpectCountMax        int                `yaml:"expect_count_max"`
	ExpectItemAt          string             `yaml:"expect_item_at"`  // dotted path to an array containing a matching object
	ExpectItem            map[string]any     `yaml:"expect_item"`     // object subset to find, independent of array order
	ExpectFieldAt         string             `yaml:"expect_field_at"` // dotted path
	ExpectFieldEq         any                `yaml:"expect_field_eq"` // value to match
	ExpectFieldContains   string             `yaml:"expect_field_contains"`
	ExpectFieldMatches    string             `yaml:"expect_field_matches"`
	ToolCalled            string             `yaml:"tool_called"` // any of (a|b|c) — at least one
	ToolNotCalled         string             `yaml:"tool_not_called"`
	ToolCalledWith        *ToolCallAssertion `yaml:"tool_called_with"`
	ToolNotCalledWith     *ToolCallAssertion `yaml:"tool_not_called_with"`
	ResponseContains      string             `yaml:"response_contains"`
	AgentResponseContains string             `yaml:"agent_response_contains"`
	ResponseMatches       string             `yaml:"response_matches"`
	AgentResponseMatches  string             `yaml:"agent_response_matches"`
	ChatResponseContains  string             `yaml:"chat_response_contains"`
	ChatResponseMatches   string             `yaml:"chat_response_matches"`
	ChatFinalMessages     *int               `yaml:"chat_final_messages"`
	ThreadID              string             `yaml:"thread_id"`       // scope response assertions to one Core thread
	FinishedWithin        string             `yaml:"finished_within"` // duration
	IterationsAtMost      int                `yaml:"iterations_at_most"`
	Category              string             `yaml:"-"`
}

type ToolCallAssertion struct {
	Tool     string         `yaml:"tool"`
	Exact    bool           `yaml:"exact"`
	ThreadID string         `yaml:"thread_id"`
	Args     map[string]any `yaml:"args"`
	Count    *int           `yaml:"count"`
	MinCount int            `yaml:"min_count"`
	MaxCount int            `yaml:"max_count"`
	Before   string         `yaml:"before"`
}

type Budget struct {
	PromptTokens     int     `yaml:"prompt_tokens"`
	CompletionTokens int     `yaml:"completion_tokens"`
	TotalTokens      int     `yaml:"total_tokens"` // alias
	CostUSD          float64 `yaml:"cost_usd"`
}

type ScenarioResult struct {
	Name                  string              `json:"scenario"`
	OK                    bool                `json:"ok"`
	ElapsedMs             int64               `json:"elapsed_ms"`
	Iterations            int                 `json:"iterations"`
	ToolCalls             []ToolCallResult    `json:"tool_calls"`
	Tokens                TokenSummary        `json:"tokens"`
	CostUSD               float64             `json:"cost_usd"`
	Asserts               []AssertResult      `json:"asserts"`
	BudgetOK              bool                `json:"budget_ok"`
	Run                   int                 `json:"run,omitempty"`
	RunCount              int                 `json:"run_count,omitempty"`
	PassCount             int                 `json:"pass_count,omitempty"`
	PassRate              float64             `json:"pass_rate,omitempty"`
	RequiredPassRate      float64             `json:"required_pass_rate,omitempty"`
	Attempts              []ScenarioResult    `json:"attempts,omitempty"`
	AssistantResponses    []string            `json:"assistant_responses,omitempty"`
	ThreadResponses       map[string][]string `json:"thread_responses,omitempty"`
	ConversationResponses []string            `json:"conversation_responses,omitempty"`
	ArtifactsDir          string              `json:"artifacts_dir,omitempty"`
	Error                 string              `json:"error,omitempty"`
	telemetry             []telemetryEvent
}

type ToolCallResult struct {
	ID                  string            `json:"id,omitempty"`
	Name                string            `json:"name"`
	ThreadID            string            `json:"thread_id,omitempty"`
	Args                map[string]string `json:"args,omitempty"`
	Reason              string            `json:"reason,omitempty"`
	Ms                  int64             `json:"ms"`
	OK                  bool              `json:"ok"`
	Completed           bool              `json:"completed"`
	Result              string            `json:"result,omitempty"`
	ResultOriginalBytes int               `json:"result_original_bytes,omitempty"`
	ResultContextBytes  int               `json:"result_context_bytes,omitempty"`
	ResultPreviewBytes  int               `json:"result_preview_bytes,omitempty"`
	ResultImageBytes    int               `json:"result_image_bytes,omitempty"`
	ResultTruncated     bool              `json:"result_truncated,omitempty"`
}

type TokenSummary struct {
	Prompt     int `json:"prompt"`
	Completion int `json:"completion"`
	Total      int `json:"total"`
}

type AssertResult struct {
	Clause   string `json:"clause"`
	Category string `json:"category,omitempty"`
	OK       bool   `json:"ok"`
	Got      any    `json:"got,omitempty"`
	Want     any    `json:"want,omitempty"`
	Note     string `json:"note,omitempty"`
}

func cmdTest(args []string) int {
	ctx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stopSignals()

	fs := flag.NewFlagSet("test", flag.ExitOnError)
	serverAddr := fs.String("server", "", "use an existing apteva-server at this address (default: spawn a clean one in a temp dir)")
	projectID := fs.String("project-id", "", "existing project to use with --server (default: create and remove an isolated test project)")
	provider := fs.String("provider", "", "LLM provider name (e.g. opencode-go); default: whatever the spawned server picks up from env")
	appDir := fs.String("app-dir", ".", "path to the app under test (used when scenarios omit setup.app.path)")
	timeoutFlag := fs.Duration("timeout", 90*time.Second, "default per-scenario timeout")
	maxBudgetUSD := fs.Float64("max-budget-usd", 0, "abort when cumulative cost exceeds this (0 = unbounded)")
	artifactsDir := fs.String("artifacts-dir", ".apteva-test-artifacts", "directory for failed-run telemetry and logs")
	verbose := fs.Bool("v", false, "verbose: stream telemetry events as they arrive")
	jsonOut := fs.Bool("json", false, "emit machine-readable results to stdout")
	tierFlag := fs.String("tier", "3", "test tier(s): 1, 2, 3, all, or a comma-separated list (default: 3)")
	profile := fs.String("profile", "", "Tier 2 profile (for example: live-carrier)")
	fs.Parse(args)

	if fs.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: apteva test [flags] <app-dir-or-scenarios-dir-or-file>")
		fs.Usage()
		return 2
	}
	target := fs.Arg(0)
	tiers, err := parseTestTiers(*tierFlag)
	if err != nil {
		fmt.Fprintf(os.Stderr, "test tiers: %v\n", err)
		return 2
	}
	if strings.TrimSpace(*profile) != "" && !tiers[2] {
		fmt.Fprintln(os.Stderr, "test profile: --profile requires Tier 2")
		return 2
	}

	opts := testOpts{
		ctx:          ctx,
		target:       target,
		serverAddr:   *serverAddr,
		serverAPIKey: resolveTestServerAPIKey(*serverAddr),
		projectID:    *projectID,
		provider:     *provider,
		appDir:       *appDir,
		timeout:      *timeoutFlag,
		maxBudgetUSD: *maxBudgetUSD,
		artifactsDir: *artifactsDir,
		verbose:      *verbose,
		jsonOutput:   *jsonOut,
	}

	nativeResults := []NativeTestResult{}
	nativeOK := true
	if tiers[1] || tiers[2] {
		appPath, err := resolveNativeAppDir(target, *appDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "native tests: %v\n", err)
			return 2
		}
		nativeResults, nativeOK = runNativeTests(ctx, appPath, *profile, tiers, *jsonOut, os.Stderr)
		if !nativeOK || !tiers[3] {
			printNativeTestOutcome(nativeResults, nativeOK, *jsonOut, os.Stdout, os.Stderr)
			if nativeOK {
				return 0
			}
			return 1
		}
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
	allOK := nativeOK
	for _, s := range scenarios {
		fmt.Fprintf(os.Stderr, "▶ %s\n", s.Name)
		res := runScenarioEvaluation(server, s, opts)
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
		if ctx.Err() != nil {
			allOK = false
			break
		}
	}

	if opts.jsonOutput {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
			"native_results":  nativeResults,
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

func runScenarioEvaluation(server *testServer, s Scenario, opts testOpts) ScenarioResult {
	runs := s.Runs
	if runs <= 0 {
		runs = 1
	}
	required := s.RequiredPassRate
	if required <= 0 {
		required = 1
	}
	if required > 1 {
		required = 1
	}

	attempts := make([]ScenarioResult, 0, runs)
	for run := 1; run <= runs; run++ {
		if runs > 1 {
			fmt.Fprintf(os.Stderr, "  run %d/%d\n", run, runs)
		}
		runScenarioInput, err := cloneScenario(s)
		if err != nil {
			attempts = append(attempts, ScenarioResult{
				Name: s.Name, Run: run, RunCount: runs, BudgetOK: true,
				Error: fmt.Sprintf("clone scenario for run: %v", err),
			})
			continue
		}
		attempt := runScenario(server, runScenarioInput, opts)
		attempt.Run = run
		attempt.RunCount = runs
		if !attempt.OK {
			attempt.ArtifactsDir = writeFailureArtifacts(opts, server, s, attempt)
		}
		attempts = append(attempts, attempt)
		if runs > 1 {
			printSummary(os.Stderr, attempt, opts.verbose)
		}
	}

	if runs == 1 {
		result := attempts[0]
		result.PassCount = boolInt(result.OK)
		result.PassRate = float64(result.PassCount)
		result.RequiredPassRate = required
		return result
	}

	aggregate := ScenarioResult{
		Name: s.Name, RunCount: runs, RequiredPassRate: required,
		BudgetOK: true, Attempts: attempts,
	}
	for _, attempt := range attempts {
		aggregate.ElapsedMs += attempt.ElapsedMs
		aggregate.Iterations += attempt.Iterations
		aggregate.ToolCalls = append(aggregate.ToolCalls, attempt.ToolCalls...)
		aggregate.Tokens.Prompt += attempt.Tokens.Prompt
		aggregate.Tokens.Completion += attempt.Tokens.Completion
		aggregate.Tokens.Total += attempt.Tokens.Total
		aggregate.CostUSD += attempt.CostUSD
		aggregate.BudgetOK = aggregate.BudgetOK && attempt.BudgetOK
		if attempt.OK {
			aggregate.PassCount++
		}
	}
	aggregate.PassRate = float64(aggregate.PassCount) / float64(runs)
	aggregate.OK = aggregate.PassRate >= required
	if !aggregate.OK {
		aggregate.Error = fmt.Sprintf("pass rate %.0f%% is below required %.0f%%", aggregate.PassRate*100, required*100)
	}
	return aggregate
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func cloneScenario(s Scenario) (Scenario, error) {
	body, err := yaml.Marshal(s)
	if err != nil {
		return Scenario{}, err
	}
	var clone Scenario
	if err := yaml.Unmarshal(body, &clone); err != nil {
		return Scenario{}, err
	}
	clone.SourceDir = s.SourceDir
	clone.SourcePath = s.SourcePath
	for i := range clone.Assert {
		clone.Assert[i].Category = "assert"
	}
	for i := range clone.OutcomeAssert {
		clone.OutcomeAssert[i].Category = "outcome"
	}
	for i := range clone.TrajectoryAssert {
		clone.TrajectoryAssert[i].Category = "trajectory"
	}
	return clone, nil
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
		s.SourcePath = abs
	} else {
		s.SourceDir = filepath.Dir(path)
		s.SourcePath = path
	}
	for i := range s.Assert {
		s.Assert[i].Category = "assert"
	}
	for i := range s.OutcomeAssert {
		s.OutcomeAssert[i].Category = "outcome"
	}
	for i := range s.TrajectoryAssert {
		s.TrajectoryAssert[i].Category = "trajectory"
	}
	if s.RequiredPassRate < 0 || s.RequiredPassRate > 1 {
		return Scenario{}, fmt.Errorf("required_pass_rate must be between 0 and 1")
	}
	if err := expandScenarioEnvironment(&s); err != nil {
		return Scenario{}, err
	}
	return s, nil
}

func expandScenarioEnvironment(s *Scenario) error {
	values := map[string]string{}
	for _, name := range s.Setup.RequiredEnv {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		value, ok := os.LookupEnv(name)
		if !ok || strings.TrimSpace(value) == "" {
			return fmt.Errorf("required environment variable %s is not set", name)
		}
		values[name] = value
	}
	replace := func(value string) string {
		for name, replacement := range values {
			value = strings.ReplaceAll(value, "${"+name+"}", replacement)
		}
		return value
	}
	replaceScenarioValues(s, replace)
	return nil
}

func expandScenarioRuntime(s *Scenario, values map[string]string) {
	replace := func(value string) string {
		for name, replacement := range values {
			value = strings.ReplaceAll(value, "${"+name+"}", replacement)
		}
		return value
	}
	replaceScenarioValues(s, replace)
}

func replaceScenarioValues(s *Scenario, replace func(string) string) {
	s.Directive = replace(s.Directive)
	s.Prompt = replace(s.Prompt)
	if s.Setup.Thread != nil {
		s.Setup.Thread.ID = replace(s.Setup.Thread.ID)
		s.Setup.Thread.Directive = replace(s.Setup.Thread.Directive)
		for i := range s.Setup.Thread.Tools {
			s.Setup.Thread.Tools[i] = replace(s.Setup.Thread.Tools[i])
		}
		for i := range s.Setup.Thread.MCP {
			s.Setup.Thread.MCP[i] = replace(s.Setup.Thread.MCP[i])
		}
	}
	for _, calls := range [][]SeedMCPCallSpec{s.Setup.SeedMCPCalls, s.Setup.CleanupMCPCalls} {
		for i := range calls {
			call := &calls[i]
			call.App = replace(call.App)
			call.Tool = replace(call.Tool)
			call.ThreadID = replace(call.ThreadID)
			if call.Args != nil {
				call.Args = replaceStringValues(call.Args, replace).(map[string]any)
			}
		}
	}
	for _, group := range [][]AssertClause{s.Assert, s.OutcomeAssert, s.TrajectoryAssert} {
		for i := range group {
			group[i].HTTP = replace(group[i].HTTP)
			group[i].ResponseContains = replace(group[i].ResponseContains)
			group[i].AgentResponseContains = replace(group[i].AgentResponseContains)
			group[i].ResponseMatches = replace(group[i].ResponseMatches)
			group[i].AgentResponseMatches = replace(group[i].AgentResponseMatches)
			group[i].ChatResponseContains = replace(group[i].ChatResponseContains)
			group[i].ChatResponseMatches = replace(group[i].ChatResponseMatches)
			group[i].ThreadID = replace(group[i].ThreadID)
			group[i].ExpectFieldEq = replaceStringValue(group[i].ExpectFieldEq, replace)
			if group[i].ExpectItem != nil {
				group[i].ExpectItem = replaceStringValues(group[i].ExpectItem, replace).(map[string]any)
			}
			for _, match := range []*ToolCallAssertion{group[i].ToolCalledWith, group[i].ToolNotCalledWith} {
				if match == nil {
					continue
				}
				match.ThreadID = replace(match.ThreadID)
				for key, value := range match.Args {
					match.Args[key] = replaceStringValue(value, replace)
				}
			}
		}
	}
}

func replaceStringValue(value any, replace func(string) string) any {
	if text, ok := value.(string); ok {
		return replace(text)
	}
	return value
}

func replaceStringValues(value any, replace func(string) string) any {
	switch typed := value.(type) {
	case string:
		return replace(typed)
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = replaceStringValues(item, replace)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = replaceStringValues(item, replace)
		}
		return out
	default:
		return value
	}
}

func scenarioInitialPace(spec *InitialWakeSpec, now time.Time) (map[string]any, time.Time, error) {
	if spec == nil {
		return nil, time.Time{}, nil
	}
	after, err := time.ParseDuration(strings.TrimSpace(spec.After))
	if err != nil || after <= 0 {
		return nil, time.Time{}, fmt.Errorf("after must be a positive duration")
	}
	if after > 24*time.Hour {
		return nil, time.Time{}, fmt.Errorf("after must not exceed 24h")
	}
	sleep := strings.TrimSpace(spec.Sleep)
	if sleep == "" {
		sleep = after.String()
	}
	if parsed, err := time.ParseDuration(sleep); err != nil || parsed <= 0 || parsed > 24*time.Hour {
		return nil, time.Time{}, fmt.Errorf("sleep must be a positive duration no greater than 24h")
	}
	wakeAt := now.UTC().Add(after)
	return map[string]any{
		"sleep":        sleep,
		"next_wake_at": wakeAt.Format(time.RFC3339Nano),
	}, wakeAt, nil
}

func seedScenarioMCPCalls(calls []SeedMCPCallSpec, sidecars map[string]string, agentID int64, projectID string) error {
	for i, call := range calls {
		appName := strings.TrimSpace(call.App)
		tool := strings.TrimSpace(call.Tool)
		threadID := strings.TrimSpace(call.ThreadID)
		if appName == "" || tool == "" || threadID == "" {
			return fmt.Errorf("call %d requires app, tool, and thread_id", i+1)
		}
		sidecarURL := strings.TrimSpace(sidecars[appName])
		if sidecarURL == "" {
			return fmt.Errorf("call %d targets app %q but no local sidecar is available", i+1, appName)
		}
		if err := callPeerMCPAs(sidecarURL, tool, call.Args, agentID, threadID, projectID); err != nil {
			return fmt.Errorf("call %d %s.%s: %w", i+1, appName, tool, err)
		}
	}
	return nil
}

func scenarioAssertions(s Scenario) []AssertClause {
	out := make([]AssertClause, 0, len(s.Assert)+len(s.OutcomeAssert)+len(s.TrajectoryAssert))
	out = append(out, s.Assert...)
	out = append(out, s.OutcomeAssert...)
	out = append(out, s.TrajectoryAssert...)
	return out
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
		if opts.serverAPIKey == "" {
			return nil, fmt.Errorf("--server requires owner authentication: set APTEVA_TEST_SERVER_API_KEY or use an active Apteva config containing api_key")
		}
		srv := &testServer{addr: opts.serverAddr, apiKey: opts.serverAPIKey}
		var projectID string
		var err error
		if strings.TrimSpace(opts.projectID) == "" {
			projectID, err = createTestProject(srv)
			if err == nil {
				srv.teardown = func() { deleteTestProject(srv, projectID) }
			}
		} else {
			projectID, err = resolveTestProject(srv, opts.projectID)
		}
		if err != nil {
			return nil, fmt.Errorf("prepare existing server: %w", err)
		}
		srv.projectID = projectID
		if err := verifyServerProvider(srv, opts.provider); err != nil {
			if srv.teardown != nil {
				srv.teardown()
				srv.teardown = nil
			}
			return nil, err
		}
		fmt.Fprintf(os.Stderr, "using apteva-server at %s (project: %s; provider credentials stay server-side)\n", opts.serverAddr, projectID)
		return srv, nil
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
	if err := provisionSpawnedTestProvider(srv, opts.provider, baseEnv); err != nil {
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("configure test provider: %w", err)
	}
	fmt.Fprintf(os.Stderr, "spawned apteva-server at %s (data: %s, project: %s)\n", addr, dataDir, pid)
	return srv, nil
}

// provisionSpawnedTestProvider bridges the test runner's environment-based
// credential input to Server's connection-backed runtime provider model. It
// only applies to the clean, disposable Server created by apteva test;
// existing-server runs always use the operator's already configured
// connections and never receive credentials from the runner.
func provisionSpawnedTestProvider(server *testServer, requested string, env []string) error {
	provider := normalizeProviderName(requested)
	if provider == "" {
		return nil
	}

	var credentials map[string]string
	switch provider {
	case "openai-codex":
		accessToken := envValue(env, "OPENAI_CODEX_ACCESS_TOKEN")
		if accessToken == "" {
			return fmt.Errorf("openai-codex requires OPENAI_CODEX_ACCESS_TOKEN in the environment or ~/.apteva/test.env")
		}
		credentials = map[string]string{"access_token": accessToken}
		if accountID := envValue(env, "OPENAI_CODEX_ACCOUNT_ID"); accountID != "" {
			credentials["account_id"] = accountID
		}
	default:
		// Other providers retain their existing Server bootstrap behavior.
		// Add a connection-backed adapter here when their runtime catalog is
		// migrated away from legacy environment discovery.
		return nil
	}

	autoMCP := false
	body, err := json.Marshal(map[string]any{
		"source":      "local",
		"app_slug":    provider,
		"name":        "Tier 3 " + provider,
		"auth_type":   "bearer",
		"credentials": credentials,
		"project_id":  server.projectID,
		"created_via": "app_install",
		"auto_mcp":    autoMCP,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, "http://"+server.addr+"/api/connections", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("create %s runtime connection: HTTP %d: %s", provider, resp.StatusCode, tcTruncate(string(raw), 200))
	}
	return nil
}

func createTestProject(server *testServer) (string, error) {
	name := fmt.Sprintf("Tier 3 test %s", time.Now().Format("20060102-150405"))
	body, _ := json.Marshal(map[string]string{
		"name": name, "description": "Temporary project created by apteva test", "color": "#64748b",
	})
	req, _ := http.NewRequest(http.MethodPost, "http://"+server.addr+"/api/projects", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("create isolated project: HTTP %d: %s", resp.StatusCode, tcTruncate(string(raw), 200))
	}
	var project struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&project); err != nil {
		return "", err
	}
	if project.ID == "" {
		return "", fmt.Errorf("create isolated project returned no id")
	}
	return project.ID, nil
}

func deleteTestProject(server *testServer, projectID string) {
	if projectID == "" {
		return
	}
	req, _ := http.NewRequest(http.MethodDelete, "http://"+server.addr+"/api/projects/"+url.PathEscape(projectID), nil)
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err == nil {
		resp.Body.Close()
	}
}

func resolveTestServerAPIKey(serverAddr string) string {
	if serverAddr == "" {
		return ""
	}
	if key := strings.TrimSpace(os.Getenv("APTEVA_TEST_SERVER_API_KEY")); key != "" {
		return key
	}
	return strings.TrimSpace(loadAptevaConfig().APIKey)
}

func resolveTestProject(server *testServer, requested string) (string, error) {
	req, _ := http.NewRequest(http.MethodGet, "http://"+server.addr+"/api/projects", nil)
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("GET /api/projects returned %d: %s", resp.StatusCode, tcTruncate(string(body), 200))
	}
	var projects []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&projects); err != nil {
		return "", err
	}
	if len(projects) == 0 {
		return "", fmt.Errorf("authenticated user has no projects")
	}
	candidate := strings.TrimSpace(requested)
	if candidate == "" {
		candidate = strings.TrimSpace(loadAptevaConfig().ProjectID)
	}
	if candidate != "" {
		for _, project := range projects {
			if project.ID == candidate || strings.EqualFold(project.Name, candidate) {
				return project.ID, nil
			}
		}
		return "", fmt.Errorf("project %q is not accessible", candidate)
	}
	return projects[0].ID, nil
}

func verifyServerProvider(server *testServer, requested string) error {
	want := normalizeProviderName(requested)
	found, err := legacyServerHasProvider(server, want)
	if err != nil {
		// Servers past the providers→connections migration removed
		// /api/providers (410, or a redirect onto dashboard HTML).
		found, err = serverHasLLMConnection(server, want)
	}
	if err != nil {
		return err
	}
	if found {
		return nil
	}
	if want != "" {
		return fmt.Errorf("LLM provider %q is not configured for project %s", requested, server.projectID)
	}
	return fmt.Errorf("no LLM provider is configured for project %s", server.projectID)
}

func legacyServerHasProvider(server *testServer, want string) (bool, error) {
	endpoint := "http://" + server.addr + "/api/providers?project_id=" + url.QueryEscape(server.projectID)
	req, _ := http.NewRequest(http.MethodGet, endpoint, nil)
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, fmt.Errorf("list existing-server providers: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return false, fmt.Errorf("list existing-server providers: HTTP %d: %s", resp.StatusCode, tcTruncate(string(body), 200))
	}
	var providers []struct {
		Type   string `json:"type"`
		Name   string `json:"name"`
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&providers); err != nil {
		return false, fmt.Errorf("decode existing-server providers: %w", err)
	}
	for _, provider := range providers {
		name := normalizeProviderName(provider.Name)
		isLLM := strings.EqualFold(provider.Type, "llm") || knownLLMProvider(name)
		if isLLM && !strings.EqualFold(provider.Status, "disabled") && (want == "" || name == want) {
			return true, nil
		}
	}
	return false, nil
}

func serverHasLLMConnection(server *testServer, want string) (bool, error) {
	endpoint := "http://" + server.addr + "/api/connections/runtime"
	req, _ := http.NewRequest(http.MethodGet, endpoint, nil)
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, fmt.Errorf("list existing-server connections: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return false, fmt.Errorf("list existing-server connections: HTTP %d: %s", resp.StatusCode, tcTruncate(string(body), 200))
	}
	var connections []struct {
		Name         string   `json:"name"`
		AppSlug      string   `json:"app_slug"`
		Role         string   `json:"role"`
		Capabilities []string `json:"capabilities"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&connections); err != nil {
		return false, fmt.Errorf("decode existing-server connections: %w", err)
	}
	for _, connection := range connections {
		isLLM := strings.EqualFold(connection.Role, "llm")
		for _, capability := range connection.Capabilities {
			isLLM = isLLM || strings.EqualFold(capability, "llm")
		}
		if !isLLM {
			continue
		}
		if want == "" || normalizeProviderName(connection.AppSlug) == want || normalizeProviderName(connection.Name) == want {
			return true, nil
		}
	}
	return false, nil
}

func normalizeProviderName(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, "_", "-")
	value = strings.ReplaceAll(value, " ", "-")
	return value
}

func knownLLMProvider(value string) bool {
	switch value {
	case "fireworks", "openai", "openai-codex", "anthropic", "google", "ollama", "nvidia", "opencode-go", "venice":
		return true
	default:
		return false
	}
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
	res = ScenarioResult{Name: s.Name, BudgetOK: true}
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

	appName := manifestNameFromYAML(manifestYAML)
	if appName == "" {
		appName = "app"
	}

	var (
		deps          []depBundle
		installed     *installResp
		sidecarURL    string
		sidecarsByApp = map[string]string{}
		mcpServers    []map[string]any
		localRelays   []*scopedAppMCPRelay
	)
	if s.Setup.App.ReuseExisting {
		if opts.serverAddr == "" || strings.TrimSpace(opts.projectID) == "" {
			res.Error = "setup.app.reuse_existing requires --server and an explicit --project-id"
			return res
		}
		if len(s.Setup.App.Config) > 0 || len(s.Setup.App.Env) > 0 || len(s.Setup.App.Bindings) > 0 || len(s.Setup.Fixtures) > 0 {
			res.Error = "setup.app.reuse_existing cannot use app config, app env, app bindings, or fixtures"
			return res
		}
		installed, err = findExistingAppInstall(server, appName)
		if err != nil {
			res.Error = fmt.Sprintf("reuse existing app: %v", err)
			return res
		}
		relay, relayErr := startScopedAppMCPRelay(server, appName, installed.InstallID)
		if relayErr != nil {
			res.Error = fmt.Sprintf("start app MCP relay: %v", relayErr)
			return res
		}
		defer relay.Close()
		mcpServers = append(mcpServers, scenarioAppMCPConfig(appName, relay.URL, s.Setup.App.Spawnable))
	} else {
		// Install + spawn dependent apps first. The manifest's
		// requires.apps lists peer apps the unit under test calls over
		// HTTP. Each local sidecar is removed after the run.
		var appBindings map[string]any
		deps, appBindings, err = installDeps(server, appDir, manifestYAML, s.Setup.App.Bindings)
		if err != nil {
			res.Error = fmt.Sprintf("install deps: %v", err)
			return res
		}
		defer func() {
			for i := len(localRelays) - 1; i >= 0; i-- {
				localRelays[i].Close()
			}
			for i := len(deps) - 1; i >= 0; i-- {
				deps[i].sidecar.Stop()
				uninstallApp(server, deps[i].installID)
			}
		}()

		installed, err = installApp(server, manifestYAML, appDir, server.projectID, s.Setup.App.Config, appBindings)
		if err != nil {
			res.Error = fmt.Sprintf("install app: %v", err)
			return res
		}
		defer uninstallApp(server, installed.InstallID)

		sidecar, spawnErr := spawnLocalSidecar(appDir, installed.InstallID, server.projectID, s.Setup.App.Config, s.Setup.App.Env, "http://"+server.addr)
		if spawnErr != nil {
			res.Error = fmt.Sprintf("spawn local sidecar: %v", spawnErr)
			return res
		}
		defer sidecar.Stop()
		sidecarURL = sidecar.URL
		if err := setSidecarURL(server, installed.InstallID, sidecarURL); err != nil {
			res.Error = fmt.Sprintf("set sidecar url: %v", err)
			return res
		}

		// Pre-upload fixtures before the agent starts. Fixtures call MCP
		// tools on the peer apps directly, with file bytes as base64.
		sidecarsByApp[appName] = sidecarURL
		for _, d := range deps {
			sidecarsByApp[d.name] = d.sidecar.URL
		}
		if err := loadFixtures(s.Setup.Fixtures, s.SourceDir, server.projectID, sidecarsByApp); err != nil {
			res.Error = fmt.Sprintf("load fixtures: %v", err)
			return res
		}

		appRelay, relayErr := startScopedAppMCPRelay(server, appName, installed.InstallID)
		if relayErr != nil {
			res.Error = fmt.Sprintf("start app MCP relay: %v", relayErr)
			return res
		}
		localRelays = append(localRelays, appRelay)
		mcpServers = append(mcpServers, scenarioAppMCPConfig(appName, appRelay.URL, s.Setup.App.Spawnable))
		for _, d := range deps {
			depRelay, relayErr := startScopedAppMCPRelay(server, d.name, d.installID)
			if relayErr != nil {
				res.Error = fmt.Sprintf("start %s MCP relay: %v", d.name, relayErr)
				return res
			}
			localRelays = append(localRelays, depRelay)
			mcpServers = append(mcpServers, map[string]any{
				"name": d.name, "transport": "http", "url": depRelay.URL, "main_access": false, "no_spawn": true,
			})
		}
	}
	fakeMCPServers, fakeMCPConfigs, err := startScenarioFakeMCPServers(s.Setup.FakeMCPs)
	if err != nil {
		res.Error = fmt.Sprintf("start fake MCP servers: %v", err)
		return res
	}
	defer func() {
		for _, server := range fakeMCPServers {
			server.Close()
		}
	}()
	mcpServers = append(mcpServers, fakeMCPConfigs...)

	// Pick the project the agent runs in. testServer fetched it at
	// bootstrap so every scenario shares the same one — keeps the
	// CRM's per-project data isolated by run, not per-scenario.
	projectID := server.projectID
	initialPace, wakeAt, err := scenarioInitialPace(s.Setup.InitialWake, time.Now().UTC())
	if err != nil {
		res.Error = fmt.Sprintf("initial wake: %v", err)
		return res
	}
	runtimeValues := map[string]string{
		"APTEVA_TEST_APP_URL":    sidecarURL,
		"APTEVA_TEST_SERVER_URL": "http://" + server.addr,
		"APTEVA_TEST_PROJECT_ID": projectID,
		"APTEVA_TEST_APP_NAME":   appName,
		"APTEVA_TEST_INSTALL_ID": strconv.FormatInt(installed.InstallID, 10),
	}
	if !wakeAt.IsZero() {
		runtimeValues["APTEVA_TEST_WAKE_AT"] = wakeAt.Format(time.RFC3339Nano)
	}
	expandScenarioRuntime(&s, runtimeValues)
	interaction := strings.ToLower(strings.TrimSpace(s.Setup.Interaction))
	if interaction == "" {
		interaction = "autonomous"
	}
	if interaction != "autonomous" && interaction != "thread" && interaction != "conversation" {
		res.Error = fmt.Sprintf("unsupported setup.interaction %q", s.Setup.Interaction)
		return res
	}
	if (interaction == "thread" || interaction == "conversation") && strings.TrimSpace(s.Prompt) == "" {
		res.Error = fmt.Sprintf("setup.interaction=%s requires prompt", interaction)
		return res
	}
	if interaction == "thread" && s.Setup.Thread == nil {
		res.Error = "setup.interaction=thread requires setup.thread"
		return res
	}

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
	includeChannels := interaction == "conversation"
	inst, err := tcCreateInstance(server, projectID, s.Name, s.Directive, mode, opts.provider, mcpServers, []int64{installed.InstallID}, includeChannels, initialPace)
	if err != nil {
		res.Error = fmt.Sprintf("create instance: %v", err)
		return res
	}
	// Skip per-instance deletion when keep-data debug is on so the
	// agent's history/main.jsonl survives for inspection.
	if os.Getenv("APTEVA_TEST_KEEP") == "" {
		defer tcDeleteInstance(server, inst.ID)
	}
	expandScenarioRuntime(&s, map[string]string{
		"APTEVA_TEST_AGENT_ID": strconv.FormatInt(inst.ID, 10),
	})

	// Write the instance's config.json with our mcp_servers BEFORE
	// starting the agent. instances.go's Start() reads disk first
	// then merges system entries; the body.config field on POST
	// /api/instances only carries server-side flags (include_apteva_
	// server, etc.), not the agent's tool list. The on-disk
	// config.json is the single source of truth core consumes.
	if err := writeInstanceDiskConfig(server, inst.ID, s.Directive, mode, opts.provider, mcpServers, includeChannels, initialPace); err != nil {
		res.Error = fmt.Sprintf("write instance config.json: %v", err)
		return res
	}
	if err := seedScenarioMCPCalls(s.Setup.SeedMCPCalls, sidecarsByApp, inst.ID, projectID); err != nil {
		res.Error = fmt.Sprintf("seed MCP calls: %v", err)
		return res
	}
	if len(s.Setup.CleanupMCPCalls) > 0 && os.Getenv("APTEVA_TEST_KEEP") == "" {
		defer func() {
			if cleanupErr := seedScenarioMCPCalls(s.Setup.CleanupMCPCalls, sidecarsByApp, inst.ID, projectID); cleanupErr != nil {
				res.OK = false
				if res.Error == "" {
					res.Error = "cleanup MCP calls: " + cleanupErr.Error()
				} else {
					res.Error += "; cleanup MCP calls: " + cleanupErr.Error()
				}
			}
		}()
	}

	parentCtx := opts.ctx
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	ctx, cancel := context.WithTimeout(parentCtx, timeout)
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
	// Now subscribe. A persisted-telemetry poll below reconciles events
	// emitted before the SSE connection opens or after a live stream drops.
	telemetry, errCh, _ := streamTelemetry(ctx, server, inst.ID)

	conversationID := ""
	if interaction == "thread" {
		threadID := strings.TrimSpace(s.Setup.Thread.ID)
		if threadID == "" {
			threadID = "scenario-request"
		}
		expandScenarioRuntime(&s, map[string]string{
			"APTEVA_TEST_THREAD_ID":         threadID,
			"APTEVA_TEST_DEFAULT_THREAD_ID": "main",
		})
		if err := startScenarioThread(server, inst.ID, *s.Setup.Thread, s.Prompt); err != nil {
			res.Error = fmt.Sprintf("start scenario thread: %v", err)
			return res
		}
	} else if interaction == "conversation" {
		conversation, err := openScenarioConversation(server, inst.ID, s.Name)
		if err != nil {
			res.Error = fmt.Sprintf("open conversation: %v", err)
			return res
		}
		defer conversation.Close(server)
		conversationID = conversation.ID
		expandScenarioRuntime(&s, map[string]string{
			"APTEVA_TEST_CONVERSATION_ID":        conversation.ID,
			"APTEVA_TEST_CONVERSATION_THREAD_ID": conversation.ThreadID,
			"APTEVA_TEST_DEFAULT_THREAD_ID":      "main",
		})
		if err := postScenarioConversation(server, conversation.ID, s.Prompt); err != nil {
			res.Error = fmt.Sprintf("post conversation prompt: %v", err)
			return res
		}
	}
	assertions := scenarioAssertions(s)

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
	settleFor := time.Duration(0)
	if strings.TrimSpace(s.SettleFor) != "" {
		parsed, parseErr := time.ParseDuration(s.SettleFor)
		if parseErr != nil || parsed < 0 {
			res.Error = fmt.Sprintf("invalid settle_for %q", s.SettleFor)
			return res
		}
		settleFor = parsed
	}
	assertPoll := time.NewTicker(500 * time.Millisecond)
	defer assertPoll.Stop()
	telemetryPoll := time.NewTicker(2 * time.Second)
	defer telemetryPoll.Stop()
	stopReason := ""
	var assertsPassingSince time.Time
	seenTelemetry := map[string]struct{}{}
	probeNow := func() {
		if !probeAsserts(server, installed.InstallID, sidecarURL, conversationID, assertions, &res) {
			assertsPassingSince = time.Time{}
			return
		}
		if settleFor == 0 {
			stopReason = "asserts passed"
			return
		}
		if assertsPassingSince.IsZero() {
			assertsPassingSince = time.Now()
			return
		}
		if time.Since(assertsPassingSince) >= settleFor {
			stopReason = "asserts remained stable for " + settleFor.String()
		}
	}
	processTelemetry := func(ev telemetryEvent) {
		if !acceptTelemetry(&res, ev, seenTelemetry) {
			return
		}
		if opts.verbose {
			fmt.Fprintf(os.Stderr, "  · %s\n", ev.Type)
		} else if ev.Type == "tool.call" {
			if name, ok := ev.Data["name"].(string); ok {
				fmt.Fprintf(os.Stderr, "    · %d %s\n", res.Iterations, name)
			}
		}
		if ev.Type == "tool.result" {
			probeNow()
		}
		if scenarioIterationLimitReached(&res, maxIter) {
			stopReason = fmt.Sprintf("max_iterations (%d) reached", maxIter)
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
			processTelemetry(ev)
		case err := <-errCh:
			if opts.verbose {
				fmt.Fprintf(os.Stderr, "  telemetry err: %v\n", err)
			}
		case <-assertPoll.C:
			probeNow()
		case <-telemetryPoll.C:
			events, fetchErr := fetchStoredTelemetry(server, inst.ID, start.Add(-time.Second))
			if fetchErr != nil {
				if opts.verbose {
					fmt.Fprintf(os.Stderr, "  telemetry reconcile err: %v\n", fetchErr)
				}
				break
			}
			for _, ev := range events {
				processTelemetry(ev)
				if stopReason != "" {
					break
				}
			}
		case <-ctx.Done():
			stopReason = "cancelled"
		}
		if stopReason != "" {
			break
		}
	}
	cancel()
	if stopReason == "" {
		stopReason = "timeout"
	}
	if stopReason == "cancelled" {
		res.Error = "scenario cancelled"
	}

	// Stop the agent so the next scenario starts clean.
	_ = stopInstanceAPI(server, inst.ID)

	// Run asserts.
	res.ElapsedMs = time.Since(start).Milliseconds()
	res.Asserts = runAsserts(server, installed.InstallID, sidecarURL, conversationID, assertions, &res)

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
	Type     string         `json:"type"`
	ThreadID string         `json:"thread_id,omitempty"`
	Data     map[string]any `json:"data"`
}

func acceptTelemetry(res *ScenarioResult, ev telemetryEvent, seen map[string]struct{}) bool {
	raw, err := json.Marshal(ev)
	if err == nil {
		fingerprint := string(raw)
		if _, duplicate := seen[fingerprint]; duplicate {
			return false
		}
		seen[fingerprint] = struct{}{}
	}
	res.telemetry = append(res.telemetry, ev)
	applyTelemetry(res, ev)
	return true
}

func fetchStoredTelemetry(server *testServer, instanceID int64, since time.Time) ([]telemetryEvent, error) {
	target := fmt.Sprintf("http://%s/api/telemetry", server.addr)
	req, _ := http.NewRequest(http.MethodGet, target, nil)
	query := req.URL.Query()
	query.Set("agent_id", strconv.FormatInt(instanceID, 10))
	query.Set("since", since.UTC().Format(time.RFC3339))
	query.Set("limit", "1000")
	req.URL.RawQuery = query.Encode()
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("query telemetry: HTTP %d: %s", resp.StatusCode, tcTruncate(string(body), 200))
	}
	var events []telemetryEvent
	if err := json.NewDecoder(resp.Body).Decode(&events); err != nil {
		return nil, err
	}
	// The query API returns newest-first. Apply oldest-first so tool
	// calls precede results and iteration accounting follows execution.
	for left, right := 0, len(events)-1; left < right; left, right = left+1, right-1 {
		events[left], events[right] = events[right], events[left]
	}
	return events, nil
}

func applyTelemetry(res *ScenarioResult, ev telemetryEvent) {
	switch ev.Type {
	case "llm.done":
		res.Iterations++
		res.Tokens.Prompt += int(numberValue(ev.Data["tokens_in"]))
		res.Tokens.Completion += int(numberValue(ev.Data["tokens_out"]))
		cost := numberValue(ev.Data["cost_usd"])
		if cost == 0 {
			cost = numberValue(ev.Data["cost"])
		}
		res.CostUSD += cost
		if message, _ := ev.Data["message"].(string); strings.TrimSpace(message) != "" {
			res.AssistantResponses = append(res.AssistantResponses, message)
			if res.ThreadResponses == nil {
				res.ThreadResponses = make(map[string][]string)
			}
			res.ThreadResponses[ev.ThreadID] = append(res.ThreadResponses[ev.ThreadID], message)
		}
		res.Tokens.Total = res.Tokens.Prompt + res.Tokens.Completion
	case "tool.call":
		name, _ := ev.Data["name"].(string)
		res.ToolCalls = append(res.ToolCalls, ToolCallResult{
			ID: stringMapValue(ev.Data, "id"), Name: name, ThreadID: ev.ThreadID,
			Args: stringMap(ev.Data["args"]), Reason: stringMapValue(ev.Data, "reason"),
		})
	case "tool.result":
		name, _ := ev.Data["name"].(string)
		id := stringMapValue(ev.Data, "id")
		ok, hasOK := ev.Data["success"].(bool)
		if !hasOK {
			ok, _ = ev.Data["ok"].(bool)
		}
		// Mark the most recent matching tool call as done.
		for i := len(res.ToolCalls) - 1; i >= 0; i-- {
			if (id != "" && res.ToolCalls[i].ID == id) || (id == "" && res.ToolCalls[i].Name == name) {
				res.ToolCalls[i].Completed = true
				res.ToolCalls[i].OK = ok
				res.ToolCalls[i].Ms = int64(numberValue(ev.Data["duration_ms"]))
				res.ToolCalls[i].Result = stringMapValue(ev.Data, "result")
				res.ToolCalls[i].ResultOriginalBytes = int(numberValue(ev.Data["result_original_bytes"]))
				res.ToolCalls[i].ResultContextBytes = int(numberValue(ev.Data["result_context_bytes"]))
				res.ToolCalls[i].ResultPreviewBytes = int(numberValue(ev.Data["result_preview_bytes"]))
				res.ToolCalls[i].ResultImageBytes = int(numberValue(ev.Data["result_image_bytes"]))
				res.ToolCalls[i].ResultTruncated, _ = ev.Data["result_truncated"].(bool)
				// Explicit Core request threads commonly return their final
				// answer to the parent with send instead of populating
				// llm.done.message. Treat a successfully delivered message as
				// that originating thread's response without mixing worker
				// messages into unscoped assistant-response assertions.
				if ok && name == "send" {
					appendThreadResponse(res, ev.ThreadID, res.ToolCalls[i].Args["message"])
				}
				break
			}
		}
	}
}

func appendThreadResponse(res *ScenarioResult, threadID, message string) {
	if strings.TrimSpace(message) == "" {
		return
	}
	if res.ThreadResponses == nil {
		res.ThreadResponses = make(map[string][]string)
	}
	res.ThreadResponses[threadID] = append(res.ThreadResponses[threadID], message)
}

func scenarioIterationLimitReached(res *ScenarioResult, maxIterations int) bool {
	if res == nil || maxIterations <= 0 || res.Iterations < maxIterations {
		return false
	}
	for _, call := range res.ToolCalls {
		if !call.Completed {
			return false
		}
	}
	return true
}

func numberValue(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case float32:
		return float64(n)
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		f, _ := n.Float64()
		return f
	default:
		return 0
	}
}

func stringMapValue(m map[string]any, key string) string {
	v, _ := m[key].(string)
	return v
}

func stringMap(v any) map[string]string {
	out := map[string]string{}
	switch values := v.(type) {
	case map[string]any:
		for key, value := range values {
			if s, ok := value.(string); ok {
				out[key] = s
			} else if raw, err := json.Marshal(value); err == nil {
				out[key] = string(raw)
			}
		}
	case map[string]string:
		for key, value := range values {
			out[key] = value
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
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
func probeAsserts(server *testServer, installID int64, sidecarURL, conversationID string, clauses []AssertClause, res *ScenarioResult) bool {
	if len(clauses) == 0 {
		return false
	}
	terminal := 0
	for _, c := range clauses {
		switch {
		case c.HTTP != "":
			terminal++
			if !assertHTTP(server, installID, sidecarURL, c).OK {
				return false
			}
		case c.ToolCalled != "":
			terminal++
			if !assertToolCalled(c, res).OK {
				return false
			}
		case c.ToolCalledWith != nil:
			terminal++
			if !assertToolCallMatch(c.ToolCalledWith, false, res).OK {
				return false
			}
		case responsePattern(c) != "":
			terminal++
			if !assertResponseMatches(c, res).OK {
				return false
			}
		case responseNeedle(c) != "":
			terminal++
			if !assertResponseContains(c, res).OK {
				return false
			}
		case c.ChatResponseMatches != "":
			terminal++
			if !assertChatResponse(server, conversationID, c, true).OK {
				return false
			}
		case c.ChatResponseContains != "":
			terminal++
			if !assertChatResponse(server, conversationID, c, false).OK {
				return false
			}
		case c.ChatFinalMessages != nil:
			if !assertChatFinalMessages(server, conversationID, *c.ChatFinalMessages).OK {
				return false
			}
		case c.IterationsAtMost > 0, c.FinishedWithin != "", c.ToolNotCalled != "", c.ToolNotCalledWith != nil:
			// Limits and negative assertions are final checks, not evidence
			// that the requested work has completed.
			continue
		}
	}
	return terminal > 0
}

func runAsserts(server *testServer, installID int64, sidecarURL, conversationID string, clauses []AssertClause, res *ScenarioResult) []AssertResult {
	out := []AssertResult{}
	if conversationID != "" {
		if messages, err := fetchScenarioConversationMessages(server, conversationID); err == nil {
			for _, message := range messages {
				if message.Role == "agent" {
					res.ConversationResponses = append(res.ConversationResponses, message.Content)
				}
			}
		}
	}
	for i, c := range clauses {
		ar := AssertResult{Clause: assertLabel(i, c), Category: c.Category}
		switch {
		case c.HTTP != "":
			ar = assertHTTP(server, installID, sidecarURL, c)
		case c.ToolCalled != "":
			ar = assertToolCalled(c, res)
		case c.ToolNotCalled != "":
			ar = assertToolNotCalled(c, res)
		case c.ToolCalledWith != nil:
			ar = assertToolCallMatch(c.ToolCalledWith, false, res)
		case c.ToolNotCalledWith != nil:
			ar = assertToolCallMatch(c.ToolNotCalledWith, true, res)
		case responsePattern(c) != "":
			ar = assertResponseMatches(c, res)
		case responseNeedle(c) != "":
			ar = assertResponseContains(c, res)
		case c.ChatResponseMatches != "":
			ar = assertChatResponse(server, conversationID, c, true)
		case c.ChatResponseContains != "":
			ar = assertChatResponse(server, conversationID, c, false)
		case c.ChatFinalMessages != nil:
			ar = assertChatFinalMessages(server, conversationID, *c.ChatFinalMessages)
		case c.FinishedWithin != "":
			limit, err := time.ParseDuration(c.FinishedWithin)
			if err != nil {
				ar = AssertResult{Clause: "finished_within " + c.FinishedWithin, OK: false, Note: err.Error()}
			} else {
				ar = AssertResult{Clause: "finished_within " + c.FinishedWithin,
					OK: res.ElapsedMs <= limit.Milliseconds(), Got: time.Duration(res.ElapsedMs) * time.Millisecond, Want: limit}
			}
		case c.IterationsAtMost > 0:
			ok := res.Iterations <= c.IterationsAtMost
			ar = AssertResult{
				Clause: fmt.Sprintf("iterations_at_most %d", c.IterationsAtMost),
				OK:     ok, Got: res.Iterations, Want: c.IterationsAtMost,
			}
		default:
			ar.OK = false
			ar.Note = "unrecognised assert clause"
		}
		ar.Category = c.Category
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
	if c.ToolNotCalled != "" {
		return "tool_not_called " + c.ToolNotCalled
	}
	if c.ToolCalledWith != nil {
		return "tool_called_with " + c.ToolCalledWith.Tool
	}
	if c.ToolNotCalledWith != nil {
		return "tool_not_called_with " + c.ToolNotCalledWith.Tool
	}
	if responsePattern(c) != "" {
		return "response_matches " + responsePattern(c)
	}
	if responseNeedle(c) != "" {
		return "response_contains " + responseNeedle(c)
	}
	if c.ChatResponseMatches != "" {
		return "chat_response_matches " + c.ChatResponseMatches
	}
	if c.ChatResponseContains != "" {
		return "chat_response_contains " + c.ChatResponseContains
	}
	if c.ChatFinalMessages != nil {
		return fmt.Sprintf("chat_final_messages %d", *c.ChatFinalMessages)
	}
	if c.FinishedWithin != "" {
		return "finished_within " + c.FinishedWithin
	}
	if c.IterationsAtMost > 0 {
		return fmt.Sprintf("iterations_at_most %d", c.IterationsAtMost)
	}
	return fmt.Sprintf("clause #%d", i+1)
}

func assertHTTP(server *testServer, installID int64, sidecarURL string, c AssertClause) AssertResult {
	parts := strings.SplitN(c.HTTP, " ", 2)
	if len(parts) != 2 {
		return AssertResult{Clause: c.HTTP, OK: false, Note: "expected 'METHOD /path'"}
	}
	method, path := parts[0], parts[1]
	target := "http://" + server.addr + path
	directSidecar := false
	// A runner-spawned server is configured to use the local sidecar below, so
	// querying it directly is exact and avoids unnecessary gateway machinery.
	// With --server, however, the existing server may have launched the install
	// itself and can legitimately ignore our duplicate sidecar override. Verify
	// through that server's install-scoped gateway so assertions observe the
	// same app process the agent called.
	if sidecarURL != "" && server.dataDir != "" && strings.HasPrefix(path, "/api/apps/") {
		rest := strings.TrimPrefix(path, "/api/apps/")
		if slash := strings.Index(rest, "/"); slash >= 0 {
			target = strings.TrimRight(sidecarURL, "/") + rest[slash:]
		} else {
			target = strings.TrimRight(sidecarURL, "/") + "/"
		}
		directSidecar = true
	}
	req, err := http.NewRequest(method, target, nil)
	if err != nil {
		return AssertResult{Clause: c.HTTP, OK: false, Note: err.Error()}
	}
	q := req.URL.Query()
	if !directSidecar {
		q.Set("install_id", fmt.Sprintf("%d", installID))
	}
	q.Set("project_id", server.projectID)
	req.URL.RawQuery = q.Encode()
	if !directSidecar {
		req.Header.Set("Authorization", "Bearer "+server.apiKey)
	}
	req.Header.Set("X-Apteva-Project-ID", server.projectID)
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
	if c.ExpectCountAt != "" || c.ExpectCount != nil || c.ExpectCountMin != 0 || c.ExpectCountMax != 0 {
		var data any
		if err := json.Unmarshal(body, &data); err != nil {
			return AssertResult{Clause: c.HTTP, OK: false, Note: "invalid JSON response: " + err.Error()}
		}
		value := data
		if c.ExpectCountAt != "" {
			var ok bool
			value, ok = jsonPathValue(data, c.ExpectCountAt)
			if !ok {
				return AssertResult{Clause: c.HTTP + " count " + c.ExpectCountAt, OK: false, Note: "JSON path not found"}
			}
		}
		count, ok := valueCount(value)
		if !ok {
			return AssertResult{Clause: c.HTTP + " count " + c.ExpectCountAt, OK: false, Got: value, Note: "value is not countable"}
		}
		want, countOK := any("count assertion"), true
		if c.ExpectCount != nil {
			want, countOK = *c.ExpectCount, count == *c.ExpectCount
		}
		if c.ExpectCountMin > 0 {
			want, countOK = fmt.Sprintf(">= %d", c.ExpectCountMin), count >= c.ExpectCountMin
		}
		if c.ExpectCountMax > 0 {
			want, countOK = fmt.Sprintf("<= %d", c.ExpectCountMax), count <= c.ExpectCountMax
		}
		result := AssertResult{Clause: c.HTTP + " count " + c.ExpectCountAt, OK: countOK, Got: count, Want: want}
		if !countOK {
			result.Note = tcTruncate(string(body), 500)
		}
		return result
	}
	if c.ExpectFieldAt != "" {
		var data any
		if err := json.Unmarshal(body, &data); err != nil {
			return AssertResult{Clause: c.HTTP, OK: false, Note: "invalid JSON response: " + err.Error()}
		}
		value, ok := jsonPathValue(data, c.ExpectFieldAt)
		if !ok {
			return AssertResult{Clause: c.HTTP + " field " + c.ExpectFieldAt, OK: false, Note: "JSON path not found in " + tcTruncate(string(body), 500)}
		}
		if c.ExpectFieldContains != "" {
			got := fmt.Sprint(value)
			return AssertResult{Clause: c.HTTP + " field " + c.ExpectFieldAt, OK: strings.Contains(got, c.ExpectFieldContains), Got: got, Want: c.ExpectFieldContains}
		}
		if c.ExpectFieldMatches != "" {
			re, err := regexp.Compile(c.ExpectFieldMatches)
			if err != nil {
				return AssertResult{Clause: c.HTTP + " field " + c.ExpectFieldAt, OK: false, Note: err.Error()}
			}
			got := fmt.Sprint(value)
			return AssertResult{Clause: c.HTTP + " field " + c.ExpectFieldAt, OK: re.MatchString(got), Got: got, Want: c.ExpectFieldMatches}
		}
		return AssertResult{Clause: c.HTTP + " field " + c.ExpectFieldAt,
			OK: valuesEqual(value, c.ExpectFieldEq), Got: value, Want: c.ExpectFieldEq}
	}
	if c.ExpectItemAt != "" {
		var data any
		if err := json.Unmarshal(body, &data); err != nil {
			return AssertResult{Clause: c.HTTP, OK: false, Note: "invalid JSON response: " + err.Error()}
		}
		value, ok := jsonPathValue(data, c.ExpectItemAt)
		if !ok {
			return AssertResult{Clause: c.HTTP + " item " + c.ExpectItemAt, OK: false, Note: "JSON path not found in " + tcTruncate(string(body), 500)}
		}
		items, ok := value.([]any)
		if !ok {
			return AssertResult{Clause: c.HTTP + " item " + c.ExpectItemAt, OK: false, Got: value, Note: "value is not an array"}
		}
		if len(c.ExpectItem) == 0 {
			return AssertResult{Clause: c.HTTP + " item " + c.ExpectItemAt, OK: false, Note: "expect_item must not be empty"}
		}
		for _, item := range items {
			if jsonSubset(item, c.ExpectItem) {
				return AssertResult{Clause: c.HTTP + " item " + c.ExpectItemAt, OK: true, Got: item, Want: c.ExpectItem}
			}
		}
		return AssertResult{Clause: c.HTTP + " item " + c.ExpectItemAt, OK: false, Got: len(items), Want: c.ExpectItem,
			Note: "no matching item in " + tcTruncate(string(body), 500)}
	}
	return AssertResult{Clause: c.HTTP, OK: true, Got: resp.StatusCode}
}

func jsonSubset(actual, expected any) bool {
	expectedMap, expectedIsMap := expected.(map[string]any)
	if !expectedIsMap {
		return valuesEqual(actual, expected)
	}
	actualMap, actualIsMap := actual.(map[string]any)
	if !actualIsMap {
		return false
	}
	for key, expectedValue := range expectedMap {
		actualValue, ok := actualMap[key]
		if !ok || !jsonSubset(actualValue, expectedValue) {
			return false
		}
	}
	return true
}

func jsonPathValue(data any, path string) (any, bool) {
	current := data
	for _, segment := range strings.Split(path, ".") {
		switch value := current.(type) {
		case map[string]any:
			var ok bool
			current, ok = value[segment]
			if !ok {
				return nil, false
			}
		case []any:
			index, err := strconv.Atoi(segment)
			if err != nil || index < 0 || index >= len(value) {
				return nil, false
			}
			current = value[index]
		default:
			return nil, false
		}
	}
	return current, true
}

func valueCount(value any) (int, bool) {
	switch v := value.(type) {
	case []any:
		return len(v), true
	case map[string]any:
		return len(v), true
	case string:
		return len(v), true
	default:
		return 0, false
	}
}

func valuesEqual(got, want any) bool {
	if reflect.DeepEqual(got, want) {
		return true
	}
	if _, ok := got.(float64); ok {
		return numberValue(got) == numberValue(want)
	}
	return fmt.Sprint(got) == fmt.Sprint(want)
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
			if toolNameMatches(t.Name, w) {
				return AssertResult{Clause: "tool_called " + c.ToolCalled, OK: true, Got: t.Name}
			}
		}
	}
	return AssertResult{Clause: "tool_called " + c.ToolCalled, OK: false,
		Got: toolCallNames(res.ToolCalls)}
}

func assertToolNotCalled(c AssertClause, res *ScenarioResult) AssertResult {
	wants := strings.Split(c.ToolNotCalled, "|")
	for _, w := range wants {
		w = strings.TrimSpace(w)
		for _, t := range res.ToolCalls {
			if toolNameMatches(t.Name, w) {
				return AssertResult{Clause: "tool_not_called " + c.ToolNotCalled, OK: false, Got: t.Name}
			}
		}
	}
	return AssertResult{Clause: "tool_not_called " + c.ToolNotCalled, OK: true, Got: toolCallNames(res.ToolCalls)}
}

func assertToolCallMatch(want *ToolCallAssertion, negate bool, res *ScenarioResult) AssertResult {
	label := "tool_called_with "
	if negate {
		label = "tool_not_called_with "
	}
	if want == nil || strings.TrimSpace(want.Tool) == "" {
		return AssertResult{Clause: label, OK: false, Note: "tool is required"}
	}
	matches := make([]int, 0)
	for i, call := range res.ToolCalls {
		if toolCallNameMatches(call.Name, want.Tool, want.Exact) &&
			(strings.TrimSpace(want.ThreadID) == "" || call.ThreadID == want.ThreadID) &&
			toolCallArgsMatch(call, want.Args) {
			matches = append(matches, i)
		}
	}
	if negate {
		return AssertResult{Clause: label + want.Tool, OK: len(matches) == 0, Got: len(matches), Want: 0}
	}
	ok := len(matches) > 0
	wantCount := any(">= 1")
	if want.Count != nil {
		ok, wantCount = len(matches) == *want.Count, *want.Count
	} else if want.MinCount > 0 {
		ok, wantCount = len(matches) >= want.MinCount, fmt.Sprintf(">= %d", want.MinCount)
	} else if want.MaxCount > 0 {
		ok, wantCount = len(matches) <= want.MaxCount, fmt.Sprintf("<= %d", want.MaxCount)
	}
	if ok && want.Before != "" {
		other := -1
		for i, call := range res.ToolCalls {
			// Ordering assertions pinned to a thread compare against that
			// thread's matching call. Concurrent workers may interleave, so a
			// send from worker A must not make worker B's tasks_get-before-send
			// assertion fail.
			if strings.TrimSpace(want.ThreadID) != "" && call.ThreadID != want.ThreadID {
				continue
			}
			if toolNameMatches(call.Name, want.Before) {
				other = i
				break
			}
		}
		ok = other >= 0 && len(matches) > 0 && matches[0] < other
		wantCount = "before " + want.Before
	}
	return AssertResult{Clause: label + want.Tool, OK: ok, Got: len(matches), Want: wantCount}
}

func toolNameMatches(actual, want string) bool {
	want = strings.TrimSpace(want)
	if strings.Contains(want, "|") {
		for _, alternative := range strings.Split(want, "|") {
			if toolNameMatches(actual, alternative) {
				return true
			}
		}
		return false
	}
	return actual == want || strings.HasSuffix(actual, "_"+want)
}

func toolCallNameMatches(actual, want string, exact bool) bool {
	if !exact {
		return toolNameMatches(actual, want)
	}
	for _, alternative := range strings.Split(want, "|") {
		if actual == strings.TrimSpace(alternative) {
			return true
		}
	}
	return false
}

func toolArgsMatch(actual map[string]string, wants map[string]any) bool {
	for key, want := range wants {
		got, ok := actual[key]
		if !ok {
			return false
		}
		if fmt.Sprint(want) == got {
			continue
		}
		var decoded any
		if json.Unmarshal([]byte(got), &decoded) != nil || !valuesEqual(decoded, want) {
			return false
		}
	}
	return true
}

func toolCallArgsMatch(call ToolCallResult, wants map[string]any) bool {
	if toolArgsMatch(call.Args, wants) {
		return true
	}
	action, ok := compatibilityToolAction(call.Name)
	if !ok || call.Args["action"] != "" {
		return false
	}
	effective := make(map[string]string, len(call.Args)+1)
	for key, value := range call.Args {
		effective[key] = value
	}
	effective["action"] = action
	return toolArgsMatch(effective, wants)
}

func compatibilityToolAction(name string) (string, bool) {
	for suffix, action := range map[string]string{
		"browser_open": "open", "browser_close": "close", "browser_screenshot": "screenshot",
	} {
		if name == suffix || strings.HasSuffix(name, "_"+suffix) {
			return action, true
		}
	}
	return "", false
}

func responseNeedle(c AssertClause) string {
	if c.AgentResponseContains != "" {
		return c.AgentResponseContains
	}
	return c.ResponseContains
}

func responsePattern(c AssertClause) string {
	if c.AgentResponseMatches != "" {
		return c.AgentResponseMatches
	}
	return c.ResponseMatches
}

func assertResponseMatches(c AssertClause, res *ScenarioResult) AssertResult {
	pattern := responsePattern(c)
	clause := "response_matches " + pattern
	compiled, err := regexp.Compile(pattern)
	if err != nil {
		return AssertResult{Clause: clause, OK: false, Want: pattern, Note: "invalid response regex: " + err.Error()}
	}
	joined := strings.Join(responseMessages(c, res), "\n")
	if compiled.MatchString(joined) {
		return AssertResult{Clause: clause, OK: true, Got: "matched", Want: pattern}
	}
	return AssertResult{Clause: clause, OK: false, Got: tcTruncate(joined, 300), Want: pattern}
}

func assertResponseContains(c AssertClause, res *ScenarioResult) AssertResult {
	needle := responseNeedle(c)
	joined := strings.Join(responseMessages(c, res), "\n")
	for _, alternative := range strings.Split(needle, "|") {
		alternative = strings.Trim(strings.TrimSpace(alternative), `"'`)
		if alternative != "" && strings.Contains(strings.ToLower(joined), strings.ToLower(alternative)) {
			return AssertResult{Clause: "response_contains " + needle, OK: true, Got: alternative}
		}
	}
	return AssertResult{Clause: "response_contains " + needle, OK: false, Got: tcTruncate(joined, 300), Want: needle}
}

func responseMessages(c AssertClause, res *ScenarioResult) []string {
	if res == nil {
		return nil
	}
	if threadID := strings.TrimSpace(c.ThreadID); threadID != "" {
		return res.ThreadResponses[threadID]
	}
	return res.AssistantResponses
}

type scenarioChatMessage struct {
	Role     string         `json:"role"`
	Content  string         `json:"content"`
	Status   string         `json:"status"`
	Metadata map[string]any `json:"metadata"`
}

func fetchScenarioConversationMessages(server *testServer, conversationID string) ([]scenarioChatMessage, error) {
	if server == nil || strings.TrimSpace(conversationID) == "" {
		return nil, fmt.Errorf("conversation interaction is not active")
	}
	target := "http://" + server.addr + "/api/apps/channel-chat/messages?chat_id=" +
		url.QueryEscape(conversationID) + "&limit=200"
	req, _ := http.NewRequest(http.MethodGet, target, nil)
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("messages returned HTTP %d: %s", resp.StatusCode, tcTruncate(string(raw), 300))
	}
	var messages []scenarioChatMessage
	if err := json.NewDecoder(resp.Body).Decode(&messages); err != nil {
		return nil, err
	}
	return messages, nil
}

func finalScenarioAgentMessages(messages []scenarioChatMessage) []scenarioChatMessage {
	out := make([]scenarioChatMessage, 0, len(messages))
	for _, message := range messages {
		if message.Role != "agent" {
			continue
		}
		phase, _ := message.Metadata["phase"].(string)
		if strings.EqualFold(strings.TrimSpace(phase), "final") ||
			(strings.TrimSpace(phase) == "" && strings.EqualFold(message.Status, "final")) {
			out = append(out, message)
		}
	}
	return out
}

func assertChatResponse(server *testServer, conversationID string, c AssertClause, usePattern bool) AssertResult {
	messages, err := fetchScenarioConversationMessages(server, conversationID)
	if err != nil {
		return AssertResult{Clause: "chat response", OK: false, Note: err.Error()}
	}
	finals := finalScenarioAgentMessages(messages)
	texts := make([]string, 0, len(finals))
	for _, message := range finals {
		texts = append(texts, message.Content)
	}
	joined := strings.Join(texts, "\n")
	if usePattern {
		pattern := c.ChatResponseMatches
		compiled, compileErr := regexp.Compile(pattern)
		if compileErr != nil {
			return AssertResult{Clause: "chat_response_matches " + pattern, OK: false, Want: pattern, Note: compileErr.Error()}
		}
		return AssertResult{Clause: "chat_response_matches " + pattern, OK: compiled.MatchString(joined), Got: tcTruncate(joined, 300), Want: pattern}
	}
	needle := c.ChatResponseContains
	for _, alternative := range strings.Split(needle, "|") {
		alternative = strings.Trim(strings.TrimSpace(alternative), `"'`)
		if alternative != "" && strings.Contains(strings.ToLower(joined), strings.ToLower(alternative)) {
			return AssertResult{Clause: "chat_response_contains " + needle, OK: true, Got: alternative}
		}
	}
	return AssertResult{Clause: "chat_response_contains " + needle, OK: false, Got: tcTruncate(joined, 300), Want: needle}
}

func assertChatFinalMessages(server *testServer, conversationID string, want int) AssertResult {
	messages, err := fetchScenarioConversationMessages(server, conversationID)
	if err != nil {
		return AssertResult{Clause: fmt.Sprintf("chat_final_messages %d", want), OK: false, Note: err.Error()}
	}
	got := len(finalScenarioAgentMessages(messages))
	return AssertResult{Clause: fmt.Sprintf("chat_final_messages %d", want), OK: got == want, Got: got, Want: want}
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

// installDeps recursively installs and spawns required app dependencies before
// the unit under test. Optional dependencies are included only when the
// scenario opts in with setup.app.bindings.<name>: app. Dep paths follow the
// monorepo sibling convention: `<appDir>/../<dep_name>/`.
//
// The returned bindings belong on the unit-under-test install. Dependencies
// are returned in topological order so the caller can tear them down in reverse.
func installDeps(server *testServer, appDir string, manifestYAML []byte, requested map[string]string) ([]depBundle, map[string]any, error) {
	rollback := func(out []depBundle) {
		for i := len(out) - 1; i >= 0; i-- {
			out[i].sidecar.Stop()
			uninstallApp(server, out[i].installID)
		}
	}
	out := []depBundle{}
	installedByName := map[string]depBundle{}
	visiting := map[string]bool{}

	var installManifestDeps func(string, []byte, map[string]string) (map[string]any, error)
	installManifestDeps = func(ownerDir string, ownerYAML []byte, selections map[string]string) (map[string]any, error) {
		refs, err := parseRequiredAppRefs(ownerYAML)
		if err != nil {
			return nil, err
		}
		known := make(map[string]bool, len(refs))
		for _, ref := range refs {
			known[ref.Name] = true
		}
		for name, target := range selections {
			if !known[name] {
				return nil, fmt.Errorf("app binding %q is not declared in requires.apps", name)
			}
			if !strings.EqualFold(strings.TrimSpace(target), "app") {
				return nil, fmt.Errorf("app binding %q must use target \"app\"", name)
			}
		}

		bindings := map[string]any{}
		for _, ref := range refs {
			if ref.Optional {
				target, selected := selections[ref.Name]
				if !selected || !strings.EqualFold(strings.TrimSpace(target), "app") {
					continue
				}
			}
			key := strings.ToLower(strings.TrimSpace(ref.Name))
			if existing, ok := installedByName[key]; ok {
				bindings[ref.Name] = existing.installID
				continue
			}
			if visiting[key] {
				return nil, fmt.Errorf("app dependency cycle at %q", ref.Name)
			}
			visiting[key] = true

			parent := filepath.Dir(ownerDir)
			if abs, absErr := filepath.Abs(ownerDir); absErr == nil {
				parent = filepath.Dir(abs)
			}
			depDir := filepath.Join(parent, ref.Name)
			manifestPath := filepath.Join(depDir, "apteva.yaml")
			depYAML, readErr := os.ReadFile(manifestPath)
			if readErr != nil {
				delete(visiting, key)
				return nil, fmt.Errorf("dep %q manifest not found at %s — sibling-dir convention expects it next to the app under test", ref.Name, manifestPath)
			}
			depBindings, depErr := installManifestDeps(depDir, depYAML, nil)
			if depErr != nil {
				delete(visiting, key)
				return nil, fmt.Errorf("resolve dep %q: %w", ref.Name, depErr)
			}
			installed, installErr := installApp(server, depYAML, depDir, server.projectID, nil, depBindings)
			if installErr != nil {
				delete(visiting, key)
				return nil, fmt.Errorf("install dep %q: %w", ref.Name, installErr)
			}
			sc, spawnErr := spawnLocalSidecar(depDir, installed.InstallID, server.projectID, nil, nil, "http://"+server.addr)
			if spawnErr != nil {
				uninstallApp(server, installed.InstallID)
				delete(visiting, key)
				return nil, fmt.Errorf("spawn dep %q: %w", ref.Name, spawnErr)
			}
			if bindErr := setSidecarURL(server, installed.InstallID, sc.URL); bindErr != nil {
				sc.Stop()
				uninstallApp(server, installed.InstallID)
				delete(visiting, key)
				return nil, fmt.Errorf("set dep %q sidecar url: %w", ref.Name, bindErr)
			}
			bundle := depBundle{name: ref.Name, installID: installed.InstallID, sidecar: sc}
			out = append(out, bundle)
			installedByName[key] = bundle
			bindings[ref.Name] = installed.InstallID
			delete(visiting, key)
		}
		return bindings, nil
	}

	bindings, err := installManifestDeps(appDir, manifestYAML, requested)
	if err != nil {
		rollback(out)
		return nil, nil, err
	}
	return out, bindings, nil
}

func scenarioAppMCPConfig(name, url string, spawnable bool) map[string]any {
	return map[string]any{
		"name": name, "transport": "http", "url": url,
		"main_access": true, "no_spawn": !spawnable,
	}
}

func startScenarioFakeMCPServers(specs []FakeMCPServerSpec) ([]*httptest.Server, []map[string]any, error) {
	servers := make([]*httptest.Server, 0, len(specs))
	configs := make([]map[string]any, 0, len(specs))
	closeAll := func() {
		for _, server := range servers {
			server.Close()
		}
	}
	for index, spec := range specs {
		name := strings.TrimSpace(spec.Name)
		if name == "" {
			closeAll()
			return nil, nil, fmt.Errorf("fake MCP %d requires name", index+1)
		}
		if len(spec.Tools) == 0 {
			closeAll()
			return nil, nil, fmt.Errorf("fake MCP %q requires at least one tool", name)
		}
		tools := make(map[string]FakeMCPToolSpec, len(spec.Tools))
		for _, tool := range spec.Tools {
			toolName := strings.TrimSpace(tool.Name)
			if toolName == "" {
				closeAll()
				return nil, nil, fmt.Errorf("fake MCP %q has a tool without a name", name)
			}
			if _, exists := tools[toolName]; exists {
				closeAll()
				return nil, nil, fmt.Errorf("fake MCP %q repeats tool %q", name, toolName)
			}
			tool.Name = toolName
			tools[toolName] = tool
		}

		handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "POST only", http.StatusMethodNotAllowed)
				return
			}
			var request struct {
				ID     any             `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&request); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			if request.ID == nil {
				w.WriteHeader(http.StatusAccepted)
				return
			}
			var result any
			switch request.Method {
			case "initialize":
				result = map[string]any{
					"protocolVersion": "2025-03-26",
					"capabilities":    map[string]any{"tools": map[string]any{}},
					"serverInfo":      map[string]string{"name": name, "version": "scenario-fixture"},
				}
			case "tools/list":
				listed := make([]map[string]any, 0, len(tools))
				names := make([]string, 0, len(tools))
				for toolName := range tools {
					names = append(names, toolName)
				}
				sort.Strings(names)
				for _, toolName := range names {
					tool := tools[toolName]
					properties := make(map[string]any, len(tool.Required))
					for _, field := range tool.Required {
						properties[field] = map[string]any{"type": "string"}
					}
					listed = append(listed, map[string]any{
						"name": tool.Name, "description": tool.Description,
						"inputSchema": map[string]any{
							"type": "object", "properties": properties,
							"required": tool.Required, "additionalProperties": false,
						},
					})
				}
				result = map[string]any{"tools": listed}
			case "tools/call":
				var params struct {
					Name      string         `json:"name"`
					Arguments map[string]any `json:"arguments"`
				}
				_ = json.Unmarshal(request.Params, &params)
				tool, exists := tools[params.Name]
				if !exists {
					result = map[string]any{"isError": true, "content": []map[string]any{{"type": "text", "text": "unknown fake tool"}}}
					break
				}
				missing := make([]string, 0)
				for _, field := range tool.Required {
					if strings.TrimSpace(fmt.Sprint(params.Arguments[field])) == "" {
						missing = append(missing, field)
					}
				}
				if len(missing) > 0 {
					result = map[string]any{"isError": true, "content": []map[string]any{{"type": "text", "text": "missing required fields: " + strings.Join(missing, ", ")}}}
					break
				}
				response := strings.TrimSpace(tool.Result)
				if response == "" {
					response = "FAKE_MCP_OK"
				}
				result = map[string]any{"content": []map[string]any{{"type": "text", "text": response}}}
			default:
				result = map[string]any{}
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
		})
		server := httptest.NewServer(handler)
		servers = append(servers, server)
		configs = append(configs, map[string]any{
			"name": name, "transport": "http", "url": server.URL,
			"no_spawn": spec.NoSpawn,
		})
	}
	return servers, configs, nil
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
	return callPeerMCPRequest(sidecarURL, tool, args, nil)
}

func callPeerMCPAs(sidecarURL, tool string, args map[string]any, agentID int64, threadID, projectID string) error {
	headers := http.Header{}
	headers.Set("X-Apteva-Caller-Agent", strconv.FormatInt(agentID, 10))
	headers.Set("X-Apteva-Caller-Thread", threadID)
	headers.Set("X-Apteva-Project-ID", projectID)
	return callPeerMCPRequest(sidecarURL, tool, args, headers)
}

func callPeerMCPRequest(sidecarURL, tool string, args map[string]any, headers http.Header) error {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": tool, "arguments": args},
	})
	req, err := http.NewRequest(http.MethodPost, sidecarURL+"/mcp", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for name, values := range headers {
		for _, value := range values {
			req.Header.Add(name, value)
		}
	}
	resp, err := http.DefaultClient.Do(req)
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

type requiredAppRef struct {
	Name     string `yaml:"name"`
	Optional bool   `yaml:"optional"`
}

func parseRequiredAppRefs(manifestYAML []byte) ([]requiredAppRef, error) {
	var manifest struct {
		Requires struct {
			Apps []requiredAppRef `yaml:"apps"`
		} `yaml:"requires"`
	}
	if err := yaml.Unmarshal(manifestYAML, &manifest); err != nil {
		return nil, fmt.Errorf("parse requires.apps: %w", err)
	}
	for i := range manifest.Requires.Apps {
		manifest.Requires.Apps[i].Name = strings.TrimSpace(manifest.Requires.Apps[i].Name)
		if manifest.Requires.Apps[i].Name == "" {
			return nil, fmt.Errorf("requires.apps entry %d has no name", i+1)
		}
	}
	return manifest.Requires.Apps, nil
}

type installResp struct {
	InstallID int64 `json:"install_id"`
	AppID     int64 `json:"app_id"`
}

func findExistingAppInstall(server *testServer, appName string) (*installResp, error) {
	req, _ := http.NewRequest(http.MethodGet, "http://"+server.addr+"/api/apps", nil)
	query := req.URL.Query()
	query.Set("project_id", server.projectID)
	req.URL.RawQuery = query.Encode()
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("list apps: HTTP %d: %s", resp.StatusCode, tcTruncate(string(body), 200))
	}
	var apps []struct {
		InstallID int64  `json:"install_id"`
		AppID     int64  `json:"app_id"`
		Name      string `json:"name"`
		ProjectID string `json:"project_id"`
		Status    string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&apps); err != nil {
		return nil, fmt.Errorf("decode app list: %w", err)
	}
	var fallback *installResp
	for _, app := range apps {
		if !strings.EqualFold(strings.TrimSpace(app.Name), strings.TrimSpace(appName)) || app.Status != "running" {
			continue
		}
		candidate := &installResp{InstallID: app.InstallID, AppID: app.AppID}
		if app.ProjectID == server.projectID {
			return candidate, nil
		}
		if app.ProjectID == "" {
			fallback = candidate
		}
	}
	if fallback != nil {
		return fallback, nil
	}
	return nil, fmt.Errorf("no running %q install is visible in project %s", appName, server.projectID)
}

type scopedAppMCPRelay struct {
	URL      string
	server   *http.Server
	listener net.Listener
}

func startScopedAppMCPRelay(server *testServer, appName string, installID int64) (*scopedAppMCPRelay, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	target := fmt.Sprintf("http://%s/api/apps/%s/mcp", server.addr, url.PathEscape(appName))
	handler := http.HandlerFunc(func(w http.ResponseWriter, incoming *http.Request) {
		request, err := http.NewRequestWithContext(incoming.Context(), incoming.Method, target, incoming.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		request.Header = incoming.Header.Clone()
		request.Header.Del("Authorization")
		request.Header.Del("Cookie")
		request.Header.Del("X-Apteva-Internal-App-Caller-ID")
		request.Header.Set("Authorization", "Bearer "+server.apiKey)
		request.Header.Set("X-Apteva-Project-ID", server.projectID)
		query := incoming.URL.Query()
		query.Set("install_id", strconv.FormatInt(installID, 10))
		query.Set("project_id", server.projectID)
		request.URL.RawQuery = query.Encode()

		response, err := http.DefaultClient.Do(request)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		for key, values := range response.Header {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		w.WriteHeader(response.StatusCode)
		_, _ = io.Copy(w, response.Body)
	})
	httpServer := &http.Server{Handler: handler}
	relay := &scopedAppMCPRelay{
		// Keep the canonical loopback app-MCP path on the relay URL. Core uses
		// that shape to attach its trusted caller-agent header and hidden opaque
		// thread id; the relay then forwards both through the real Server gateway.
		URL:    "http://" + listener.Addr().String() + "/api/apps/" + url.PathEscape(appName) + "/mcp",
		server: httpServer, listener: listener,
	}
	go func() { _ = httpServer.Serve(listener) }()
	return relay, nil
}

func (relay *scopedAppMCPRelay) Close() {
	if relay == nil || relay.server == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = relay.server.Shutdown(ctx)
	_ = relay.listener.Close()
}

func installApp(server *testServer, manifestYAML []byte, appDir, projectID string, config map[string]string, bindings map[string]any) (*installResp, error) {
	// Scenario installs use inline manifest YAML rather than a public manifest
	// URL. Resolve repo-local skill bodies before posting so the normal app
	// install and agent-binding path can register and synchronize the exact skill
	// shipped by the app under test.
	installManifest, err := inlineLocalSkillBodies(manifestYAML, appDir)
	if err != nil {
		return nil, fmt.Errorf("resolve local app skills: %w", err)
	}
	if server.dataDir == "" {
		// --server points at a process whose normal local-install policy may
		// eagerly build and launch runtime.source. The scenario runner already
		// builds the checkout under test and mounts that exact sidecar below.
		// Register a temporary manual-service delivery shape so there is only
		// one process and the LLM exercises the local source being tested.
		installManifest, err = manualMountManifest(installManifest)
		if err != nil {
			return nil, fmt.Errorf("prepare manual test manifest: %w", err)
		}
	}
	body := map[string]any{
		"manifest_yaml": string(installManifest),
		"project_id":    projectID,
		"config":        config,
	}
	if len(bindings) > 0 {
		body["bindings"] = bindings
	}
	out := &installResp{}
	if err := postJSON("http://"+server.addr+"/api/apps/install", server.apiKey, body, out); err != nil {
		return nil, err
	}
	return out, nil
}

func inlineLocalSkillBodies(raw []byte, appDir string) ([]byte, error) {
	var manifest map[string]any
	if err := yaml.Unmarshal(raw, &manifest); err != nil {
		return nil, err
	}
	provides, _ := manifest["provides"].(map[string]any)
	skills, _ := provides["skills"].([]any)
	if len(skills) == 0 {
		return raw, nil
	}
	base, err := filepath.Abs(appDir)
	if err != nil {
		return nil, err
	}
	changed := false
	for index, value := range skills {
		skill, ok := value.(map[string]any)
		if !ok {
			continue
		}
		bodyFile, _ := skill["body_file"].(string)
		bodyFile = strings.TrimSpace(bodyFile)
		if bodyFile == "" {
			continue
		}
		clean := filepath.Clean(bodyFile)
		if filepath.IsAbs(clean) || clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("skill %d body_file must stay inside the app directory: %q", index, bodyFile)
		}
		full := filepath.Join(base, clean)
		rel, err := filepath.Rel(base, full)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("skill %d body_file escapes the app directory: %q", index, bodyFile)
		}
		body, err := os.ReadFile(full)
		if err != nil {
			return nil, fmt.Errorf("read skill %d body_file %q: %w", index, bodyFile, err)
		}
		skill["body"] = string(body)
		delete(skill, "body_file")
		changed = true
	}
	if !changed {
		return raw, nil
	}
	return yaml.Marshal(manifest)
}

func manualMountManifest(raw []byte) ([]byte, error) {
	var manifest map[string]any
	if err := yaml.Unmarshal(raw, &manifest); err != nil {
		return nil, err
	}
	runtime, _ := manifest["runtime"].(map[string]any)
	if runtime == nil {
		runtime = map[string]any{}
	}
	runtime["kind"] = "service"
	delete(runtime, "source")
	delete(runtime, "binaries")
	// A service manifest must declare a delivery source. The existing local
	// server does not deploy images itself, so this sentinel keeps validation
	// honest while leaving the install pending for setSidecarURL below.
	runtime["image"] = "apteva-test/manual-mount"
	delete(runtime, "bundle")
	delete(runtime, "static_dir")
	manifest["runtime"] = runtime
	return yaml.Marshal(manifest)
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

type scenarioConversation struct {
	ID       string
	ThreadID string
	stream   io.ReadCloser
}

func startScenarioThread(server *testServer, agentID int64, spec ScenarioThreadSpec, prompt string) error {
	threadID := strings.TrimSpace(spec.ID)
	if threadID == "" {
		threadID = "scenario-request"
	}
	payload := map[string]any{
		"events": []map[string]any{{
			"id":      "scenario-prompt",
			"message": prompt,
		}},
	}
	if directive := strings.TrimSpace(spec.Directive); directive != "" {
		payload["directive"] = directive
	}
	if spec.Tools != nil {
		payload["tools"] = spec.Tools
	}
	if spec.MCP != nil {
		payload["mcp"] = spec.MCP
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequest(http.MethodPost,
		fmt.Sprintf("http://%s/api/instances/%d/threads/%s", server.addr, agentID, url.PathEscape(threadID)),
		bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("create thread returned HTTP %d: %s", resp.StatusCode, tcTruncate(string(responseBody), 300))
	}
	var result struct {
		Status string `json:"status"`
		ID     string `json:"id"`
		Events struct {
			Accepted []string `json:"accepted"`
		} `json:"events"`
	}
	if err := json.Unmarshal(responseBody, &result); err != nil {
		return fmt.Errorf("decode thread creation: %w", err)
	}
	if result.ID != threadID || (result.Status != "created" && result.Status != "exists") {
		return fmt.Errorf("unexpected thread creation receipt: %s", tcTruncate(string(responseBody), 300))
	}
	if len(result.Events.Accepted) != 1 || result.Events.Accepted[0] != "scenario-prompt" {
		return fmt.Errorf("scenario prompt was not accepted atomically: %s", tcTruncate(string(responseBody), 300))
	}
	return nil
}

func openScenarioConversation(server *testServer, agentID int64, title string) (*scenarioConversation, error) {
	body, _ := json.Marshal(map[string]any{"agent_id": agentID, "title": title})
	req, _ := http.NewRequest(http.MethodPost, "http://"+server.addr+"/api/apps/channel-chat/chats", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("create returned HTTP %d: %s", resp.StatusCode, tcTruncate(string(raw), 300))
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(created.ID, "conv-") {
		return nil, fmt.Errorf("create returned invalid conversation id %q", created.ID)
	}

	streamReq, _ := http.NewRequest(http.MethodGet,
		"http://"+server.addr+"/api/apps/channel-chat/stream?chat_id="+url.QueryEscape(created.ID), nil)
	streamReq.Header.Set("Authorization", "Bearer "+server.apiKey)
	streamResp, err := http.DefaultClient.Do(streamReq)
	if err != nil {
		return nil, err
	}
	if streamResp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(streamResp.Body)
		streamResp.Body.Close()
		return nil, fmt.Errorf("stream returned HTTP %d: %s", streamResp.StatusCode, tcTruncate(string(raw), 300))
	}
	return &scenarioConversation{ID: created.ID, ThreadID: "chat-" + created.ID, stream: streamResp.Body}, nil
}

func (c *scenarioConversation) Close(server *testServer) {
	if c == nil {
		return
	}
	if c.stream != nil {
		_ = c.stream.Close()
	}
	if server == nil || c.ID == "" {
		return
	}
	req, _ := http.NewRequest(http.MethodDelete,
		"http://"+server.addr+"/api/apps/channel-chat/conversation?id="+url.QueryEscape(c.ID), nil)
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	if resp, err := http.DefaultClient.Do(req); err == nil {
		resp.Body.Close()
	}
}

func postScenarioConversation(server *testServer, conversationID, prompt string) error {
	body, _ := json.Marshal(map[string]any{
		"content": prompt,
		"context": map[string]any{"source": "apteva-test", "title": "Tier 3 scenario"},
	})
	req, _ := http.NewRequest(http.MethodPost,
		"http://"+server.addr+"/api/apps/channel-chat/messages?chat_id="+url.QueryEscape(conversationID), bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+server.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("message returned HTTP %d: %s", resp.StatusCode, tcTruncate(string(raw), 300))
	}
	return nil
}

func tcCreateInstance(server *testServer, projectID, name, directive, mode, provider string, mcpServers []map[string]any, boundAppInstallIDs []int64, includeChannels bool, initialPace map[string]any) (*instanceResp, error) {
	// config_json carries the agent's MCP servers + any other config
	// the core needs at boot. The platform writes this to the
	// instance dir's config.json; the core picks it up on start.
	config := map[string]any{}
	if len(mcpServers) > 0 {
		config["mcp_servers"] = mcpServers
	}
	if strings.TrimSpace(provider) != "" {
		config["default_provider"] = normalizeProviderName(provider)
	}
	if initialPace != nil {
		config["main_pace"] = initialPace
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
		"include_apteva_server": &includeFalse,
		"include_channels":      &includeChannels,
	}
	if len(boundAppInstallIDs) > 0 {
		body["bound_app_install_ids"] = boundAppInstallIDs
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
// Spawned-server runs write the known temporary data directory directly.
// Existing-server runs normally leave operator-owned disk state untouched;
// when an initial pace is explicitly requested, they persist only that field
// through the stopped agent's authenticated config endpoint.
func writeInstanceDiskConfig(server *testServer, instanceID int64, directive, mode, provider string, mcpServers []map[string]any, includeChannels bool, initialPace map[string]any) error {
	if server.dataDir == "" {
		if initialPace == nil {
			return nil
		}
		return requestJSON(http.MethodPut,
			fmt.Sprintf("http://%s/api/instances/%d/config", server.addr, instanceID),
			server.apiKey, map[string]any{"main_pace": initialPace}, nil)
	}
	dir := filepath.Join(server.dataDir, fmt.Sprintf("instance_%d", instanceID))
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	cfg := map[string]any{
		"directive":        directive,
		"mode":             mode,
		"mcp_servers":      mcpServers,
		"include_channels": includeChannels,
	}
	if strings.TrimSpace(provider) != "" {
		cfg["default_provider"] = normalizeProviderName(provider)
	}
	if initialPace != nil {
		cfg["main_pace"] = initialPace
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
	URL     string
	cmd     *exec.Cmd
	dataDir string
	binPath string
}

func (s *localSidecar) Stop() {
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
		_ = s.cmd.Wait()
	}
	if s.binPath != "" {
		_ = os.Remove(s.binPath)
	}
	if s.dataDir != "" {
		if os.Getenv("APTEVA_TEST_KEEP") != "" {
			fmt.Fprintf(os.Stderr, "kept sidecar data: %s\n", s.dataDir)
		} else {
			_ = os.RemoveAll(s.dataDir)
		}
	}
}

func spawnLocalSidecar(appDir string, installID int64, projectID string, config, extraEnv map[string]string, gatewayURL string) (*localSidecar, error) {
	abs, err := filepath.Abs(appDir)
	if err != nil {
		return nil, err
	}
	binPath := filepath.Join(abs, "_test_sidecar_bin")
	buildOutput, buildErr := buildLocalSidecarBinary(abs, binPath, false)
	if buildErr != nil && strings.Contains(string(buildOutput), "not one of the workspace modules listed in go.work") {
		buildOutput, buildErr = buildLocalSidecarBinary(abs, binPath, true)
	}
	if buildErr != nil {
		return nil, fmt.Errorf("go build %s: %s", appDir, string(buildOutput))
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
	for key, value := range extraEnv {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
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
	return &localSidecar{URL: url, cmd: cmd, dataDir: dataDir, binPath: binPath}, nil
}

func buildLocalSidecarBinary(dir, binPath string, disableWorkspace bool) ([]byte, error) {
	build := exec.Command("go", "build", "-o", binPath, ".")
	build.Dir = dir
	if disableWorkspace {
		build.Env = append(os.Environ(), "GOWORK=off")
	}
	return build.CombinedOutput()
}

// ─── Misc ──────────────────────────────────────────────────────────

func postJSON(url, apiKey string, body, out any) error {
	return requestJSON(http.MethodPost, url, apiKey, body, out)
}

func requestJSON(method, url, apiKey string, body, out any) error {
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, url, reader)
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
		"GOOGLE_API_KEY", "OPENAI_API_KEY", "OPENAI_CODEX_ACCESS_TOKEN",
		"NVIDIA_API_KEY", "OLLAMA_HOST",
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

func envValue(env []string, key string) string {
	prefix := key + "="
	for i := len(env) - 1; i >= 0; i-- {
		if strings.HasPrefix(env[i], prefix) {
			return strings.TrimSpace(strings.TrimPrefix(env[i], prefix))
		}
	}
	return ""
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

func writeFailureArtifacts(opts testOpts, server *testServer, scenario Scenario, result ScenarioResult) string {
	if strings.TrimSpace(opts.artifactsDir) == "" {
		return ""
	}
	root, err := filepath.Abs(opts.artifactsDir)
	if err != nil {
		root = opts.artifactsDir
	}
	name := sanitizeArtifactName(scenario.Name)
	dir := filepath.Join(root, fmt.Sprintf("%s-run-%d-%s", name, result.Run, time.Now().Format("20060102T150405.000000000")))
	if err := os.MkdirAll(dir, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "  artifact error: %v\n", err)
		return ""
	}

	if body, err := json.MarshalIndent(result, "", "  "); err == nil {
		_ = os.WriteFile(filepath.Join(dir, "result.json"), append(body, '\n'), 0644)
	}
	if body, err := yaml.Marshal(scenario); err == nil {
		_ = os.WriteFile(filepath.Join(dir, "scenario.yaml"), body, 0644)
	}
	var events bytes.Buffer
	encoder := json.NewEncoder(&events)
	for _, event := range result.telemetry {
		_ = encoder.Encode(event)
	}
	_ = os.WriteFile(filepath.Join(dir, "telemetry.jsonl"), events.Bytes(), 0644)
	if server.dataDir != "" {
		copyFileTail(filepath.Join(server.dataDir, "server.log"), filepath.Join(dir, "server.log"), 2<<20)
	}
	fmt.Fprintf(os.Stderr, "  failure artifacts: %s\n", dir)
	return dir
}

func sanitizeArtifactName(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = regexp.MustCompile(`[^a-z0-9._-]+`).ReplaceAllString(value, "-")
	value = strings.Trim(value, "-.")
	if value == "" {
		return "scenario"
	}
	return value
}

func copyFileTail(source, destination string, maxBytes int64) {
	file, err := os.Open(source)
	if err != nil {
		return
	}
	defer file.Close()
	if info, err := file.Stat(); err == nil && info.Size() > maxBytes {
		_, _ = file.Seek(info.Size()-maxBytes, io.SeekStart)
	}
	body, err := io.ReadAll(file)
	if err == nil {
		_ = os.WriteFile(destination, body, 0644)
	}
}

func printSummary(w io.Writer, r ScenarioResult, verbose bool) {
	mark := "✓"
	if !r.OK {
		mark = "✗"
	}
	fmt.Fprintf(w, "%s %s · %dms · %d iter · %d tokens · $%.4f\n",
		mark, r.Name, r.ElapsedMs, r.Iterations, r.Tokens.Total, r.CostUSD)
	if r.RunCount > 1 && len(r.Attempts) > 0 {
		fmt.Fprintf(w, "    pass rate: %d/%d (%.0f%%), required %.0f%%\n",
			r.PassCount, r.RunCount, r.PassRate*100, r.RequiredPassRate*100)
	}
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
