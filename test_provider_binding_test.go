package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// R1: a provider matched by display name must resolve to the slug the server
// binds by. Matching on name and then binding the typed string is how
// verification passed for a provider that could not bind.
func TestResolveServerProviderReturnsSlugNotDisplayName(t *testing.T) {
	const apiKey = "owner-key"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/providers":
			http.Error(w, "gone", http.StatusGone)
		case "/api/connections/runtime":
			_, _ = w.Write([]byte(`[{"name":"OpenCode Go 3","app_slug":"opencode-go","role":"llm"}]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	server := &testServer{addr: strings.TrimPrefix(srv.URL, "http://"), apiKey: apiKey, projectID: "p1"}
	got, err := resolveServerProvider(server, "OpenCode Go 3")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != "opencode-go" {
		t.Fatalf("canonical = %q, want opencode-go (the app_slug, not the display name)", got)
	}
}

func TestResolveServerProviderRejectsUnconfiguredProvider(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/providers":
			http.Error(w, "gone", http.StatusGone)
		case "/api/connections/runtime":
			_, _ = w.Write([]byte(`[{"name":"Fireworks","app_slug":"fireworks","role":"llm"}]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	server := &testServer{addr: strings.TrimPrefix(srv.URL, "http://"), apiKey: "k", projectID: "p1"}
	if _, err := resolveServerProvider(server, "opencode-go"); err == nil {
		t.Fatal("expected an error for a provider with no connection")
	}
}

// A connection with no slug cannot be bound; refuse rather than hand back a
// display name the server will not match.
func TestResolveServerProviderRejectsConnectionWithoutSlug(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/providers":
			http.Error(w, "gone", http.StatusGone)
		case "/api/connections/runtime":
			_, _ = w.Write([]byte(`[{"name":"Opencode Go","app_slug":"","role":"llm"}]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	server := &testServer{addr: strings.TrimPrefix(srv.URL, "http://"), apiKey: "k", projectID: "p1"}
	_, err := resolveServerProvider(server, "opencode-go")
	if err == nil || !strings.Contains(err.Error(), "app_slug") {
		t.Fatalf("error = %v, want it to name the missing app_slug", err)
	}
}

// R2: a provider the spawned path cannot provision must fail loudly instead
// of returning nil and leaving the server with nothing configured.
func TestProvisionSpawnedTestProviderFailsWithoutRequestedCredential(t *testing.T) {
	server := &testServer{addr: "127.0.0.1:1", apiKey: "k", projectID: "p1"}
	err := provisionSpawnedTestProvider(server, "opencode-go", []string{"ANTHROPIC_API_KEY=other-provider-key"})
	if err == nil {
		t.Fatal("expected an error: opencode-go has no credential in this env")
	}
	if !strings.Contains(err.Error(), "OPENCODE_GO_API_KEY") {
		t.Errorf("error = %v, want it to name the variable that is missing", err)
	}
}

func TestProvisionSpawnedTestProviderRejectsUnknownProvider(t *testing.T) {
	server := &testServer{addr: "127.0.0.1:1", apiKey: "k", projectID: "p1"}
	err := provisionSpawnedTestProvider(server, "not-a-provider", nil)
	if err == nil || !strings.Contains(err.Error(), "unknown LLM provider") {
		t.Fatalf("error = %v, want an unknown-provider error", err)
	}
}

// Env-bootstrapped providers stay supported when their own key is present.
func TestProvisionSpawnedTestProviderAllowsEnvBootstrap(t *testing.T) {
	server := &testServer{addr: "127.0.0.1:1", apiKey: "k", projectID: "p1"}
	if err := provisionSpawnedTestProvider(server, "opencode-go", []string{"OPENCODE_GO_API_KEY=key"}); err != nil {
		t.Fatalf("env bootstrap should succeed: %v", err)
	}
}

func TestProviderCredentialTableCoversEveryKnownProvider(t *testing.T) {
	for _, name := range knownLLMProviders() {
		if len(providerEnvKeys(name)) == 0 {
			t.Errorf("provider %q has no credential variable", name)
		}
	}
	if !knownLLMProvider("venice") || len(providerEnvKeys("venice")) == 0 {
		t.Error("venice must be known and have a credential variable")
	}
}

// R3: the substitution this whole change exists to catch.
func TestEffectiveRuntimeAssertsFailOnSubstitutedProvider(t *testing.T) {
	res := &ScenarioResult{ObservedProviders: []string{"fireworks"}}
	got := effectiveRuntimeAsserts(testOpts{provider: "opencode-go"}, res)
	if len(got) != 1 {
		t.Fatalf("asserts = %+v, want one", got)
	}
	if got[0].OK {
		t.Error("running fireworks when opencode-go was requested must fail")
	}
	if !strings.Contains(got[0].Note, "did not run the requested") {
		t.Errorf("note = %q, want it to state the substitution", got[0].Note)
	}
}

func TestEffectiveRuntimeAssertsPassWhenProviderMatches(t *testing.T) {
	res := &ScenarioResult{ObservedProviders: []string{"opencode-go"}}
	got := effectiveRuntimeAsserts(testOpts{provider: "opencode-go"}, res)
	if len(got) != 1 || !got[0].OK {
		t.Fatalf("asserts = %+v, want a single passing assert", got)
	}
}

// Silence is not success: no llm.start means nothing confirms what ran.
func TestEffectiveRuntimeAssertsFailWhenNothingObserved(t *testing.T) {
	got := effectiveRuntimeAsserts(testOpts{provider: "opencode-go"}, &ScenarioResult{})
	if len(got) != 1 || got[0].OK {
		t.Fatalf("asserts = %+v, want a failure", got)
	}
	if !strings.Contains(got[0].Note, "unverified") {
		t.Errorf("note = %q, want it to flag the result as unverified", got[0].Note)
	}
}

func TestEffectiveRuntimeAssertsIgnoreUnpinnedRuns(t *testing.T) {
	res := &ScenarioResult{ObservedProviders: []string{"fireworks"}, ObservedModels: []string{"m"}}
	if got := effectiveRuntimeAsserts(testOpts{}, res); len(got) != 0 {
		t.Fatalf("asserts = %+v, want none when nothing was pinned", got)
	}
}

func TestEffectiveRuntimeAssertsCheckModel(t *testing.T) {
	res := &ScenarioResult{ObservedModels: []string{"kimi-k2p6"}}
	got := effectiveRuntimeAsserts(testOpts{model: "gpt-5.6-terra"}, res)
	if len(got) != 1 || got[0].OK {
		t.Fatalf("asserts = %+v, want a model failure", got)
	}
}

// A run that switches provider partway is still a substitution.
func TestEffectiveRuntimeAssertsFailOnMidRunSwitch(t *testing.T) {
	res := &ScenarioResult{ObservedProviders: []string{"opencode-go", "fireworks"}}
	got := effectiveRuntimeAsserts(testOpts{provider: "opencode-go"}, res)
	if len(got) != 1 || got[0].OK {
		t.Fatalf("asserts = %+v, want a failure", got)
	}
}

// llm.start is what carries provider/model; llm.done carries neither.
func TestApplyTelemetryRecordsProviderFromLLMStart(t *testing.T) {
	res := &ScenarioResult{}
	applyTelemetry(res, telemetryEvent{Type: "llm.start", Data: map[string]any{
		"provider": "OpenCode Go", "model": "kimi-k2p6",
	}})
	applyTelemetry(res, telemetryEvent{Type: "llm.start", Data: map[string]any{
		"provider": "opencode-go", "model": "kimi-k2p6",
	}})

	if len(res.ObservedProviders) != 1 || res.ObservedProviders[0] != "opencode-go" {
		t.Errorf("providers = %v, want one normalized entry", res.ObservedProviders)
	}
	if len(res.ObservedModels) != 1 || res.ObservedModels[0] != "kimi-k2p6" {
		t.Errorf("models = %v, want one entry", res.ObservedModels)
	}
}

// R4: an unrecognized spelling must not write an override that targets nothing.
func TestApplyTestModelOverrideSkipsUnknownProvider(t *testing.T) {
	config := map[string]any{}
	applyTestModelOverride(config, "OpenCode Go 3", "kimi-k2p6")
	if _, present := config["providers"]; present {
		t.Fatalf("an unknown provider key must not write an override: %#v", config["providers"])
	}
}

func TestApplyTestModelOverrideStillWritesKnownProvider(t *testing.T) {
	config := map[string]any{}
	applyTestModelOverride(config, "OpenCode Go", "kimi-k2p6")
	providers, ok := config["providers"].([]map[string]any)
	if !ok || len(providers) != 1 || providers[0]["name"] != "opencode-go" {
		t.Fatalf("providers = %#v", config["providers"])
	}
}
