package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

const mcpName = "channels"
const defaultServerPort = 5280

func main() {
	themeName := flag.String("theme", "orange", "color theme: orange, amber, white")
	noSpawn := flag.Bool("no-spawn", false, "don't auto-start server, connect to existing")
	serverAddr := flag.String("server", "", "server address (e.g. localhost:8080)")
	serverBin := flag.String("server-bin", "", "path to apteva-server binary")
	setup := flag.Bool("setup", false, "run setup wizard")
	flag.Parse()

	initCLILog()
	cliLog("MAIN", "starting apteva")

	// Load or init config
	aptevaCfg := loadAptevaConfig()
	cliLog("MAIN", fmt.Sprintf("config loaded: instanceID=%d apiKey=%v port=%d", aptevaCfg.InstanceID, aptevaCfg.APIKey != "", aptevaCfg.ServerPort))
	if aptevaCfg.ServerPort == 0 {
		aptevaCfg.ServerPort = defaultServerPort
	}

	th, ok := themes[*themeName]
	if !ok {
		fmt.Fprintf(os.Stderr, "unknown theme: %s\n", *themeName)
		os.Exit(1)
	}

	// Determine server address
	srvAddr := *serverAddr
	if srvAddr == "" {
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
	if err := client.health(); err != nil {
		cliLog("MAIN", fmt.Sprintf("server not reachable: %v", err))
		if *noSpawn {
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
		serverProc.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // process group leader
		serverProc.Env = append(os.Environ(),
			"PORT="+fmt.Sprintf("%d", aptevaCfg.ServerPort),
			"DB_PATH="+filepath.Join(aptevaDir(), "apteva.db"),
			"DATA_DIR="+aptevaDir(),
			"CORE_CMD="+findCoreBinary(""),
			"QUIET=1",
		)
		serverProc.Stdout = nil
		serverProc.Stderr = nil

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
		cliLog("MAIN", "bootstrapping auth")
		apiKey, userID, err := bootstrapLocalAuth(client)
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
	cliLog("MAIN", fmt.Sprintf("phase 4: ensuring instance %d is running", aptevaCfg.InstanceID))

	// Always try to start the instance (server will skip if already running)
	cliLog("MAIN", "starting instance")
	if err := startInstance(client, aptevaCfg.InstanceID); err != nil {
		cliLog("MAIN", fmt.Sprintf("start instance: %v", err))
	}

	client.instancePrefix = fmt.Sprintf("/instances/%d", aptevaCfg.InstanceID)
	if err := waitForHealth(client, 15*time.Second); err != nil {
		cliLog("MAIN", fmt.Sprintf("instance not healthy after start: %v", err))
		fmt.Fprintf(os.Stderr, "core instance not ready\n")
		os.Exit(1)
	}
	cliLog("MAIN", "instance healthy")

	// ── Phase 5: Start CLI ──
	registry := NewChannelRegistry()
	cliRespond := make(chan string, 64)
	cliAskCh := make(chan string, 1)
	cliAskReply := make(chan string, 1)
	cliStatusCh := make(chan statusUpdate, 16)
	registry.Register(NewCLIChannel(cliRespond, cliAskCh, cliAskReply, cliStatusCh))

	mcp, err := newMCPServer(registry)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mcp server: %v\n", err)
		os.Exit(1)
	}
	go mcp.serve()
	cliLog("MAIN", fmt.Sprintf("phase 5: MCP server on %s", mcp.url()))

	cliLog("MAIN", "registering MCP with core via server proxy")
	if err := client.connectMCP(mcpName, mcp.url()); err != nil {
		cliLog("MAIN", fmt.Sprintf("MCP registration failed: %v", err))
		fmt.Fprintf(os.Stderr, "register mcp: %v\n", err)
		mcp.close()
		os.Exit(1)
	}
	cliLog("MAIN", "MCP registered, starting TUI")

	sseDone := make(chan struct{})

	cleanupDone := false
	cleanup := func() {
		if cleanupDone {
			return
		}
		cleanupDone = true
		cliLog("MAIN", "cleanup: shutting down")
		close(sseDone)
		mcp.close()

		// Use a short timeout client for cleanup calls
		fastClient := &http.Client{Timeout: 2 * time.Second}

		// Best-effort: notify core and unregister MCP
		go func() {
			req, _ := http.NewRequest("POST", client.coreURL("/event"), bytes.NewReader([]byte(`{"message":"[cli] root user disconnected","thread_id":"main"}`)))
			req.Header.Set("Content-Type", "application/json")
			if client.apiKey != "" {
				req.Header.Set("Authorization", "Bearer "+client.apiKey)
			}
			fastClient.Do(req)
		}()

		if serverProc != nil {
			cliLog("MAIN", "cleanup: killing server process group")
			// Kill the entire process group (server + core + mcp-gateway)
			pgid := serverProc.Process.Pid
			syscall.Kill(-pgid, syscall.SIGTERM)
			done := make(chan error, 1)
			go func() { done <- serverProc.Wait() }()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				syscall.Kill(-pgid, syscall.SIGKILL)
				serverProc.Wait()
			}
			cliLog("MAIN", "cleanup: done")
		}
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sig; cleanup(); os.Exit(0) }()

	m := newTUI(th, mcp, client, registry)
	m.cliRespond = cliRespond
	m.cliAskCh = cliAskCh
	m.cliAskReply = cliAskReply
	m.cliStatusCh = cliStatusCh
	m.aptevaCfg = aptevaCfg
	m.serverURL = "http://" + srvAddr

	p := tea.NewProgram(m, tea.WithAltScreen())
	go streamToolChunks(client, p, sseDone)
	go func() { p.Send(connectedMsg{}) }()

	if _, err := p.Run(); err != nil {
		cleanup()
		fmt.Fprintf(os.Stderr, "tui: %v\n", err)
		os.Exit(1)
	}
	cleanup()
}

// bootstrapLocalAuth silently registers a local user and creates an API key.
func bootstrapLocalAuth(client *coreClient) (apiKey string, userID int64, err error) {
	cliLog("AUTH", "bootstrapping local auth")
	// Generate random credentials — user never sees these
	localID := randomHex(8)
	email := "local-" + localID + "@apteva.local"
	password := randomHex(16)

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

	var loginResult struct {
		UserID int64 `json:"user_id"`
	}
	json.NewDecoder(resp.Body).Decode(&loginResult)

	// Get session cookie
	var sessionCookie string
	for _, c := range resp.Cookies() {
		if c.Name == "session" {
			sessionCookie = c.Value
		}
	}
	if sessionCookie == "" {
		return "", 0, fmt.Errorf("no session cookie")
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
