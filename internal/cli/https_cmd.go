package cli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/term"
)

type httpsCLITarget struct {
	Hostname string `json:"hostname"`
	Mode     string `json:"mode"`
}
type httpsCLIStatus struct {
	PublicURL string `json:"public_url"`
	State     struct {
		Phase     string          `json:"phase"`
		Message   string          `json:"message"`
		Addresses []string        `json:"addresses,omitempty"`
		Warnings  []string        `json:"warnings,omitempty"`
		Active    *httpsCLITarget `json:"active,omitempty"`
		Pending   *httpsCLITarget `json:"pending,omitempty"`
	} `json:"state"`
	Certificate json.RawMessage `json:"certificate"`
	Connections []struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	} `json:"connections"`
}

func cmdHTTPS(args []string) int {
	if len(args) == 0 {
		fmt.Println("Usage: apteva https setup [domain] [--cloudflare|--proxy] [--accept-terms]\n       apteva https status|doctor|retry|cancel [--json] [--data-dir PATH]\n       apteva https prepare-service --system [--restart] [--data-dir PATH]")
		return 0
	}
	action := args[0]
	args = args[1:]
	domain := ""
	if action == "setup" && len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		domain = args[0]
		args = args[1:]
	}
	fs := flag.NewFlagSet("https "+action, flag.ContinueOnError)
	cloudflare := fs.Bool("cloudflare", false, "use Cloudflare DNS validation")
	proxy := fs.Bool("proxy", false, "use HTTPS from an existing reverse proxy or tunnel")
	tokenFile := fs.String("cloudflare-token-file", "", "read a scoped Cloudflare API token from a file")
	connection := fs.Int64("connection", 0, "reuse an existing Cloudflare connection ID")
	certFile := fs.String("cert-file", "", "import a PEM certificate chain")
	keyFile := fs.String("key-file", "", "import the matching PEM private key")
	originCA := fs.Bool("cloudflare-origin", false, "trust Cloudflare proxy ranges when importing an Origin CA certificate")
	strict := fs.Bool("set-cloudflare-strict", false, "change the entire Cloudflare zone to Full (strict); requires Zone Settings Edit")
	email := fs.String("email", "", "ACME contact email for DNS certificate issuance")
	trusted := fs.String("trusted-proxies", "", "comma-separated trusted proxy CIDRs")
	httpPort := fs.Int("http-port", 80, "local HTTP listener port; public port 80 must route here for direct ACME")
	httpsPort := fs.Int("https-port", 443, "local HTTPS listener port; public port 443 must route here")
	terms := fs.Bool("accept-terms", false, "accept the configured ACME authority's terms (default: Let's Encrypt)")
	home := fs.String("data-dir", "", "instance data directory")
	asJSON := fs.Bool("json", false, "print JSON status")
	noWait := fs.Bool("no-wait", false, "start setup and return without waiting")
	system := fs.Bool("system", false, "prepare the installed system service")
	user := fs.Bool("user", false, "inspect user-service port requirements")
	restart := fs.Bool("restart", false, "restart the service after preparing low-port access")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 1 || fs.NArg() == 1 && (action != "setup" || domain != "") {
		fmt.Fprintln(os.Stderr, "unexpected HTTPS command arguments")
		return 2
	}
	selectedModes := 0
	for _, selected := range []bool{*cloudflare, *proxy, *certFile != "" || *keyFile != ""} {
		if selected {
			selectedModes++
		}
	}
	if selectedModes > 1 || (*certFile == "") != (*keyFile == "") || *system && *user {
		fmt.Fprintln(os.Stderr, "choose one connection mode; imported certificates require both --cert-file and --key-file")
		return 2
	}
	if *home != "" {
		absolute, err := filepath.Abs(expandHome(*home))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		_ = os.Setenv("APTEVA_HOME", absolute)
	}
	if action == "prepare-service" {
		return prepareHTTPSService(*system, *user, *restart)
	}
	if action != "setup" && action != "status" && action != "doctor" && action != "retry" && action != "cancel" {
		fmt.Fprintln(os.Stderr, "unknown https command:", action)
		return 2
	}
	if domain == "" && fs.NArg() == 1 {
		domain = fs.Arg(0)
	}
	if action == "status" {
		status, err := httpsAPI("GET", nil)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		printHTTPSStatus(status, *asJSON)
		return 0
	}
	payload := map[string]any{"action": "check"}
	if action == "retry" || action == "cancel" {
		payload["action"] = action
	}
	if action == "setup" {
		interactive := term.IsTerminal(int(os.Stdin.Fd()))
		reader := bufio.NewReader(os.Stdin)
		ask := func(label string) string {
			fmt.Fprint(os.Stderr, label)
			value, _ := reader.ReadString('\n')
			return strings.TrimSpace(value)
		}
		if domain == "" {
			if !interactive {
				fmt.Fprintln(os.Stderr, "provide a domain")
				return 2
			}
			domain = ask("Domain (e.g. agents.example.com): ")
		}
		mode := "direct"
		if *cloudflare {
			mode = "cloudflare"
		}
		if *proxy {
			mode = "proxy"
		}
		if *certFile != "" || *keyFile != "" {
			mode = "import"
		}
		if interactive && !*cloudflare && !*proxy && *certFile == "" && *keyFile == "" {
			choice := ask("Connection: 1) direct  2) Cloudflare  3) existing proxy [1]: ")
			switch choice {
			case "2":
				mode = "cloudflare"
			case "3":
				mode = "proxy"
			case "", "1":
			default:
				fmt.Fprintln(os.Stderr, "invalid connection choice")
				return 2
			}
		}
		if (mode == "direct" || mode == "cloudflare") && !*terms {
			if !interactive {
				fmt.Fprintln(os.Stderr, "use --accept-terms after reviewing the ACME authority's terms (default https://letsencrypt.org/repository/)")
				return 2
			}
			if !strings.EqualFold(ask("Accept the certificate authority's terms (default https://letsencrypt.org/repository/)? [y/N]: "), "y") {
				return 1
			}
			*terms = true
		}
		payload = map[string]any{"action": "setup", "hostname": domain, "mode": mode, "email": *email, "http_port": *httpPort, "https_port": *httpsPort, "accept_acme_terms": *terms, "connection_id": *connection, "set_cloudflare_strict": *strict, "trust_cloudflare": *originCA}
		if *trusted == "" && mode == "proxy" && interactive {
			*trusted = ask("Trusted proxy CIDRs, comma-separated (blank for loopback proxy): ")
		}
		if *trusted != "" {
			var cidrs []string
			for _, raw := range strings.Split(*trusted, ",") {
				cidrs = append(cidrs, strings.TrimSpace(raw))
			}
			payload["trusted_proxy_cidrs"] = cidrs
		}
		for name, path := range map[string]string{"cloudflare_token": *tokenFile, "certificate_pem": *certFile, "private_key_pem": *keyFile} {
			if path != "" {
				raw, err := os.ReadFile(expandHome(path))
				if err != nil {
					fmt.Fprintln(os.Stderr, err)
					return 1
				}
				if len(raw) > 64<<10 {
					fmt.Fprintln(os.Stderr, "credential file is too large")
					return 1
				}
				payload[name] = strings.TrimSpace(string(raw))
			}
		}
		if mode == "cloudflare" && *connection == 0 && *tokenFile == "" && interactive {
			if state, err := httpsAPI("GET", nil); err == nil {
				for _, conn := range state.Connections {
					fmt.Fprintf(os.Stderr, "Existing Cloudflare connection: %d · %s (use --connection %d)\n", conn.ID, conn.Name, conn.ID)
				}
			}
			fmt.Fprint(os.Stderr, "Cloudflare token (Zone Read + DNS Edit; blank retains a saved token): ")
			raw, err := term.ReadPassword(int(os.Stdin.Fd()))
			fmt.Fprintln(os.Stderr)
			if err != nil {
				return 1
			}
			if len(raw) > 0 {
				payload["cloudflare_token"] = string(raw)
			}
		}
		fmt.Fprintf(os.Stderr, "Point %s to this server. Public HTTPS must be reachable on port 443.\n", domain)
	}
	status, err := httpsAPI("POST", payload)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	printHTTPSStatus(status, *asJSON)
	if *noWait || action == "cancel" {
		return 0
	}
	deadline := time.Now().Add(9 * time.Minute)
	last := ""
	for time.Now().Before(deadline) {
		time.Sleep(2 * time.Second)
		status, err = httpsAPI("GET", nil)
		if err != nil {
			fmt.Fprintln(os.Stderr, "Waiting for the server to reconnect…")
			continue
		}
		if status.State.Phase+status.State.Message != last {
			printHTTPSStatus(status, *asJSON)
			last = status.State.Phase + status.State.Message
		}
		switch status.State.Phase {
		case "active", "ready":
			return 0
		case "error", "interrupted", "renewal_required":
			return 1
		}
	}
	fmt.Fprintln(os.Stderr, "Setup is still pending. Use apteva https status to check progress.")
	return 1
}

func httpsAPI(method string, payload map[string]any) (*httpsCLIStatus, error) {
	cfg := loadAptevaConfig()
	base := strings.TrimRight(cfg.ServerURL, "/")
	if base == "" || !cfg.Remote {
		port := cfg.ServerPort
		if port == 0 {
			port = defaultServerPort
		}
		base = fmt.Sprintf("http://127.0.0.1:%d", port)
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(method, base+"/api/settings/https", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	host := req.URL.Hostname()
	ip := net.ParseIP(host)
	if req.URL.Scheme != "https" && !(req.URL.Scheme == "http" && (host == "localhost" || ip != nil && ip.IsLoopback())) {
		return nil, fmt.Errorf("remote HTTPS administration requires an HTTPS server URL; alternatively run this command locally on the server over SSH")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	resp, err := (&http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("HTTPS setup: %s", strings.TrimSpace(string(body)))
	}
	var result httpsCLIStatus
	if err := json.NewDecoder(io.LimitReader(resp.Body, 128<<10)).Decode(&result); err != nil {
		return nil, err
	}
	return &result, nil
}
func printHTTPSStatus(status *httpsCLIStatus, asJSON bool) {
	if asJSON {
		raw, _ := json.MarshalIndent(status, "", "  ")
		fmt.Println(string(raw))
		return
	}
	fmt.Printf("%s: %s\n", status.State.Phase, status.State.Message)
	if status.PublicURL != "" {
		fmt.Println("Public address:", status.PublicURL)
	}
	if len(status.State.Addresses) > 0 {
		fmt.Println("DNS:", strings.Join(status.State.Addresses, ", "))
	}
	for _, warning := range status.State.Warnings {
		fmt.Println("Note:", warning)
	}
}

func prepareHTTPSService(system, user, restart bool) int {
	if runtime.GOOS != "linux" {
		fmt.Println("No systemd port-permission setup is needed on this platform. Use `apteva https doctor` to check listeners, or map public ports to higher local ports.")
		return 0
	}
	if user || !system {
		fmt.Fprintln(os.Stderr, "A user systemd service cannot grant itself low-port capabilities. Use local ports 8080/8443 with public port forwarding, an existing proxy, or prepare a system service using --system.")
		return 1
	}
	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "Run with sudo and --data-dir pointing to the intended instance directory.")
		return 1
	}
	identity, err := systemctlValue(scopeSystem, "show", serviceUnitName+".service", "-p", "ExecStart", "--value")
	if err != nil || !strings.Contains(identity, "path="+resolveBin("apteva-server")+" ;") {
		fmt.Fprintln(os.Stderr, "The system service does not point to this instance's versioned server. Check --data-dir before changing service permissions.")
		return 1
	}
	bounding, err := systemctlValue(scopeSystem, "show", serviceUnitName+".service", "-p", "CapabilityBoundingSet", "--value")
	if err != nil || !strings.Contains(strings.ToLower(bounding), "cap_net_bind_service") {
		fmt.Fprintln(os.Stderr, "The service capability bounding set does not permit CAP_NET_BIND_SERVICE. Adjust that service policy or use a proxy/higher local ports.")
		return 1
	}
	existing, err := systemctlValue(scopeSystem, "show", serviceUnitName+".service", "-p", "AmbientCapabilities", "--value")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	caps := strings.Fields(existing)
	found := false
	for _, cap := range caps {
		if strings.EqualFold(cap, "cap_net_bind_service") {
			found = true
		}
	}
	if !found {
		caps = append(caps, "CAP_NET_BIND_SERVICE")
	}
	unit, _, err := systemdUnitPath(scopeSystem)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	path := filepath.Join(filepath.Dir(unit), serviceUnitName+".service.d", "60-apteva-https.conf")
	if err := writeManagedSystemdDropIn(path, []byte("[Service]\nAmbientCapabilities="+strings.Join(caps, " ")+"\n")); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := systemctl(scopeSystem, "daemon-reload"); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if restart {
		if err := systemctl(scopeSystem, "restart", serviceUnitName); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		fmt.Println("HTTPS port capability configured and the system service restarted. Retry HTTPS setup.")
	} else {
		fmt.Println("HTTPS port capability configured. Restart the Apteva system service to apply it, then retry HTTPS setup.")
	}
	return 0
}
