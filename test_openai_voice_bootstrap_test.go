package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProvisionOpenAIAPIConnectionForVoiceScenario(t *testing.T) {
	var body map[string]any
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/api/connections" || r.Header.Get("Authorization") != "Bearer owner" {
			t.Error("incorrect provider bootstrap request")
			w.WriteHeader(400)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		_, _ = w.Write([]byte(`{"id":1,"status":"active"}`))
	}))
	defer host.Close()
	server := &testServer{addr: strings.TrimPrefix(host.URL, "http://"), apiKey: "owner", projectID: "isolated"}
	if err := provisionSpawnedTestProvider(server, "openai", []string{"OPENAI_API_KEY=fixture"}); err != nil {
		t.Fatal(err)
	}
	if body["app_slug"] != "openai-api" || body["project_id"] != "isolated" || body["auth_type"] != "bearer" || body["auto_mcp"] != false {
		t.Fatalf("incorrect scoped provider contract: %v", body)
	}
	if body["credentials"].(map[string]any)["token"] != "fixture" {
		t.Fatal("OpenAI catalog credential field lost")
	}
	if err := provisionSpawnedTestProvider(server, "openai", nil); err == nil || !strings.Contains(err.Error(), "OPENAI_API_KEY") {
		t.Fatal("missing key accepted")
	}
}
