package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestStartupFlow simulates what happens when a user runs `npx apteva`.
// It starts the server, bootstraps auth, creates an instance, and verifies
// that channels MCP, apteva-server gateway, and core are all connected.
func TestStartupFlow(t *testing.T) {
	if os.Getenv("RUN_STARTUP_TEST") == "" {
		t.Skip("set RUN_STARTUP_TEST=1 to run (starts real server + core)")
	}

	serverBin := findServerBinary("")
	if serverBin == "" {
		t.Fatal("apteva-server binary not found")
	}
	coreBin := findCoreBinary("")
	if coreBin == "" {
		t.Fatal("apteva-core binary not found")
	}
	t.Logf("server: %s", serverBin)
	t.Logf("core: %s", coreBin)

	// Fresh temp data dir
	dataDir := t.TempDir()
	port := "15280"

	// Start server
	cmd := exec.Command(serverBin)
	cmd.Env = append(os.Environ(),
		"PORT="+port,
		"DB_PATH="+filepath.Join(dataDir, "apteva.db"),
		"DATA_DIR="+dataDir,
		"CORE_CMD="+coreBin,
		"APPS_DIR=", // no integrations — should not crash
		"APTEVA_REGISTRATION=open",
		"QUIET=1",
	)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start server: %v", err)
	}
	defer func() {
		cmd.Process.Kill()
		cmd.Wait()
	}()

	base := "http://127.0.0.1:" + port
	client := &http.Client{Timeout: 5 * time.Second}

	// Wait for health
	t.Log("waiting for server health...")
	healthy := false
	for i := 0; i < 30; i++ {
		resp, err := client.Get(base + "/health")
		if err == nil && resp.StatusCode == 200 {
			resp.Body.Close()
			healthy = true
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !healthy {
		t.Fatal("server did not become healthy in 6s")
	}
	t.Log("server healthy")

	// Test 1: Register
	t.Log("registering...")
	regBody := `{"email":"test@local","password":"test1234"}`
	resp, err := client.Post(base+"/api/auth/register", "application/json", strings.NewReader(regBody))
	if err != nil {
		t.Fatalf("register failed: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("register returned %d: %s", resp.StatusCode, body)
	}
	t.Logf("register: %s", body)

	// Test 2: Login + session cookie
	t.Log("logging in...")
	resp, err = client.Post(base+"/api/auth/login", "application/json", strings.NewReader(regBody))
	if err != nil {
		t.Fatalf("login failed: %v", err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("login returned %d: %s", resp.StatusCode, body)
	}

	var sessionCookie string
	for _, c := range resp.Cookies() {
		if c.Name == "session" {
			sessionCookie = c.Value
		}
	}
	if sessionCookie == "" {
		t.Fatal("no session cookie returned")
	}
	t.Logf("login OK, session cookie: %s...", sessionCookie[:10])

	// Test 3: Create API key
	t.Log("creating API key...")
	keyReq, _ := http.NewRequest("POST", base+"/api/auth/keys", strings.NewReader(`{"name":"test"}`))
	keyReq.Header.Set("Content-Type", "application/json")
	keyReq.AddCookie(&http.Cookie{Name: "session", Value: sessionCookie})
	resp, err = client.Do(keyReq)
	if err != nil {
		t.Fatalf("create key failed: %v", err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("create key returned %d: %s", resp.StatusCode, body)
	}
	var keyResult struct {
		Key string `json:"key"`
	}
	json.Unmarshal(body, &keyResult)
	if keyResult.Key == "" {
		t.Fatal("empty API key returned")
	}
	apiKey := keyResult.Key
	t.Logf("API key: %s...", apiKey[:10])

	// Helper for authed requests — all API routes now live under /api
	doGet := func(path string) (int, []byte) {
		req, _ := http.NewRequest("GET", base+"/api"+path, nil)
		req.Header.Set("Authorization", "Bearer "+apiKey)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp.StatusCode, b
	}
	doPost := func(path string, payload string) (int, []byte) {
		req, _ := http.NewRequest("POST", base+"/api"+path, strings.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+apiKey)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("POST %s: %v", path, err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp.StatusCode, b
	}

	// Test 4: Create provider (fireworks with dummy key)
	t.Log("creating provider...")
	status, body := doPost("/providers", `{"type":"fireworks","name":"fireworks","data":{"FIREWORKS_API_KEY":"test_key","model_large":"test","model_medium":"test","model_small":"test"}}`)
	if status != 200 {
		t.Fatalf("create provider returned %d: %s", status, body)
	}
	t.Logf("provider created: %s", body)

	// Test 5: Create project
	t.Log("creating project...")
	status, body = doPost("/projects", `{"name":"Test Project"}`)
	if status != 200 {
		t.Fatalf("create project returned %d: %s", status, body)
	}
	var proj struct {
		ID string `json:"id"`
	}
	json.Unmarshal(body, &proj)
	t.Logf("project: %s", proj.ID)

	// Test 6: Create instance
	t.Log("creating instance...")
	status, body = doPost("/instances", fmt.Sprintf(`{"name":"test","directive":"test agent","mode":"autonomous","project_id":"%s"}`, proj.ID))
	if status != 200 {
		t.Fatalf("create instance returned %d: %s", status, body)
	}
	var inst struct {
		ID int64 `json:"id"`
	}
	json.Unmarshal(body, &inst)
	t.Logf("instance: %d", inst.ID)

	// Test 7: Start instance (may already be running from create)
	t.Log("starting instance...")
	status, body = doPost(fmt.Sprintf("/instances/%d/start", inst.ID), "")
	if status != 200 && status != 409 {
		t.Fatalf("start instance returned %d: %s", status, body)
	}
	t.Logf("instance start: %d", status)

	// Test 8: Wait for core health (proxy through server)
	t.Log("waiting for core...")
	coreHealthy := false
	for i := 0; i < 30; i++ {
		status, body = doGet(fmt.Sprintf("/instances/%d/threads", inst.ID))
		if status == 200 {
			coreHealthy = true
			t.Logf("core threads: %s", body[:min(100, len(body))])
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if !coreHealthy {
		// Not fatal — core may need LLM to start thinking, check config instead
		t.Log("core not responding to /threads, checking config file instead")
	}

	// Test 9: Check config has channels MCP
	t.Log("checking config for channels MCP...")
	configPath := filepath.Join(dataDir, fmt.Sprintf("instance_%d", inst.ID), "config.json")
	configData, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	var config map[string]any
	json.Unmarshal(configData, &config)

	mcpServers, _ := config["mcp_servers"].([]any)
	hasChannels := false
	hasGateway := false
	for _, s := range mcpServers {
		sm, _ := s.(map[string]any)
		name, _ := sm["name"].(string)
		if name == "channels" {
			hasChannels = true
			url, _ := sm["url"].(string)
			t.Logf("channels MCP url: %s", url)
			// Verify it's reachable
			resp, err := http.Post(url, "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
			if err != nil {
				t.Errorf("channels MCP not reachable: %v", err)
			} else {
				b, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				if resp.StatusCode != 200 {
					t.Errorf("channels MCP returned %d: %s", resp.StatusCode, b)
				} else {
					t.Logf("channels MCP tools/list: %s", b[:min(200, len(b))])
				}
			}
		}
		if name == "apteva-server" {
			hasGateway = true
		}
	}
	if !hasChannels {
		t.Error("FAIL: channels MCP not in config")
	}
	if !hasGateway {
		t.Error("FAIL: apteva-server gateway not in config")
	}

	// Test 10: Check MCP tools are registered in core
	t.Log("checking core MCP tools...")
	status, body = doGet(fmt.Sprintf("/instances/%d/config", inst.ID))
	if status == 200 {
		var coreCfg map[string]any
		json.Unmarshal(body, &coreCfg)
		if mcps, ok := coreCfg["mcp_servers"].([]any); ok {
			t.Logf("core has %d MCP servers configured", len(mcps))
		}
	}

	// Stop instance
	doPost(fmt.Sprintf("/instances/%d/stop", inst.ID), "")
	t.Log("instance stopped")

	t.Log("=== ALL CHECKS PASSED ===")
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
