package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"

	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// mcpName was "channels" — channels MCP now runs in server
const defaultServerPort = 5280

func main() {
	themeName := flag.String("theme", "orange", "color theme: orange, amber, white")
	headless := flag.Bool("headless", false, "run server + core without TUI (dashboard only)")
	noSpawn := flag.Bool("no-spawn", false, "don't auto-start server, connect to existing")
	serverAddr := flag.String("server", "", "server address (e.g. localhost:5280)")
	serverBin := flag.String("server-bin", "", "path to apteva-server binary")
	remote := flag.Bool("remote", false, "connect to remote server")
	remoteURL := flag.String("remote-url", "", "remote server URL")
	remoteKey := flag.String("key", "", "API key for remote server")
	setup := flag.Bool("setup", false, "run setup wizard")
	flag.Parse()

	initCLILog()
	cliLog("MAIN", "starting apteva")

	// Load or init config
	aptevaCfg := loadAptevaConfig()
	cliLog("MAIN", fmt.Sprintf("config loaded: instanceID=%d apiKey=%v port=%d remote=%v", aptevaCfg.InstanceID, aptevaCfg.APIKey != "", aptevaCfg.ServerPort, aptevaCfg.Remote))
	if aptevaCfg.ServerPort == 0 {
		aptevaCfg.ServerPort = defaultServerPort
	}

	// Handle --remote flag
	if *remote {
		aptevaCfg.Remote = true
		if *remoteURL != "" {
			aptevaCfg.ServerURL = *remoteURL
		}
		if *remoteKey != "" {
			aptevaCfg.APIKey = *remoteKey
		}
		aptevaCfg.InstanceID = 0
		saveAptevaConfig(aptevaCfg)
	}

	th, ok := themes[*themeName]
	if !ok {
		fmt.Fprintf(os.Stderr, "unknown theme: %s\n", *themeName)
		os.Exit(1)
	}

	// Determine server address
	var srvAddr string
	if aptevaCfg.Remote && aptevaCfg.ServerURL != "" {
		srvAddr = aptevaCfg.ServerURL
	} else if *serverAddr != "" {
		srvAddr = *serverAddr
	} else {
		srvAddr = fmt.Sprintf("localhost:%d", aptevaCfg.ServerPort)
	}

	client := newCoreClient(srvAddr)

	// Clean orphaned WAL/SHM only if the DB file itself doesn't exist
	dbPath := filepath.Join(aptevaDir(), "apteva.db")
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		os.Remove(dbPath + "-shm")
		os.Remove(dbPath + "-wal")
		cliLog("MAIN", "cleaned orphaned DB WAL/SHM files")
	}

	// ── Phase 1: Ensure server is running ──
	cliLog("MAIN", fmt.Sprintf("checking server at %s", srvAddr))
	var serverProc *exec.Cmd

	// Kill any stale server from a previous session on our port
	// so we always start with the current binary
	if !aptevaCfg.Remote && !*noSpawn {
		killProcessOnPort(aptevaCfg.ServerPort)
	}

	if err := client.health(); err != nil {
		cliLog("MAIN", fmt.Sprintf("server not reachable: %v", err))
		if aptevaCfg.Remote || *noSpawn {
			fmt.Fprintf(os.Stderr, "cannot reach server at %s\n", srvAddr)
			os.Exit(1)
		}

		bin := findServerBinary(*serverBin)
		if bin == "" {
			fmt.Fprintf(os.Stderr, "cannot find apteva-server binary\n")
			os.Exit(1)
		}

		serverProc = exec.Command(bin)
		serverProc.Dir = filepath.Dir(bin)
		setProcGroup(serverProc)
		serverEnv := []string{
			"PORT=" + fmt.Sprintf("%d", aptevaCfg.ServerPort),
			"DB_PATH=" + filepath.Join(aptevaDir(), "apteva.db"),
			"DATA_DIR=" + aptevaDir(),
			"CORE_CMD=" + findCoreBinary(""),
			"APPS_DIR=" + findAppsDir(),
			"APTEVA_REGISTRATION=open", // local mode — same machine, safe to auto-register
		}
		if !*headless {
			serverEnv = append(serverEnv, "QUIET=1")
		}
		serverProc.Env = append(os.Environ(), serverEnv...)
		if *headless {
			// Headless: pipe server output to our stderr so telemetry logs are visible
			serverProc.Stdout = os.Stdout
			serverProc.Stderr = os.Stderr
		} else {
			serverProc.Stdout = nil
			serverProc.Stderr = nil
		}

		cliLog("MAIN", fmt.Sprintf("spawning server: %s", bin))
		cliLog("MAIN", fmt.Sprintf("server env: PORT=%d DB_PATH=%s CORE_CMD=%s", aptevaCfg.ServerPort, filepath.Join(aptevaDir(), "apteva.db"), findCoreBinary("")))

		if err := serverProc.Start(); err != nil {
			cliLog("MAIN", fmt.Sprintf("server start failed: %v", err))
			fmt.Fprintf(os.Stderr, "failed to start server: %v\n", err)
			os.Exit(1)
		}
		cliLog("MAIN", fmt.Sprintf("server process started, pid=%d", serverProc.Process.Pid))

		if err := waitForHealth(client, 15*time.Second); err != nil {
			cliLog("MAIN", fmt.Sprintf("server health timeout: %v", err))
			fmt.Fprintf(os.Stderr, "server did not start in time\n")
			serverProc.Process.Kill()
			os.Exit(1)
		}
	}

	// Copy dashboard dist to data dir (so server can serve it at /app/)
	copyDashboard()

	// ── Phase 2: Auto-bootstrap auth (invisible to user) ──
	cliLog("MAIN", "phase 2: auth bootstrap")
	needsAuth := aptevaCfg.APIKey == ""

	// Verify existing API key still works
	if !needsAuth {
		client.apiKey = aptevaCfg.APIKey
		if _, err := client.serverGet("/providers"); err != nil || func() bool {
			req, _ := http.NewRequest("GET", client.base+"/providers", nil)
			req.Header.Set("Authorization", "Bearer "+aptevaCfg.APIKey)
			resp, err := client.client.Do(req)
			if err != nil {
				return true
			}
			resp.Body.Close()
			return resp.StatusCode == 401
		}() {
			cliLog("MAIN", "existing API key invalid, re-bootstrapping")
			needsAuth = true
			aptevaCfg.APIKey = ""
			aptevaCfg.InstanceID = 0 // instance may also be gone
			client.apiKey = ""
		}
	}

	if needsAuth {
		if aptevaCfg.Remote {
			// Remote mode — need setup to get credentials
			cliLog("MAIN", "remote mode needs auth, running setup")
			if err := runSetup(client, &aptevaCfg); err != nil {
				fmt.Fprintf(os.Stderr, "%v\n", err)
				os.Exit(0)
			}
			saveAptevaConfig(aptevaCfg)
			client.apiKey = aptevaCfg.APIKey
		} else {
			cliLog("MAIN", "bootstrapping local auth")
			apiKey, userID, err := bootstrapLocalAuth(client, aptevaCfg)
			if err != nil {
				cliLog("MAIN", fmt.Sprintf("auth bootstrap failed: %v", err))
				fmt.Fprintf(os.Stderr, "auth setup failed: %v\n", err)
				os.Exit(1)
			}
			aptevaCfg.APIKey = apiKey
			aptevaCfg.UserID = userID
			saveAptevaConfig(aptevaCfg)
			cliLog("MAIN", fmt.Sprintf("auth bootstrapped: userID=%d keyPrefix=%s", userID, apiKey[:min(11, len(apiKey))]))
		}
	}
	client.apiKey = aptevaCfg.APIKey

	// ── Phase 3: Setup wizard (first run or --setup) ──
	cliLog("MAIN", fmt.Sprintf("phase 3: setup check (instanceID=%d, forceSetup=%v)", aptevaCfg.InstanceID, *setup))
	if *setup || aptevaCfg.InstanceID == 0 {
		cliLog("MAIN", "running setup wizard")
		if err := runSetup(client, &aptevaCfg); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			os.Exit(0)
		}
		saveAptevaConfig(aptevaCfg)
	}

	// ── Phase 4: Ensure instance is running ──
	cliLog("MAIN", fmt.Sprintf("phase 4: ensuring instance %d is running (headless=%v)", aptevaCfg.InstanceID, *headless))

	if !*headless {
		// TUI mode: auto-start the CLI's instance (user expects to chat immediately)
		cliLog("MAIN", "starting instance")
		if err := startInstance(client, aptevaCfg.InstanceID); err != nil {
			cliLog("MAIN", fmt.Sprintf("start instance: %v", err))
		}
	}
	// Headless mode: don't auto-start — user manages instances via API/dashboard

	client.instancePrefix = fmt.Sprintf("/instances/%d", aptevaCfg.InstanceID)
	if !*headless {
		// TUI mode: wait for instance to be healthy before showing chat
		if err := waitForHealth(client, 15*time.Second); err != nil {
			cliLog("MAIN", fmt.Sprintf("instance not healthy after start: %v", err))
			fmt.Fprintf(os.Stderr, "core instance not ready\n")
			os.Exit(1)
		}
		cliLog("MAIN", "instance healthy")
	}
	// Headless mode: skip health check — instances managed via API/dashboard

	// ── Phase 5: Start CLI or headless ──
	cliLog("MAIN", fmt.Sprintf("phase 5: headless=%v", *headless))

	cleanupDone := false
	cleanup := func() {
		if cleanupDone {
			return
		}
		cleanupDone = true
		cliLog("MAIN", "cleanup: shutting down")

		// Gracefully stop all instances (core writes final state to disk) before killing the server
		if client.apiKey != "" {
			cliLog("MAIN", "cleanup: stopping instances gracefully")
			fastClient := &http.Client{Timeout: 3 * time.Second}
			// List all instances and stop each one
			if data, err := client.serverGet("/instances"); err == nil {
				var insts []struct{ ID int64 `json:"id"` }
				json.Unmarshal(data, &insts)
				for _, inst := range insts {
					stopURL := fmt.Sprintf("http://%s/instances/%d/stop", srvAddr, inst.ID)
					req, _ := http.NewRequest("POST", stopURL, nil)
					req.Header.Set("Authorization", "Bearer "+client.apiKey)
					fastClient.Do(req)
					cliLog("MAIN", fmt.Sprintf("cleanup: stopped instance %d", inst.ID))
				}
			}
		}

		if serverProc != nil {
			cliLog("MAIN", "cleanup: killing server process group")
			killProcGroup(serverProc, false)
			done := make(chan error, 1)
			go func() { done <- serverProc.Wait() }()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				killProcGroup(serverProc, true)
				serverProc.Wait()
			}
			cliLog("MAIN", "cleanup: done")
		}
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, shutdownSignals()...)
	go func() { <-sig; cleanup(); os.Exit(0) }()

	if *headless {
		// Headless mode — just print status and block
		fmt.Fprintf(os.Stderr, "apteva running (headless)\n")
		fmt.Fprintf(os.Stderr, "  Dashboard: http://%s\n", srvAddr)
		fmt.Fprintf(os.Stderr, "  Instance:  %d (running)\n", aptevaCfg.InstanceID)
		fmt.Fprintf(os.Stderr, "  API key:   %s...\n", aptevaCfg.APIKey[:min(16, len(aptevaCfg.APIKey))])
		fmt.Fprintf(os.Stderr, "  Press Ctrl+C to stop\n")

		// Block until signal
		select {}
	}

	// TUI mode
	sseDone := make(chan struct{})
	cleanupTUI := func() {
		close(sseDone)
		// Notify core
		fastClient := &http.Client{Timeout: 2 * time.Second}
		req, _ := http.NewRequest("POST", client.coreURL("/event"), bytes.NewReader([]byte(`{"message":"[cli] root user disconnected from terminal","thread_id":"main"}`)))
		req.Header.Set("Content-Type", "application/json")
		if client.apiKey != "" {
			req.Header.Set("Authorization", "Bearer "+client.apiKey)
		}
		fastClient.Do(req)
		cleanup()
	}

	m := newTUI(th, client)
	m.aptevaCfg = aptevaCfg
	m.serverURL = "http://" + srvAddr
	m.sseDone = sseDone

	p := tea.NewProgram(m, tea.WithAltScreen())
	m.teaProgram = p
	go streamToolChunks(client, p, sseDone)
	go func() { p.Send(connectedMsg{}) }()

	if _, err := p.Run(); err != nil {
		cleanupTUI()
		fmt.Fprintf(os.Stderr, "tui: %v\n", err)
		os.Exit(1)
	}
	cleanupTUI()
}

// bootstrapLocalAuth registers the local user and creates an API key.
// Uses stored email/password from setup, or defaults.
func bootstrapLocalAuth(client *coreClient, cfg AptevaConfig) (apiKey string, userID int64, err error) {
	cliLog("AUTH", "bootstrapping local auth")
	email := cfg.AccountEmail
	password := cfg.AccountPassword
	if email == "" {
		email = "admin@local"
	}
	if password == "" {
		password = "admin"
	}

	// Register (may fail if already exists — that's fine)
	cliLog("AUTH", fmt.Sprintf("registering: %s", email))
	regBody, _ := json.Marshal(map[string]string{"email": email, "password": password})
	regResp, regErr := client.client.Post(client.base+"/auth/register", "application/json", bytes.NewReader(regBody))
	if regErr != nil {
		cliLog("AUTH", fmt.Sprintf("register error: %v", regErr))
	} else {
		cliLog("AUTH", fmt.Sprintf("register status: %d", regResp.StatusCode))
		regResp.Body.Close()
	}

	// Login
	cliLog("AUTH", "logging in")
	resp, err := client.client.Post(client.base+"/auth/login", "application/json", bytes.NewReader(regBody))
	if err != nil {
		return "", 0, fmt.Errorf("login: %w", err)
	}
	defer resp.Body.Close()

	// Read body for debugging
	respBody, _ := io.ReadAll(resp.Body)
	cliLog("AUTH", fmt.Sprintf("login response: status=%d body=%s", resp.StatusCode, string(respBody)))

	if resp.StatusCode != 200 {
		return "", 0, fmt.Errorf("login failed (HTTP %d): %s", resp.StatusCode, string(respBody))
	}

	var loginResult struct {
		UserID int64 `json:"user_id"`
	}
	json.Unmarshal(respBody, &loginResult)

	// Get session cookie
	var sessionCookie string
	for _, c := range resp.Cookies() {
		cliLog("AUTH", fmt.Sprintf("cookie: %s=%s", c.Name, c.Value[:min(10, len(c.Value))]))
		if c.Name == "session" {
			sessionCookie = c.Value
		}
	}
	if sessionCookie == "" {
		cliLog("AUTH", fmt.Sprintf("no session cookie in response, headers: %v", resp.Header))
		return "", 0, fmt.Errorf("no session cookie (login status=%d, user=%d)", resp.StatusCode, loginResult.UserID)
	}

	// Create API key
	keyBody, _ := json.Marshal(map[string]string{"name": "cli"})
	keyReq, _ := http.NewRequest("POST", client.base+"/auth/keys", bytes.NewReader(keyBody))
	keyReq.Header.Set("Content-Type", "application/json")
	keyReq.AddCookie(&http.Cookie{Name: "session", Value: sessionCookie})
	keyResp, err := client.client.Do(keyReq)
	if err != nil {
		return "", 0, fmt.Errorf("create key: %w", err)
	}
	defer keyResp.Body.Close()

	var keyResult struct {
		Key string `json:"key"`
	}
	json.NewDecoder(keyResp.Body).Decode(&keyResult)
	if keyResult.Key == "" {
		return "", 0, fmt.Errorf("no API key returned")
	}

	return keyResult.Key, loginResult.UserID, nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// ── Binary finders ──

func findCoreDir() string {
	self, _ := os.Executable()
	if self != "" {
		c := filepath.Join(filepath.Dir(self), "..", "core")
		if info, err := os.Stat(c); err == nil && info.IsDir() {
			abs, _ := filepath.Abs(c)
			return abs
		}
	}
	if info, err := os.Stat("../core"); err == nil && info.IsDir() {
		abs, _ := filepath.Abs("../core")
		return abs
	}
	cwd, _ := os.Getwd()
	return cwd
}

func findCoreBinary(explicit string) string {
	if explicit != "" {
		if _, err := os.Stat(explicit); err == nil {
			return explicit
		}
	}
	// Check env var from npx wrapper
	if p := os.Getenv("APTEVA_CORE_BIN"); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	self, _ := os.Executable()
	if self != "" {
		dir := filepath.Dir(self)
		for _, c := range []string{
			filepath.Join(dir, "..", "core", "apteva-core"),
			filepath.Join(dir, "..", "server", "apteva-core"),
			filepath.Join(dir, "apteva-core"),
		} {
			if _, err := os.Stat(c); err == nil {
				abs, _ := filepath.Abs(c)
				return abs
			}
		}
	}
	for _, c := range []string{"../core/apteva-core", "../server/apteva-core", "apteva-core"} {
		if _, err := os.Stat(c); err == nil {
			abs, _ := filepath.Abs(c)
			return abs
		}
	}
	if p, err := exec.LookPath("apteva-core"); err == nil {
		return p
	}
	return ""
}

func findServerBinary(explicit string) string {
	if explicit != "" {
		if _, err := os.Stat(explicit); err == nil {
			return explicit
		}
	}
	// Check env var from npx wrapper
	if p := os.Getenv("APTEVA_SERVER_BIN"); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	self, _ := os.Executable()
	if self != "" {
		dir := filepath.Dir(self)
		for _, c := range []string{
			filepath.Join(dir, "..", "server", "apteva-server"),
			filepath.Join(dir, "apteva-server"),
		} {
			if _, err := os.Stat(c); err == nil {
				abs, _ := filepath.Abs(c)
				return abs
			}
		}
	}
	for _, c := range []string{"../server/apteva-server", "apteva-server"} {
		if _, err := os.Stat(c); err == nil {
			abs, _ := filepath.Abs(c)
			return abs
		}
	}
	if p, err := exec.LookPath("apteva-server"); err == nil {
		return p
	}
	return ""
}

// findAppsDir locates the integrations app JSON directory.
func findAppsDir() string {
	self, _ := os.Executable()
	if self != "" {
		dir := filepath.Dir(self)
		for _, c := range []string{
			filepath.Join(dir, "..", "integrations", "src", "apps"),
			filepath.Join(dir, "..", "..", "integrations", "src", "apps"),
		} {
			if info, err := os.Stat(c); err == nil && info.IsDir() {
				abs, _ := filepath.Abs(c)
				return abs
			}
		}
	}
	for _, c := range []string{
		"../integrations/src/apps",
		"../../integrations/src/apps",
	} {
		if info, err := os.Stat(c); err == nil && info.IsDir() {
			abs, _ := filepath.Abs(c)
			return abs
		}
	}
	return ""
}

func waitForHealth(client *coreClient, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if err := client.health(); err == nil {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("timeout")
}

// killProcessOnPort kills any process listening on the given TCP port.
func killProcessOnPort(port int) {
	cmd := exec.Command("fuser", "-k", fmt.Sprintf("%d/tcp", port))
	cmd.Run()
	time.Sleep(200 * time.Millisecond)
}

// copyDashboard copies the dashboard dist/ to ~/.apteva/dashboard/ if available.
func copyDashboard() {
	// Look for dashboard dist relative to the CLI binary or server binary
	exe, _ := os.Executable()
	dir := filepath.Dir(exe)
	candidates := []string{
		filepath.Join(dir, "..", "dashboard", "dist"),
		filepath.Join(dir, "dashboard", "dist"),
	}
	var srcDir string
	for _, c := range candidates {
		if _, err := os.Stat(filepath.Join(c, "index.html")); err == nil {
			srcDir = c
			break
		}
	}
	if srcDir == "" {
		return
	}

	dstDir := filepath.Join(aptevaDir(), "dashboard")
	os.MkdirAll(dstDir, 0755)

	// Copy all files from dist/ to dashboard/
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(srcDir, e.Name()))
		if err != nil {
			continue
		}
		os.WriteFile(filepath.Join(dstDir, e.Name()), data, 0644)
	}
	cliLog("MAIN", fmt.Sprintf("dashboard copied to %s (%d files)", dstDir, len(entries)))
}
