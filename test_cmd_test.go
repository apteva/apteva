package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func TestExpandScenarioEnvironment(t *testing.T) {
	t.Setenv("COMPUTER_TEST_CONTEXT_ID", "ctx_test")
	scenario := Scenario{
		Setup:     ScenarioSetup{RequiredEnv: []string{"COMPUTER_TEST_CONTEXT_ID"}},
		Directive: "Use ${COMPUTER_TEST_CONTEXT_ID}",
		OutcomeAssert: []AssertClause{{
			HTTP: "GET /contexts/${COMPUTER_TEST_CONTEXT_ID}", ExpectFieldEq: "${COMPUTER_TEST_CONTEXT_ID}",
			ResponseContains: "${COMPUTER_TEST_CONTEXT_ID}", ResponseMatches: "^${COMPUTER_TEST_CONTEXT_ID}$",
		}},
		TrajectoryAssert: []AssertClause{{ToolCalledWith: &ToolCallAssertion{
			Tool: "browser_session", Args: map[string]any{"context_id": "${COMPUTER_TEST_CONTEXT_ID}"},
		}}},
	}
	if err := expandScenarioEnvironment(&scenario); err != nil {
		t.Fatalf("expand environment: %v", err)
	}
	if scenario.Directive != "Use ctx_test" || scenario.OutcomeAssert[0].HTTP != "GET /contexts/ctx_test" {
		t.Fatalf("scenario was not expanded: %+v", scenario)
	}
	if scenario.OutcomeAssert[0].ExpectFieldEq != "ctx_test" || scenario.TrajectoryAssert[0].ToolCalledWith.Args["context_id"] != "ctx_test" {
		t.Fatalf("assertions were not expanded: %+v", scenario)
	}
	if scenario.OutcomeAssert[0].ResponseContains != "ctx_test" || scenario.OutcomeAssert[0].ResponseMatches != "^ctx_test$" {
		t.Fatalf("response assertions were not expanded: %+v", scenario.OutcomeAssert[0])
	}
}

func TestExpandScenarioEnvironmentRequiresValue(t *testing.T) {
	t.Setenv("COMPUTER_TEST_MISSING", "")
	err := expandScenarioEnvironment(&Scenario{Setup: ScenarioSetup{RequiredEnv: []string{"COMPUTER_TEST_MISSING"}}})
	if err == nil || !strings.Contains(err.Error(), "COMPUTER_TEST_MISSING") {
		t.Fatalf("error = %v", err)
	}
}

func TestExpandScenarioRuntime(t *testing.T) {
	scenario := Scenario{
		Directive: "Open ${APTEVA_TEST_APP_URL}/test/form in ${APTEVA_TEST_PROJECT_ID}",
		Prompt:    "Continue in ${APTEVA_TEST_CONVERSATION_THREAD_ID}",
		OutcomeAssert: []AssertClause{{
			HTTP:          "GET ${APTEVA_TEST_APP_URL}/test/form/status",
			ExpectFieldEq: "${APTEVA_TEST_PROJECT_ID}",
		}},
		TrajectoryAssert: []AssertClause{{ToolCalledWith: &ToolCallAssertion{
			Tool: "browser_session", Args: map[string]any{"url": "${APTEVA_TEST_APP_URL}/test/form"},
		}}},
	}
	expandScenarioRuntime(&scenario, map[string]string{
		"APTEVA_TEST_APP_URL": "http://127.0.0.1:9876", "APTEVA_TEST_PROJECT_ID": "project-test",
		"APTEVA_TEST_CONVERSATION_THREAD_ID": "chat-conv-test",
		"APTEVA_TEST_AGENT_ID":               "42",
	})
	if scenario.Directive != "Open http://127.0.0.1:9876/test/form in project-test" ||
		scenario.Prompt != "Continue in chat-conv-test" ||
		scenario.OutcomeAssert[0].HTTP != "GET http://127.0.0.1:9876/test/form/status" ||
		scenario.OutcomeAssert[0].ExpectFieldEq != "project-test" ||
		scenario.TrajectoryAssert[0].ToolCalledWith.Args["url"] != "http://127.0.0.1:9876/test/form" {
		t.Fatalf("runtime values were not expanded: %+v", scenario)
	}
}

func TestToolCallAssertionExactNameDoesNotMatchSuffix(t *testing.T) {
	result := &ScenarioResult{ToolCalls: []ToolCallResult{{Name: "channels_send", ThreadID: "chat-1"}}}
	assertion := &ToolCallAssertion{Tool: "send", Exact: true, ThreadID: "chat-1"}
	if got := assertToolCallMatch(assertion, true, result); !got.OK {
		t.Fatalf("exact negative assertion matched channels_send: %+v", got)
	}
	assertion.Exact = false
	if got := assertToolCallMatch(assertion, true, result); got.OK {
		t.Fatalf("suffix-compatible assertion did not match channels_send: %+v", got)
	}
}

func TestApplyTelemetryRetainsToolTrajectory(t *testing.T) {
	result := &ScenarioResult{}
	applyTelemetry(result, telemetryEvent{Type: "tool.call", Data: map[string]any{
		"id": "call-1", "name": "computer_computer_use",
		"args":   map[string]any{"action": "navigate", "url": "https://example.com"},
		"reason": "open the requested page",
	}})
	applyTelemetry(result, telemetryEvent{Type: "tool.result", Data: map[string]any{
		"id": "call-1", "name": "computer_computer_use", "success": true,
		"duration_ms": float64(42), "result": `{"current_url":"https://example.com"}`,
		"result_original_bytes": float64(1200), "result_context_bytes": float64(700),
		"result_preview_bytes": float64(500), "result_image_bytes": float64(200),
		"result_truncated": true,
	}})
	applyTelemetry(result, telemetryEvent{Type: "llm.done", Data: map[string]any{
		"tokens_in": float64(100), "tokens_out": float64(20), "cost_usd": 0.004,
		"message": "Navigation complete.",
	}})

	if len(result.ToolCalls) != 1 {
		t.Fatalf("tool calls = %d", len(result.ToolCalls))
	}
	call := result.ToolCalls[0]
	if call.ID != "call-1" || call.Args["action"] != "navigate" || !call.Completed || !call.OK || call.Ms != 42 {
		t.Fatalf("tool call = %+v", call)
	}
	if !call.ResultTruncated || call.ResultOriginalBytes != 1200 || call.ResultImageBytes != 200 {
		t.Fatalf("tool result metadata = %+v", call)
	}
	if result.Tokens.Total != 120 || result.CostUSD != 0.004 || result.AssistantResponses[0] != "Navigation complete." {
		t.Fatalf("LLM aggregation = %+v", result)
	}
}

func TestIterationLimitWaitsForInflightToolResult(t *testing.T) {
	result := &ScenarioResult{}
	applyTelemetry(result, telemetryEvent{Type: "tool.call", Data: map[string]any{
		"id": "close-1", "name": "computer_browser_close",
	}})
	applyTelemetry(result, telemetryEvent{Type: "llm.done", Data: map[string]any{}})
	if scenarioIterationLimitReached(result, 1) {
		t.Fatal("iteration limit stopped before the in-flight close result")
	}
	applyTelemetry(result, telemetryEvent{Type: "tool.result", Data: map[string]any{
		"id": "close-1", "name": "computer_browser_close", "success": true,
	}})
	if !scenarioIterationLimitReached(result, 1) {
		t.Fatal("iteration limit did not stop after the close result")
	}
}

func TestAcceptTelemetryIgnoresReplayedSSEFrames(t *testing.T) {
	result := &ScenarioResult{}
	seen := map[string]struct{}{}
	event := telemetryEvent{Type: "llm.done", Data: map[string]any{
		"iteration": float64(8), "tokens_in": float64(100), "tokens_out": float64(10), "message": "done",
	}}
	if !acceptTelemetry(result, event, seen) {
		t.Fatal("first event was rejected")
	}
	if acceptTelemetry(result, event, seen) {
		t.Fatal("replayed event was accepted")
	}
	if result.Iterations != 1 || result.Tokens.Total != 110 || len(result.telemetry) != 1 {
		t.Fatalf("result after replay = %+v", result)
	}
}

func TestFetchStoredTelemetryAuthenticatesAndOrdersOldestFirst(t *testing.T) {
	const apiKey = "owner-key"
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/telemetry" || r.URL.Query().Get("agent_id") != "42" || r.URL.Query().Get("limit") != "1000" {
			t.Fatalf("request = %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		if r.Header.Get("Authorization") != "Bearer "+apiKey {
			t.Fatal("missing owner authentication")
		}
		_, _ = w.Write([]byte(`[
			{"type":"tool.result","data":{"id":"call-1","name":"computer_use","success":true}},
			{"type":"tool.call","data":{"id":"call-1","name":"computer_use"}}
		]`))
	}))
	defer httpServer.Close()
	server := &testServer{addr: strings.TrimPrefix(httpServer.URL, "http://"), apiKey: apiKey}
	events, err := fetchStoredTelemetry(server, 42, time.Now().Add(-time.Minute))
	if err != nil {
		t.Fatalf("fetch telemetry: %v", err)
	}
	if len(events) != 2 || events[0].Type != "tool.call" || events[1].Type != "tool.result" {
		t.Fatalf("events = %+v", events)
	}
}

func TestToolArgumentAndNegativeAssertions(t *testing.T) {
	result := &ScenarioResult{ToolCalls: []ToolCallResult{
		{Name: "computer_browser_session", Args: map[string]string{"action": "open"}},
		{Name: "computer_computer_use", Args: map[string]string{"action": "navigate", "url": "https://example.com"}},
		{Name: "computer_browser_session", Args: map[string]string{"action": "close"}},
	}}

	called := &ToolCallAssertion{Tool: "computer_use", Args: map[string]any{"action": "navigate"}, Before: "browser_session"}
	if got := assertToolCallMatch(called, false, result); got.OK {
		t.Fatalf("before must compare with the first matching call: %+v", got)
	}
	called.Before = ""
	if got := assertToolCallMatch(called, false, result); !got.OK {
		t.Fatalf("argument-aware call should pass: %+v", got)
	}
	alias := &ToolCallAssertion{Tool: "browser_session | computer_use", Args: map[string]any{"action": "navigate"}}
	if got := assertToolCallMatch(alias, false, result); !got.OK {
		t.Fatalf("tool alternatives should pass: %+v", got)
	}
	closeAliasResult := &ScenarioResult{ToolCalls: []ToolCallResult{{Name: "computer_browser_close"}}}
	closeAlias := &ToolCallAssertion{Tool: "browser_session | browser_close", Args: map[string]any{"action": "close"}}
	if got := assertToolCallMatch(closeAlias, false, closeAliasResult); !got.OK {
		t.Fatalf("compatibility alias action should pass: %+v", got)
	}
	openOnly := &ScenarioResult{ToolCalls: []ToolCallResult{{Name: "computer_browser_session", Args: map[string]string{"action": "open"}}}}
	if got := assertToolCallMatch(closeAlias, false, openOnly); got.OK {
		t.Fatalf("open session must not satisfy close assertion: %+v", got)
	}
	forbidden := &ToolCallAssertion{Tool: "computer_use", Args: map[string]any{"action": "key"}}
	if got := assertToolCallMatch(forbidden, true, result); !got.OK {
		t.Fatalf("absent keyboard call should pass: %+v", got)
	}
}

func TestToolAssertionsCanPinOpaqueConversationThread(t *testing.T) {
	result := &ScenarioResult{ToolCalls: []ToolCallResult{
		{Name: "tasks_tasks_create", ThreadID: "chat-conv-1"},
		{Name: "tasks_tasks_update", ThreadID: "main"},
		{Name: "tasks_tasks_complete", ThreadID: "main"},
	}}
	one := 1
	createdByConversation := &ToolCallAssertion{Tool: "tasks_create", ThreadID: "chat-conv-1", Count: &one}
	if got := assertToolCallMatch(createdByConversation, false, result); !got.OK {
		t.Fatalf("conversation create assertion = %+v", got)
	}
	conversationDidNotExecute := &ToolCallAssertion{Tool: "tasks_update | tasks_complete", ThreadID: "chat-conv-1"}
	if got := assertToolCallMatch(conversationDidNotExecute, true, result); !got.OK {
		t.Fatalf("conversation execution boundary = %+v", got)
	}
	mainCompleted := &ToolCallAssertion{Tool: "tasks_complete", ThreadID: "main", Count: &one}
	if got := assertToolCallMatch(mainCompleted, false, result); !got.OK {
		t.Fatalf("main completion assertion = %+v", got)
	}
}

func TestConversationAssertionsUseVisibleFinalMessages(t *testing.T) {
	const apiKey = "owner-key"
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/apps/channel-chat/messages" || r.URL.Query().Get("chat_id") != "conv-1" {
			t.Fatalf("request = %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		if r.Header.Get("Authorization") != "Bearer "+apiKey {
			t.Fatal("missing owner authentication")
		}
		_, _ = w.Write([]byte(`[
			{"role":"user","content":"Run it later","status":"final"},
			{"role":"agent","content":"I'll schedule it.","status":"final","metadata":{"phase":"acknowledgement"}},
			{"role":"agent","content":"READINESS CHECK PASSED","status":"final","metadata":{"phase":"final"}}
		]`))
	}))
	defer httpServer.Close()
	server := &testServer{addr: strings.TrimPrefix(httpServer.URL, "http://"), apiKey: apiKey}
	if got := assertChatResponse(server, "conv-1", AssertClause{ChatResponseContains: "readiness check passed"}, false); !got.OK {
		t.Fatalf("chat response assertion = %+v", got)
	}
	if got := assertChatFinalMessages(server, "conv-1", 1); !got.OK {
		t.Fatalf("chat final count = %+v", got)
	}
}

func TestAssertHTTPDottedFieldsAndCounts(t *testing.T) {
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("install_id") != "9" || r.URL.Query().Get("project_id") != "project-1" {
			t.Fatalf("missing app routing query: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sessions":[{"status":"closed","current_url":"https://www.iana.org/help/example-domains"}]}`))
	}))
	defer httpServer.Close()

	server := &testServer{addr: strings.TrimPrefix(httpServer.URL, "http://"), projectID: "project-1"}
	field := assertHTTP(server, 9, "", AssertClause{
		HTTP: "GET /api/apps/computer/sessions", ExpectFieldAt: "sessions.0.current_url",
		ExpectFieldContains: "iana.org/help/example-domains",
	})
	if !field.OK {
		t.Fatalf("field assertion = %+v", field)
	}
	wantOne := 1
	count := assertHTTP(server, 9, "", AssertClause{
		HTTP: "GET /api/apps/computer/sessions", ExpectCountAt: "sessions", ExpectCount: &wantOne,
	})
	if !count.OK {
		t.Fatalf("count assertion = %+v", count)
	}
}

func TestAssertHTTPCallsTestedSidecarDirectlyWithRunnerServer(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sessions" || r.URL.Query().Get("project_id") != "project-1" {
			t.Fatalf("sidecar request = %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		if r.URL.Query().Has("install_id") {
			t.Fatal("direct sidecar request must not include install_id")
		}
		if auth := r.Header.Get("Authorization"); auth != "" {
			t.Fatalf("owner authorization leaked to sidecar: %q", auth)
		}
		_, _ = w.Write([]byte(`{"sessions":[{"status":"closed"}]}`))
	}))
	defer sidecar.Close()

	server := &testServer{addr: "127.0.0.1:1", apiKey: "owner-key", projectID: "project-1", dataDir: t.TempDir()}
	result := assertHTTP(server, 9, sidecar.URL, AssertClause{
		HTTP: "GET /api/apps/computer/sessions", ExpectFieldAt: "sessions.0.status", ExpectFieldEq: "closed",
	})
	if !result.OK {
		t.Fatalf("direct sidecar assertion = %+v", result)
	}
}

func TestAssertHTTPUsesInstallGatewayWithExistingServer(t *testing.T) {
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/apps/computer/sessions" || r.URL.Query().Get("install_id") != "9" || r.URL.Query().Get("project_id") != "project-1" {
			t.Fatalf("gateway request = %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		if r.Header.Get("Authorization") != "Bearer owner-key" {
			t.Fatalf("missing owner authorization: %+v", r.Header)
		}
		_, _ = w.Write([]byte(`{"sessions":[{"status":"closed"}]}`))
	}))
	defer gateway.Close()

	server := &testServer{addr: strings.TrimPrefix(gateway.URL, "http://"), apiKey: "owner-key", projectID: "project-1"}
	result := assertHTTP(server, 9, "http://127.0.0.1:1", AssertClause{
		HTTP: "GET /api/apps/computer/sessions", ExpectFieldAt: "sessions.0.status", ExpectFieldEq: "closed",
	})
	if !result.OK {
		t.Fatalf("gateway assertion = %+v", result)
	}
}

func TestResponseContainsAlternatives(t *testing.T) {
	result := &ScenarioResult{AssistantResponses: []string{"The Example Domain page is open."}}
	assertion := AssertClause{ResponseContains: `"missing" | "example domain"`}
	if got := assertResponseContains(assertion, result); !got.OK {
		t.Fatalf("response assertion = %+v", got)
	}
}

func TestResponseMatchesStructuredResult(t *testing.T) {
	result := &ScenarioResult{AssistantResponses: []string{`PROSPECTION_OK
Business: Example Studio
Website: https://example.com
Email: hello@example.com
Email source: https://example.com/contact`}}
	assertion := AssertClause{ResponseMatches: `(?is)PROSPECTION_OK.*Email:\s*[A-Z0-9._%+~-]+@[A-Z0-9.-]+\.[A-Z]{2,}`}
	if got := assertResponseMatches(assertion, result); !got.OK {
		t.Fatalf("response regex assertion = %+v", got)
	}
}

func TestResponseMatchesRejectsInvalidPattern(t *testing.T) {
	result := &ScenarioResult{AssistantResponses: []string{"PROSPECTION_OK"}}
	got := assertResponseMatches(AssertClause{ResponseMatches: `(`}, result)
	if got.OK || !strings.Contains(got.Note, "invalid response regex") {
		t.Fatalf("response regex assertion = %+v", got)
	}
}

func TestBootstrapExistingServerReusesOwnerProviders(t *testing.T) {
	const apiKey = "test-owner-key"
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+apiKey {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/projects":
			_, _ = w.Write([]byte(`[{"id":"project-1","name":"Personal"}]`))
		case "/api/providers":
			if r.URL.Query().Get("project_id") != "project-1" {
				t.Fatalf("provider project = %q", r.URL.Query().Get("project_id"))
			}
			_, _ = w.Write([]byte(`[{"name":"OpenAI Codex","type":"llm","status":"active"}]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer httpServer.Close()

	server, err := bootstrapServer(testOpts{
		serverAddr: strings.TrimPrefix(httpServer.URL, "http://"), serverAPIKey: apiKey,
		projectID: "Personal", provider: "openai-codex",
	})
	if err != nil {
		t.Fatalf("bootstrap existing server: %v", err)
	}
	if server.projectID != "project-1" || server.apiKey != apiKey {
		t.Fatalf("server = %+v", server)
	}
}

func TestBootstrapExistingServerRequiresOwnerAuthentication(t *testing.T) {
	_, err := bootstrapServer(testOpts{serverAddr: "127.0.0.1:5280"})
	if err == nil || !strings.Contains(err.Error(), "owner authentication") {
		t.Fatalf("error = %v", err)
	}
}

func TestBootstrapExistingServerUsesTemporaryProjectByDefault(t *testing.T) {
	const apiKey = "test-owner-key"
	deleted := ""
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+apiKey {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/projects":
			_, _ = w.Write([]byte(`{"id":"temporary-project"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/providers":
			_, _ = w.Write([]byte(`[{"name":"OpenAI Codex","type":"llm","status":"active"}]`))
		case r.Method == http.MethodDelete && r.URL.Path == "/api/projects/temporary-project":
			deleted = "temporary-project"
			_, _ = w.Write([]byte(`{"status":"deleted"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer httpServer.Close()

	server, err := bootstrapServer(testOpts{
		serverAddr: strings.TrimPrefix(httpServer.URL, "http://"), serverAPIKey: apiKey,
	})
	if err != nil {
		t.Fatalf("bootstrap existing server: %v", err)
	}
	if server.projectID != "temporary-project" {
		t.Fatalf("project = %q", server.projectID)
	}
	server.Stop()
	if deleted != "temporary-project" {
		t.Fatalf("temporary project was not deleted")
	}
}

func TestFindExistingAppInstallPrefersProjectInstall(t *testing.T) {
	const apiKey = "test-owner-key"
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/apps" || r.URL.Query().Get("project_id") != "project-1" {
			t.Fatalf("request = %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		if r.Header.Get("Authorization") != "Bearer "+apiKey {
			t.Fatal("missing owner authentication")
		}
		_, _ = w.Write([]byte(`[
			{"install_id":10,"app_id":1,"name":"computer","project_id":"","status":"running"},
			{"install_id":22,"app_id":1,"name":"computer","project_id":"project-1","status":"running"}
		]`))
	}))
	defer httpServer.Close()

	server := &testServer{addr: strings.TrimPrefix(httpServer.URL, "http://"), apiKey: apiKey, projectID: "project-1"}
	install, err := findExistingAppInstall(server, "Computer")
	if err != nil {
		t.Fatalf("find app: %v", err)
	}
	if install.InstallID != 22 {
		t.Fatalf("install = %+v", install)
	}
}

func TestScopedAppMCPRelayRoutesOnlySelectedInstall(t *testing.T) {
	const apiKey = "test-owner-key"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/apps/computer/mcp" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		if r.URL.Query().Get("install_id") != "22" || r.URL.Query().Get("project_id") != "project-1" {
			t.Fatalf("query = %q", r.URL.RawQuery)
		}
		if r.Header.Get("Authorization") != "Bearer "+apiKey || r.Header.Get("X-Apteva-Project-ID") != "project-1" {
			t.Fatalf("auth headers = %+v", r.Header)
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("X-Apteva-Internal-App-Caller-ID") != "" {
			t.Fatalf("unsafe headers reached upstream: %+v", r.Header)
		}
		if r.Header.Get("X-Apteva-Caller-Agent") != "42" {
			t.Fatalf("trusted Core caller header was lost: %+v", r.Header)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`))
	}))
	defer upstream.Close()

	server := &testServer{
		addr: strings.TrimPrefix(upstream.URL, "http://"), apiKey: apiKey, projectID: "project-1",
	}
	relay, err := startScopedAppMCPRelay(server, "computer", 22)
	if err != nil {
		t.Fatalf("start relay: %v", err)
	}
	defer relay.Close()

	req, _ := http.NewRequest(http.MethodPost, relay.URL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Header.Set("Authorization", "Bearer untrusted-caller")
	req.Header.Set("Cookie", "session=untrusted")
	req.Header.Set("X-Apteva-Internal-App-Caller-ID", "untrusted")
	req.Header.Set("X-Apteva-Caller-Agent", "42")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("call relay: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("response = %d %+v", response.StatusCode, response.Header)
	}
}

func TestManualMountManifestPreservesCapabilitiesWithoutSourceDelivery(t *testing.T) {
	raw := []byte(`schema: apteva-app/v1
name: tasks
provides:
  mcp_tools:
    - name: create
      description: Create work.
runtime:
  kind: source
  source:
    repo: github.com/apteva/apps
    ref: main
    entry: mcp/tasks
  port: 8080
  health_check: /health
`)
	converted, err := manualMountManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := yaml.Unmarshal(converted, &manifest); err != nil {
		t.Fatal(err)
	}
	runtime := manifest["runtime"].(map[string]any)
	if runtime["kind"] != "service" || runtime["source"] != nil || runtime["image"] != "apteva-test/manual-mount" || runtime["port"] != 8080 {
		t.Fatalf("runtime = %+v", runtime)
	}
	provides := manifest["provides"].(map[string]any)
	if _, ok := provides["mcp_tools"]; !ok {
		t.Fatalf("capabilities were removed: %+v", manifest)
	}
}

func TestInlineLocalSkillBodiesUsesAppCheckout(t *testing.T) {
	appDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(appDir, "skills"), 0755); err != nil {
		t.Fatal(err)
	}
	const skillBody = "# Tasks\n\nMulti-source reviews create one task.\n"
	if err := os.WriteFile(filepath.Join(appDir, "skills", "tasks.md"), []byte(skillBody), 0600); err != nil {
		t.Fatal(err)
	}
	raw := []byte(`schema: apteva-app/v1
name: tasks
provides:
  skills:
    - name: how-to-use-tasks
      description: Task guidance.
      body_file: skills/tasks.md
runtime:
  kind: source
  source: { repo: github.com/apteva/apps, ref: main, entry: mcp/tasks }
`)
	converted, err := inlineLocalSkillBodies(raw, appDir)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := yaml.Unmarshal(converted, &manifest); err != nil {
		t.Fatal(err)
	}
	provides := manifest["provides"].(map[string]any)
	skills := provides["skills"].([]any)
	skill := skills[0].(map[string]any)
	if skill["body"] != skillBody || skill["body_file"] != nil {
		t.Fatalf("resolved skill = %+v", skill)
	}
}

func TestCreateInstanceKeepsPlatformGatewayDisabled(t *testing.T) {
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["include_apteva_server"] != false || body["include_channels"] != false {
			t.Fatalf("gateway flags = %+v", body)
		}
		_, _ = w.Write([]byte(`{"id":42}`))
	}))
	defer httpServer.Close()

	server := &testServer{addr: strings.TrimPrefix(httpServer.URL, "http://"), apiKey: "owner-key"}
	instance, err := tcCreateInstance(server, "project-1", "test", "directive", "autonomous", "openai-codex", nil, nil, false)
	if err != nil {
		t.Fatalf("create instance: %v", err)
	}
	if instance.ID != 42 {
		t.Fatalf("instance = %+v", instance)
	}
}

func TestCreateConversationScenarioEnablesOnlyChannelsGateway(t *testing.T) {
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["include_apteva_server"] != false || body["include_channels"] != true {
			t.Fatalf("gateway flags = %+v", body)
		}
		bound, _ := body["bound_app_install_ids"].([]any)
		if len(bound) != 1 || bound[0] != float64(91) {
			t.Fatalf("bound app installs = %+v", body["bound_app_install_ids"])
		}
		_, _ = w.Write([]byte(`{"id":43}`))
	}))
	defer httpServer.Close()

	server := &testServer{addr: strings.TrimPrefix(httpServer.URL, "http://"), apiKey: "owner-key"}
	instance, err := tcCreateInstance(server, "project-1", "chat-test", "directive", "autonomous", "openai-codex", nil, []int64{91}, true)
	if err != nil {
		t.Fatalf("create instance: %v", err)
	}
	if instance.ID != 43 {
		t.Fatalf("instance = %+v", instance)
	}
}
