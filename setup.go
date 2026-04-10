package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// setupConfig holds the choices made during onboarding.
type setupConfig struct {
	Remote       bool
	RemoteURL    string
	RemoteEmail  string
	RemotePass   string
	RemoteAPIKey string
	Provider     string
	APIKey       string
	AccountEmail    string
	AccountPassword string
	ModelLarge   string
	ModelMedium  string
	ModelSmall   string
	Computer       bool
	ComputerType   string // "local" or "browserbase"
	BrowserbaseKey string
	BrowserbasePID string
	Integrations   bool
	Telegram     bool
	Projects     bool
	Directive    string
}

type providerOption struct {
	Name   string
	Label  string
	EnvVar string
	Large  string
	Medium string
	Small  string
}

var providers = []providerOption{
	{Name: "fireworks", Label: "Fireworks (Kimi K2.5)", EnvVar: "FIREWORKS_API_KEY", Large: "accounts/fireworks/routers/kimi-k2p5-turbo", Medium: "accounts/fireworks/routers/kimi-k2p5-turbo", Small: "accounts/fireworks/routers/kimi-k2p5-turbo"},
	{Name: "anthropic", Label: "Anthropic (Claude)", EnvVar: "ANTHROPIC_API_KEY", Large: "claude-opus-4-6", Medium: "claude-sonnet-4-6", Small: "claude-haiku-4-5-20251001"},
	{Name: "openai", Label: "OpenAI (GPT-4)", EnvVar: "OPENAI_API_KEY", Large: "gpt-4.1", Medium: "gpt-4.1-mini", Small: "gpt-4.1-nano"},
	{Name: "google", Label: "Google (Gemini)", EnvVar: "GOOGLE_API_KEY", Large: "gemini-2.5-pro-preview-05-06", Medium: "gemini-2.5-flash-preview-04-17", Small: "gemini-2.5-flash-preview-04-17"},
}

type setupStep int

const (
	stepMode setupStep = iota // local vs remote
	stepRemoteURL             // remote server URL
	stepRemoteAuth            // login or API key
	stepRemoteLogin           // email input
	stepRemotePassword        // password input
	stepRemoteKey             // API key input
	stepRemoteInstance        // select instance
	stepProvider              // local: LLM provider
	stepAPIKey                // local: API key
	stepCapabilities          // local: features
	stepAccountEmail          // local: dashboard email
	stepAccountPassword       // local: dashboard password
	stepDirective             // local: directive
	stepDone
)

type setupModel struct {
	step     setupStep
	cursor   int
	input    textinput.Model
	config   setupConfig
	width    int
	height   int
	caps     []capOption
	client   *coreClient    // server client for API calls
	aptevaCfg *AptevaConfig // config to update
}

type capOption struct {
	label   string
	key     string
	enabled bool
}

func newSetupModel(client *coreClient, aptevaCfg *AptevaConfig) setupModel {
	ti := textinput.New()
	ti.CharLimit = 500
	ti.Prompt = ""
	ti.Focus()

	startStep := stepMode
	if aptevaCfg.Remote {
		if aptevaCfg.ServerURL != "" && aptevaCfg.APIKey == "" {
			startStep = stepRemoteAuth // have URL, need auth
		} else if aptevaCfg.ServerURL == "" {
			startStep = stepRemoteURL // need URL
		}
	}

	return setupModel{
		step:      startStep,
		input:     ti,
		client:    client,
		aptevaCfg: aptevaCfg,
		caps: []capOption{
			{label: "System tools (exec, web)", key: "tools", enabled: true},
			{label: "Browser (computer use)", key: "browser", enabled: false},
			{label: "Integrations (GitHub, Stripe, 263+ apps)", key: "integrations", enabled: false},
			{label: "Telegram gateway", key: "telegram", enabled: false},
		{label: "Projects (multi-project)", key: "projects", enabled: false},
		},
	}
}

func (m setupModel) Init() tea.Cmd { return textinput.Blink }

func (m setupModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.input.Width = m.width/2 - 10
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "esc":
			if m.step > stepProvider {
				m.step--
				return m, nil
			}
			return m, tea.Quit

		case "up", "k":
			if m.step == stepMode || m.step == stepRemoteAuth || m.step == stepProvider || m.step == stepCapabilities {
				if m.cursor > 0 {
					m.cursor--
				}
			}
		case "down", "j":
			if m.step == stepMode && m.cursor < 1 {
				m.cursor++
			}
			if m.step == stepRemoteAuth && m.cursor < 1 {
				m.cursor++
			}
			if m.step == stepProvider && m.cursor < len(providers)-1 {
				m.cursor++
			}
			if m.step == stepCapabilities && m.cursor < len(m.caps)-1 {
				m.cursor++
			}

		case " ":
			if m.step == stepCapabilities {
				m.caps[m.cursor].enabled = !m.caps[m.cursor].enabled
			}

		case "enter":
			switch m.step {
			case stepMode:
				if m.cursor == 0 {
					// Local
					m.config.Remote = false
					m.step = stepProvider
					m.cursor = 0
				} else {
					// Remote
					m.config.Remote = true
					m.step = stepRemoteURL
					m.input.SetValue("")
				}
				return m, nil

			case stepRemoteURL:
				url := strings.TrimSpace(m.input.Value())
				if url != "" {
					// Add https:// if no scheme
					if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
						url = "https://" + url
					}
					m.config.RemoteURL = url
					m.input.SetValue("")
					m.step = stepRemoteAuth
					m.cursor = 0
				}
				return m, nil

			case stepRemoteAuth:
				if m.cursor == 0 {
					// Login
					m.step = stepRemoteLogin
					m.input.SetValue("")
				} else {
					// API key
					m.step = stepRemoteKey
					m.input.SetValue("")
				}
				return m, nil

			case stepRemoteLogin:
				email := strings.TrimSpace(m.input.Value())
				if email != "" {
					m.config.RemoteEmail = email
					m.input.SetValue("")
					m.step = stepRemotePassword
				}
				return m, nil

			case stepRemotePassword:
				pass := strings.TrimSpace(m.input.Value())
				if pass != "" {
					m.config.RemotePass = pass
					m.input.SetValue("")
					m.applyRemoteAuth()
					m.step = stepDone
					return m, tea.Quit
				}
				return m, nil

			case stepRemoteKey:
				key := strings.TrimSpace(m.input.Value())
				if key != "" {
					m.config.RemoteAPIKey = key
					m.input.SetValue("")
					m.aptevaCfg.Remote = true
					m.aptevaCfg.ServerURL = m.config.RemoteURL
					m.aptevaCfg.APIKey = key
					// Verify and get instance
					m.client.apiKey = key
					m.client.base = m.config.RemoteURL
					m.applyRemoteInstance()
					m.step = stepDone
					return m, tea.Quit
				}
				return m, nil

			case stepProvider:
				p := providers[m.cursor]
				m.config.Provider = p.Name
				m.config.ModelLarge = p.Large
				m.config.ModelMedium = p.Medium
				m.config.ModelSmall = p.Small
				m.input.SetValue("")
				m.step = stepAPIKey
				return m, nil

			case stepAPIKey:
				key := strings.TrimSpace(m.input.Value())
				if key != "" {
					m.config.APIKey = key
					m.input.SetValue("")
					m.step = stepCapabilities
					m.cursor = 0
				}
				return m, nil

			case stepCapabilities:
				for _, c := range m.caps {
					switch c.key {
					case "browser":
						m.config.Computer = c.enabled
						if c.enabled {
							m.config.ComputerType = "local" // default, can change later via /computer
						}
					case "integrations":
						m.config.Integrations = c.enabled
					case "telegram":
						m.config.Telegram = c.enabled
					case "projects":
						m.config.Projects = c.enabled
					}
				}
				m.input.SetValue("")
				m.step = stepAccountEmail
				return m, nil

			case stepAccountEmail:
				username := strings.TrimSpace(m.input.Value())
				if username == "" {
					username = "admin"
				}
				// Server expects email format — append @local for local usernames
				email := username
				if !strings.Contains(email, "@") {
					email = username + "@local"
				}
				m.config.AccountEmail = email
				m.input.SetValue("")
				m.step = stepAccountPassword
				return m, nil

			case stepAccountPassword:
				pass := strings.TrimSpace(m.input.Value())
				if pass == "" {
					pass = "admin1234"
				}
				if len(pass) < 8 {
					// Don't advance — password too short
					return m, nil
				}
				m.config.AccountPassword = pass
				m.input.SetValue("")
				m.step = stepDirective
				return m, nil

			case stepDirective:
				directive := strings.TrimSpace(m.input.Value())
				if directive == "" {
					directive = "You are a helpful assistant. Respond to user messages and help with any task."
				}
				m.config.Directive = directive
				m.step = stepDone
				m.applyConfig()
				return m, tea.Quit
			}
		}
	}

	if m.step == stepAPIKey || m.step == stepDirective || m.step == stepRemoteURL || m.step == stepRemoteLogin || m.step == stepRemotePassword || m.step == stepRemoteKey || m.step == stepAccountEmail || m.step == stepAccountPassword {
		var cmd tea.Cmd
		m.input, cmd = m.input.Update(msg)
		return m, cmd
	}
	return m, nil
}

// applyConfig calls the server API to create provider + instance.
func (m *setupModel) applyConfig() {
	cliLog("SETUP", fmt.Sprintf("applying config: provider=%s directive=%q", m.config.Provider, m.config.Directive))
	// Save capabilities + account locally
	m.aptevaCfg.Capabilities = Capabilities{
		Tools:        true,
		Browser:      m.config.Computer,
		Integrations: m.config.Integrations,
		Telegram:     m.config.Telegram,
		Projects:     m.config.Projects,
	}
	m.aptevaCfg.AccountEmail = m.config.AccountEmail
	m.aptevaCfg.AccountPassword = m.config.AccountPassword

	// Bootstrap auth with the credentials from setup
	cliLog("SETUP", fmt.Sprintf("bootstrapping auth with %s", m.config.AccountEmail))
	apiKey, userID, err := bootstrapLocalAuth(m.client, *m.aptevaCfg)
	if err != nil {
		cliLog("SETUP", fmt.Sprintf("auth bootstrap failed: %v", err))
	} else {
		m.aptevaCfg.APIKey = apiKey
		m.aptevaCfg.UserID = userID
		m.client.apiKey = apiKey
		cliLog("SETUP", fmt.Sprintf("auth OK: userID=%d", userID))
	}

	// Download integration catalog if enabled
	if m.config.Integrations {
		cliLog("SETUP", "downloading integration catalog from GitHub...")
		m.client.serverPost("/integrations/catalog/download", nil)
		cliLog("SETUP", "catalog download complete")
	}

	// Create provider on server
	// Server expects: type, name, data (credentials map)
	p := getProviderByName(m.config.Provider)
	envVar := "FIREWORKS_API_KEY"
	if p != nil {
		envVar = p.EnvVar
	}
	providerBody, _ := json.Marshal(map[string]any{
		"type": m.config.Provider,
		"name": m.config.Provider,
		"data": map[string]string{
			envVar:         m.config.APIKey,
			"model_large":  m.config.ModelLarge,
			"model_medium": m.config.ModelMedium,
			"model_small":  m.config.ModelSmall,
		},
	})
	providerData, err := m.client.serverPost("/providers", providerBody)
	cliLog("SETUP", fmt.Sprintf("POST /providers response: %s err=%v", string(providerData), err))
	var providerResult struct {
		ID int64 `json:"id"`
	}
	json.Unmarshal(providerData, &providerResult)
	cliLog("SETUP", fmt.Sprintf("provider created: id=%d", providerResult.ID))

	// Ensure a default project exists (dashboard requires project_id on instances)
	projectID := ""
	if projData, err := m.client.serverGet("/projects"); err == nil {
		var projects []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		json.Unmarshal(projData, &projects)
		if len(projects) > 0 {
			projectID = projects[0].ID
		}
	}
	if projectID == "" {
		// Create a default project
		projBody, _ := json.Marshal(map[string]string{"name": "Default"})
		if projData, err := m.client.serverPost("/projects", projBody); err == nil {
			var proj struct {
				ID string `json:"id"`
			}
			json.Unmarshal(projData, &proj)
			projectID = proj.ID
		}
	}
	cliLog("SETUP", fmt.Sprintf("using project: %s", projectID))
	m.aptevaCfg.ProjectID = projectID

	// Create instance on server (always with project_id)
	instanceBody, _ := json.Marshal(map[string]any{
		"name":        "default",
		"directive":   m.config.Directive,
		"mode":        "autonomous",
		"provider_id": providerResult.ID,
		"project_id":  projectID,
	})
	instanceData, err2 := m.client.serverPost("/instances", instanceBody)
	cliLog("SETUP", fmt.Sprintf("POST /instances response: %s err=%v", string(instanceData), err2))
	var instanceResult struct {
		ID int64 `json:"id"`
	}
	json.Unmarshal(instanceData, &instanceResult)
	m.aptevaCfg.InstanceID = instanceResult.ID
	cliLog("SETUP", fmt.Sprintf("instance created: id=%d (project=%s)", instanceResult.ID, projectID))
}

func (m setupModel) View() string {
	if m.width == 0 {
		return ""
	}

	accent := lipgloss.NewStyle().Foreground(lipgloss.Color("208"))
	primary := lipgloss.NewStyle().Foreground(lipgloss.Color("208"))
	dim := lipgloss.NewStyle().Foreground(lipgloss.Color("94"))
	selected := lipgloss.NewStyle().Foreground(lipgloss.Color("214")).Bold(true)

	boxW := m.width * 60 / 100
	if boxW < 50 {
		boxW = m.width - 4
	}
	innerW := boxW - 4

	var title string
	var lines []string

	switch m.step {
	case stepMode:
		title = "SETUP"
		modeOptions := []string{"Start locally", "Connect to remote server"}
		lines = append(lines, "")
		for i, opt := range modeOptions {
			if i == m.cursor {
				lines = append(lines, selected.Render("  > "+opt))
			} else {
				lines = append(lines, primary.Render("    "+opt))
			}
		}
		lines = append(lines, "")
		lines = append(lines, dim.Render("  ↑↓ to select · enter to confirm"))

	case stepRemoteURL:
		title = "REMOTE SERVER"
		lines = append(lines, "")
		lines = append(lines, dim.Render("  Enter the server URL:"))
		lines = append(lines, "")
		lines = append(lines, "  "+accent.Render("URL: ")+m.input.View())
		lines = append(lines, "")
		lines = append(lines, dim.Render("  e.g. agents.example.com"))
		lines = append(lines, dim.Render("  enter to confirm · esc to go back"))

	case stepRemoteAuth:
		title = "AUTHENTICATE"
		authOptions := []string{"Login with email/password", "Use API key"}
		lines = append(lines, "")
		for i, opt := range authOptions {
			if i == m.cursor {
				lines = append(lines, selected.Render("  > "+opt))
			} else {
				lines = append(lines, primary.Render("    "+opt))
			}
		}
		lines = append(lines, "")
		lines = append(lines, dim.Render("  ↑↓ to select · enter to confirm"))

	case stepRemoteLogin:
		title = "LOGIN"
		lines = append(lines, "")
		lines = append(lines, dim.Render("  Enter your email:"))
		lines = append(lines, "")
		lines = append(lines, "  "+accent.Render("Email: ")+m.input.View())
		lines = append(lines, "")
		lines = append(lines, dim.Render("  enter to confirm · esc to go back"))

	case stepRemotePassword:
		title = "LOGIN"
		lines = append(lines, "")
		lines = append(lines, dim.Render("  Enter your password:"))
		lines = append(lines, "")
		lines = append(lines, "  "+accent.Render("Password: ")+m.input.View())
		lines = append(lines, "")
		lines = append(lines, dim.Render("  enter to confirm · esc to go back"))

	case stepRemoteKey:
		title = "API KEY"
		lines = append(lines, "")
		lines = append(lines, dim.Render("  Paste your API key:"))
		lines = append(lines, "")
		lines = append(lines, "  "+accent.Render("Key: ")+m.input.View())
		lines = append(lines, "")
		lines = append(lines, dim.Render("  enter to confirm · esc to go back"))

	case stepProvider:
		title = "LLM PROVIDER"
		lines = append(lines, "")
		lines = append(lines, dim.Render("  Select your LLM provider:"))
		lines = append(lines, "")
		for i, p := range providers {
			if i == m.cursor {
				lines = append(lines, selected.Render("  > "+p.Label))
			} else {
				lines = append(lines, primary.Render("    "+p.Label))
			}
		}
		lines = append(lines, "")
		lines = append(lines, dim.Render("  ↑↓ to select · enter to confirm · esc to quit"))

	case stepAPIKey:
		p := providers[m.cursor]
		title = strings.ToUpper(m.config.Provider) + " API KEY"
		lines = append(lines, "")
		lines = append(lines, dim.Render("  Paste your API key below."))
		lines = append(lines, dim.Render("  Or set "+p.EnvVar+" in your environment."))
		lines = append(lines, "")
		lines = append(lines, "  "+accent.Render("API key: ")+m.input.View())
		lines = append(lines, "")
		lines = append(lines, dim.Render("  enter to confirm · esc to go back"))

	case stepCapabilities:
		title = "CAPABILITIES"
		lines = append(lines, "")
		lines = append(lines, dim.Render("  What should the agent be able to do?"))
		lines = append(lines, "")
		for i, c := range m.caps {
			check := "[ ]"
			if c.enabled {
				check = "[x]"
			}
			if i == m.cursor {
				lines = append(lines, selected.Render("  > "+check+" "+c.label))
			} else {
				lines = append(lines, primary.Render("    "+check+" "+c.label))
			}
		}
		lines = append(lines, "")
		lines = append(lines, dim.Render("  ↑↓ move · space toggle · enter to confirm"))

	case stepAccountEmail:
		title = "DASHBOARD ACCOUNT"
		lines = append(lines, "")
		lines = append(lines, dim.Render("  Create a login for the web dashboard."))
		lines = append(lines, dim.Render("  Dashboard: http://localhost:5280"))
		lines = append(lines, "")
		lines = append(lines, "  "+accent.Render("Username: ")+m.input.View())
		lines = append(lines, "")
		lines = append(lines, dim.Render("  (default: admin)"))
		lines = append(lines, dim.Render("  enter to confirm · esc to go back"))

	case stepAccountPassword:
		title = "DASHBOARD PASSWORD"
		lines = append(lines, "")
		username := strings.TrimSuffix(m.config.AccountEmail, "@local")
		lines = append(lines, dim.Render("  Choose a password for "+username))
		lines = append(lines, "")
		lines = append(lines, "  "+accent.Render("Password: ")+m.input.View())
		lines = append(lines, "")
		lines = append(lines, dim.Render("  (default: admin1234 · min 8 chars)"))
		lines = append(lines, dim.Render("  enter to confirm · esc to go back"))

	case stepDirective:
		title = "DIRECTIVE"
		lines = append(lines, "")
		lines = append(lines, dim.Render("  What should the agent do?"))
		lines = append(lines, dim.Render("  (leave empty for general assistant)"))
		lines = append(lines, "")
		lines = append(lines, "  "+accent.Render("> ")+m.input.View())
		lines = append(lines, "")
		lines = append(lines, dim.Render("  enter to confirm · esc to go back"))
	}

	// Render centered box
	titleText := " " + title + " "
	titleLen := lipgloss.Width(titleText)
	topBorder := dim.Render("┌") + accent.Render(titleText) + dim.Render(strings.Repeat("─", max(0, innerW+2-titleLen))) + dim.Render("┐")
	bottomBorder := dim.Render("└" + strings.Repeat("─", innerW+2) + "┘")

	var contentLines []string
	for _, line := range lines {
		if lipgloss.Width(line) > innerW {
			line = truncateToWidth(line, innerW)
		}
		pad := innerW - lipgloss.Width(line)
		if pad < 0 {
			pad = 0
		}
		contentLines = append(contentLines, dim.Render("│ ")+line+strings.Repeat(" ", pad)+dim.Render(" │"))
	}
	for len(contentLines) < 8 {
		contentLines = append(contentLines, dim.Render("│ ")+strings.Repeat(" ", innerW)+dim.Render(" │"))
	}

	topPad := (m.height - len(contentLines) - 4) / 2
	leftPad := (m.width - boxW - 2) / 2
	if leftPad < 0 {
		leftPad = 0
	}
	indent := strings.Repeat(" ", leftPad)

	var out []string
	for i := 0; i < topPad-2; i++ {
		out = append(out, "")
	}
	out = append(out, indent+accent.Bold(true).Render("  APTEVA"))
	out = append(out, "")
	out = append(out, indent+topBorder)
	for _, cl := range contentLines {
		out = append(out, indent+cl)
	}
	out = append(out, indent+bottomBorder)
	for len(out) < m.height {
		out = append(out, "")
	}
	return strings.Join(out[:m.height], "\n")
}

// applyRemoteAuth logs in with email/password, creates API key, finds first instance.
func (m *setupModel) applyRemoteAuth() {
	cliLog("SETUP", fmt.Sprintf("remote auth: logging in to %s", m.config.RemoteURL))

	m.client.base = m.config.RemoteURL

	// Login
	loginBody, _ := json.Marshal(map[string]string{
		"email":    m.config.RemoteEmail,
		"password": m.config.RemotePass,
	})
	resp, err := m.client.client.Post(m.client.base+"/auth/login", "application/json", bytes.NewReader(loginBody))
	if err != nil {
		cliLog("SETUP", fmt.Sprintf("login failed: %v", err))
		return
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

	// Create API key
	keyBody, _ := json.Marshal(map[string]string{"name": "cli-remote"})
	keyReq, _ := http.NewRequest("POST", m.client.base+"/auth/keys", bytes.NewReader(keyBody))
	keyReq.Header.Set("Content-Type", "application/json")
	if sessionCookie != "" {
		keyReq.AddCookie(&http.Cookie{Name: "session", Value: sessionCookie})
	}
	keyResp, err := m.client.client.Do(keyReq)
	if err != nil {
		cliLog("SETUP", fmt.Sprintf("create key failed: %v", err))
		return
	}
	defer keyResp.Body.Close()

	var keyResult struct {
		Key string `json:"key"`
	}
	json.NewDecoder(keyResp.Body).Decode(&keyResult)

	m.aptevaCfg.Remote = true
	m.aptevaCfg.ServerURL = m.config.RemoteURL
	m.aptevaCfg.APIKey = keyResult.Key
	m.aptevaCfg.UserID = loginResult.UserID
	m.client.apiKey = keyResult.Key

	cliLog("SETUP", fmt.Sprintf("remote auth OK: userID=%d", loginResult.UserID))

	m.applyRemoteInstance()
}

// applyRemoteInstance finds the first running instance and sets it.
func (m *setupModel) applyRemoteInstance() {
	data, err := m.client.serverGet("/instances")
	if err != nil {
		cliLog("SETUP", fmt.Sprintf("list instances failed: %v", err))
		return
	}
	var instances []struct {
		ID        int64  `json:"id"`
		Name      string `json:"name"`
		ProjectID string `json:"project_id"`
	}
	json.Unmarshal(data, &instances)

	if len(instances) > 0 {
		m.aptevaCfg.InstanceID = instances[0].ID
		m.aptevaCfg.ProjectID = instances[0].ProjectID
		cliLog("SETUP", fmt.Sprintf("using instance %d (%s)", instances[0].ID, instances[0].Name))
	}
}

func getProviderByName(name string) *providerOption {
	for _, p := range providers {
		if p.Name == name {
			return &p
		}
	}
	return nil
}

// needsSetup returns true if no instance has been created yet.
func needsSetup(corePath string) bool {
	cfg := loadAptevaConfig()
	return cfg.InstanceID == 0
}

// runSetup runs the onboarding wizard.
func runSetup(client *coreClient, aptevaCfg *AptevaConfig) error {
	m := newSetupModel(client, aptevaCfg)
	p := tea.NewProgram(m, tea.WithAltScreen())
	finalModel, err := p.Run()
	if err != nil {
		return err
	}
	if sm, ok := finalModel.(setupModel); ok && sm.step != stepDone {
		return fmt.Errorf("setup cancelled")
	}
	return nil
}
