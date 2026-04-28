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
	"runtime"
	"strings"
	"os/signal"
	"path/filepath"

	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// mcpName was "channels" — channels MCP now runs in server
const defaultServerPort = 5280

func main() {
	// Subcommand dispatch — `apteva <subcommand> [args]`. Only the
	// known subcommands are intercepted; everything else falls through
	// to the default behaviour (run as a normal client / TUI).
	if len(os.Args) >= 2 {
		switch os.Args[1] {
		case "test":
			os.Exit(cmdTest(os.Args[2:]))
		}
	}

	themeName := flag.String("theme", "orange", "color theme: orange, amber, white")
	tui := flag.Bool("tui", false, "launch the chat TUI instead of dashboard mode")
	headless := flag.Bool("headless", false, "deprecated alias — same as default (dashboard mode)")
	noBrowser := flag.Bool("no-browser", false, "don't auto-open the dashboard in your browser")
	noSpawn := flag.Bool("no-spawn", false, "don't auto-start server, connect to existing")
	serverAddr := flag.String("server", "", "server address (e.g. localhost:5280)")
	serverBin := flag.String("server-bin", "", "path to apteva-server binary")
	remote := flag.Bool("remote", false, "connect to remote server")
	remoteURL := flag.String("remote-url", "", "remote server URL")
	remoteKey := flag.String("key", "", "API key for remote server")
	setup := flag.Bool("setup", false, "run setup wizard")
	reset := flag.Bool("reset", false, "wipe all data and start fresh")
	flag.Parse()
	_ = headless // accepted for backward compat; default is already dashboard mode

	initCLILog()

	if *reset {
		dir := aptevaDir()
		fmt.Fprintf(os.Stderr, "This will delete all data at %s\n", dir)
		fmt.Fprintf(os.Stderr, "Type 'yes' to confirm: ")
		var confirm string
		fmt.Scanln(&confirm)
		if confirm != "yes" {
			fmt.Fprintf(os.Stderr, "Cancelled.\n")
			os.Exit(0)
		}
		os.RemoveAll(dir)
		fmt.Fprintf(os.Stderr, "Data wiped. Starting fresh.\n")
	}

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
		// Built-in apps (kind=static UI bundles like `simple`) live at
		// monorepo-root/<app>/apteva.yaml on a developer machine. Tell
		// apteva-server where to scan; in the docker image the env var
		// is preset to /opt/apteva/apps so this branch is a no-op.
		if v := findBuiltinAppsDir(); v != "" {
			serverEnv = append(serverEnv, "BUILTIN_APPS_DIR="+v)
		}
		serverEnv = append(serverEnv, "QUIET=1")
		serverProc.Env = append(os.Environ(), serverEnv...)
		// Server output → ~/.apteva/server.log in both modes. TUI can't
		// share stderr without corrupting the alt-screen; dashboard mode
		// keeps the console clean for the URL banner.
		srvLog, err := os.OpenFile(
			filepath.Join(aptevaDir(), "server.log"),
			os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644,
		)
		if err == nil {
			serverProc.Stdout = srvLog
			serverProc.Stderr = srvLog
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

	// ── Phase 2: First-run setup + auth ──
	// On first run (no API key, no instance), run setup wizard FIRST so we have
	// the user's chosen email/password before trying to bootstrap auth.
	firstRun := aptevaCfg.APIKey == "" && aptevaCfg.InstanceID == 0
	needsAuth := aptevaCfg.APIKey == ""

	// Verify existing API key still works
	if !needsAuth {
		client.apiKey = aptevaCfg.APIKey
		if _, err := client.serverGet("/providers"); err != nil || func() bool {
			req, _ := http.NewRequest("GET", client.apiBase()+"/providers", nil)
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
			aptevaCfg.InstanceID = 0
			client.apiKey = ""
			firstRun = true
		}
	}

	if firstRun && !aptevaCfg.Remote && (*tui || *setup) {
		// First run, TUI/setup path: wizard collects email, password,
		// provider, directive. Dashboard mode skips this — bootstrap
		// uses default credentials and the user finishes setup in the
		// browser.
		cliLog("MAIN", "first run: launching setup wizard")
		if err := runSetup(client, &aptevaCfg); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			os.Exit(0)
		}
		saveAptevaConfig(aptevaCfg)
		needsAuth = aptevaCfg.APIKey == "" // setup may have created auth already
	}

	if needsAuth {
		if aptevaCfg.Remote {
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

	// ── Phase 3: Setup wizard (re-run if --setup or missing instance) ──
	cliLog("MAIN", fmt.Sprintf("phase 3: setup check (instanceID=%d, forceSetup=%v)", aptevaCfg.InstanceID, *setup))
	if *setup || (*tui && !firstRun && aptevaCfg.InstanceID == 0) {
		// Wizard runs explicitly via --setup, or on TUI launch when the
		// user has an account but no instance to chat with.
		cliLog("MAIN", "running setup wizard")
		if err := runSetup(client, &aptevaCfg); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			os.Exit(0)
		}
		saveAptevaConfig(aptevaCfg)
	}

	// ── Phase 4: Pick + start the instance ──
	cliLog("MAIN", fmt.Sprintf("phase 4: instance selection (saved=%d, tui=%v)", aptevaCfg.InstanceID, *tui))

	if *tui {
		// TUI mode: always show the instance picker first. This
		// replaces the old "auto-start whatever instanceID the
		// config says" path, which silently failed (stale ids → 404,
		// deleted instances, orphan rows) and left the user staring
		// at a blank terminal while waitForHealth timed out. The
		// picker reads the live /api/instances list so what the user
		// sees is always what exists right now.
		sel, newInst, cancel, err := runInstancePicker(th, client, &aptevaCfg)
		if err != nil {
			cliLog("MAIN", fmt.Sprintf("picker error: %v", err))
			fmt.Fprintf(os.Stderr, "could not load instances: %v\n", err)
			os.Exit(1)
		}
		if cancel {
			cliLog("MAIN", "picker: user cancelled")
			os.Exit(0)
		}
		if newInst {
			// Run the setup wizard to create a new instance.
			cliLog("MAIN", "picker: user chose to create new instance")
			if err := runSetup(client, &aptevaCfg); err != nil {
				fmt.Fprintf(os.Stderr, "%v\n", err)
				os.Exit(1)
			}
			saveAptevaConfig(aptevaCfg)
		} else if sel != nil {
			cliLog("MAIN", fmt.Sprintf("picker: selected instance %d (%q)", sel.id, sel.name))
			persistInstanceID(&aptevaCfg, sel.id)
		}

		// Ensure the chosen instance is running. startInstance now
		// surfaces HTTP errors (404 / 5xx / etc.) instead of silently
		// folding them into success, so waitForHealth never burns a
		// full 15s on a non-existent instance.
		cliLog("MAIN", fmt.Sprintf("starting instance %d", aptevaCfg.InstanceID))
		if err := startInstance(client, aptevaCfg.InstanceID); err != nil {
			cliLog("MAIN", fmt.Sprintf("start instance: %v", err))
			fmt.Fprintf(os.Stderr, "could not start instance: %v\n", err)
			os.Exit(1)
		}
	}
	// Dashboard mode: don't auto-start — user manages instances via the dashboard

	client.instancePrefix = fmt.Sprintf("/instances/%d", aptevaCfg.InstanceID)
	if *tui {
		// TUI mode: wait for instance to be healthy before showing chat
		if err := waitForHealth(client, 15*time.Second); err != nil {
			cliLog("MAIN", fmt.Sprintf("instance not healthy after start: %v", err))
			fmt.Fprintf(os.Stderr, "core instance not ready\n")
			os.Exit(1)
		}
		cliLog("MAIN", "instance healthy")
	}
	// Dashboard mode: skip health check — instances managed via the dashboard

	// ── Phase 5: Start dashboard mode or TUI ──
	cliLog("MAIN", fmt.Sprintf("phase 5: tui=%v", *tui))

	cleanupDone := false
	cleanup := func() {
		if cleanupDone {
			return
		}
		cleanupDone = true
		cliLog("MAIN", "cleanup: shutting down")

		// Gracefully stop only the CLI's own instance
		if client.apiKey != "" && aptevaCfg.InstanceID > 0 {
			cliLog("MAIN", fmt.Sprintf("cleanup: stopping instance %d", aptevaCfg.InstanceID))
			fastClient := &http.Client{Timeout: 3 * time.Second}
			stopURL := fmt.Sprintf("http://%s/instances/%d/stop", srvAddr, aptevaCfg.InstanceID)
			req, _ := http.NewRequest("POST", stopURL, nil)
			req.Header.Set("Authorization", "Bearer "+client.apiKey)
			fastClient.Do(req)
			cliLog("MAIN", fmt.Sprintf("cleanup: stopped instance %d", aptevaCfg.InstanceID))
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

	if !*tui {
		// Dashboard mode — print URL banner, open the browser, block.
		dashURL := "http://" + srvAddr
		fmt.Fprintf(os.Stderr, "\n  Apteva is running.\n\n")
		fmt.Fprintf(os.Stderr, "    Dashboard:  %s\n", dashURL)
		if aptevaCfg.APIKey != "" {
			fmt.Fprintf(os.Stderr, "    API key:    %s\n", aptevaCfg.APIKey)
		}
		fmt.Fprintf(os.Stderr, "    Server log: %s\n", filepath.Join(aptevaDir(), "server.log"))
		fmt.Fprintf(os.Stderr, "\n  Press Ctrl+C to stop. Re-run with --tui for the chat terminal.\n\n")

		if !*noBrowser {
			if err := openBrowser(dashURL); err != nil {
				cliLog("MAIN", fmt.Sprintf("browser open failed: %v", err))
			}
		}

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
		email = "admin"
	}
	if password == "" {
		password = "admin1234" // must be 8+ chars
	}

	// Register (may fail if already exists — that's fine)
	cliLog("AUTH", fmt.Sprintf("registering: %s", email))
	regBody, _ := json.Marshal(map[string]string{"email": email, "password": password})
	regResp, regErr := client.client.Post(client.apiBase()+"/auth/register", "application/json", bytes.NewReader(regBody))
	if regErr != nil {
		cliLog("AUTH", fmt.Sprintf("register error: %v", regErr))
	} else {
		cliLog("AUTH", fmt.Sprintf("register status: %d", regResp.StatusCode))
		regResp.Body.Close()
	}

	// Login
	cliLog("AUTH", "logging in")
	resp, err := client.client.Post(client.apiBase()+"/auth/login", "application/json", bytes.NewReader(regBody))
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
	keyReq, _ := http.NewRequest("POST", client.apiBase()+"/auth/keys", bytes.NewReader(keyBody))
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

// findBuiltinAppsDir returns "" by default in dev mode.
//
// "Built-in" means "shipped baked into the apteva-server image" —
// apps the operator gets for free without an explicit install action.
// In prod that's `/opt/apteva/apps` (set by the Dockerfile) and only
// contains the apps we deliberately bake in.
//
// In dev there's no equivalent — the monorepo root contains every
// sibling app repo (app-tasks, app-status, simple, …), and walking
// it would auto-register all of them as if they were pre-installed
// platform features. Wrong: those are user-installable apps that
// belong in the marketplace install flow. So we leave dev with no
// built-ins by default. To opt in for a specific test, the operator
// can set BUILTIN_APPS_DIR explicitly to a directory that contains
// only the truly-built-in apps they want.
func findBuiltinAppsDir() string {
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
	portStr := fmt.Sprintf("%d", port)
	switch runtime.GOOS {
	case "darwin":
		// macOS: use lsof to find PIDs on the port, then kill them
		out, err := exec.Command("lsof", "-ti", "tcp:"+portStr).Output()
		if err == nil {
			for _, pidStr := range strings.Split(strings.TrimSpace(string(out)), "\n") {
				if pidStr != "" {
					exec.Command("kill", "-9", pidStr).Run()
				}
			}
		}
	default:
		// Linux: fuser
		exec.Command("fuser", "-k", portStr+"/tcp").Run()
	}
	time.Sleep(300 * time.Millisecond)
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

	// Recursively copy dist/ to dashboard/. Vite builds produce a
	// subtree (dist/index.html + dist/assets/*.js|*.css); skipping
	// directories meant only index.html was copied, so the dashboard
	// loaded as a black page because every script tag 404'd.
	fileCount, dirCount := 0, 0
	walkErr := filepath.WalkDir(srcDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(srcDir, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		dst := filepath.Join(dstDir, rel)
		if d.IsDir() {
			dirCount++
			return os.MkdirAll(dst, 0755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			cliLog("MAIN", fmt.Sprintf("dashboard copy read failed: %s: %v", path, err))
			return nil
		}
		if err := os.WriteFile(dst, data, 0644); err != nil {
			cliLog("MAIN", fmt.Sprintf("dashboard copy write failed: %s: %v", dst, err))
			return nil
		}
		fileCount++
		return nil
	})
	if walkErr != nil {
		cliLog("MAIN", fmt.Sprintf("dashboard copy walk error: %v", walkErr))
	}
	cliLog("MAIN", fmt.Sprintf("dashboard copied from %s to %s (%d files, %d dirs)", srcDir, dstDir, fileCount, dirCount))
}

// openBrowser launches the platform's default browser pointing at url.
// Best-effort: if no browser is available (headless server, no DISPLAY,
// missing xdg-open), we just return the error and the caller carries on
// with the printed URL banner.
func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		// Skip the launch entirely on a headless Linux box — xdg-open
		// would either fail loudly or pop up a "select an application"
		// dialog over SSH.
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return fmt.Errorf("no display")
		}
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}
