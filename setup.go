package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// setupConfig holds the choices made during onboarding.
type setupConfig struct {
	Provider     string
	APIKey       string
	ModelLarge   string
	ModelSmall   string
	Computer     bool
	Integrations bool
	Telegram     bool
	Directive    string
}

type providerOption struct {
	Name   string
	Label  string
	EnvVar string
	Large  string
	Small  string
}

var providers = []providerOption{
	{Name: "fireworks", Label: "Fireworks (Kimi K2.5)", EnvVar: "FIREWORKS_API_KEY", Large: "accounts/fireworks/models/kimi-k2p5", Small: "accounts/fireworks/models/kimi-k2p5"},
	{Name: "anthropic", Label: "Anthropic (Claude)", EnvVar: "ANTHROPIC_API_KEY", Large: "claude-sonnet-4-20250514", Small: "claude-haiku-4-5-20251001"},
	{Name: "openai", Label: "OpenAI (GPT-4)", EnvVar: "OPENAI_API_KEY", Large: "gpt-4.1", Small: "gpt-4.1-mini"},
	{Name: "google", Label: "Google (Gemini)", EnvVar: "GOOGLE_API_KEY", Large: "gemini-2.5-pro-preview-05-06", Small: "gemini-2.5-flash-preview-04-17"},
}

type setupStep int

const (
	stepProvider setupStep = iota
	stepAPIKey
	stepCapabilities
	stepDirective
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

	return setupModel{
		step:      stepProvider,
		input:     ti,
		client:    client,
		aptevaCfg: aptevaCfg,
		caps: []capOption{
			{label: "System tools (exec, web)", key: "tools", enabled: true},
			{label: "Browser (local Chrome)", key: "browser", enabled: false},
			{label: "Integrations (GitHub, Stripe, 263+ apps)", key: "integrations", enabled: false},
			{label: "Telegram gateway", key: "telegram", enabled: false},
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
			if m.step == stepProvider || m.step == stepCapabilities {
				if m.cursor > 0 {
					m.cursor--
				}
			}
		case "down", "j":
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
			case stepProvider:
				p := providers[m.cursor]
				m.config.Provider = p.Name
				m.config.ModelLarge = p.Large
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
					case "integrations":
						m.config.Integrations = c.enabled
					case "telegram":
						m.config.Telegram = c.enabled
					}
				}
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

	if m.step == stepAPIKey || m.step == stepDirective {
		var cmd tea.Cmd
		m.input, cmd = m.input.Update(msg)
		return m, cmd
	}
	return m, nil
}

// applyConfig calls the server API to create provider + instance.
func (m *setupModel) applyConfig() {
	cliLog("SETUP", fmt.Sprintf("applying config: provider=%s directive=%q", m.config.Provider, m.config.Directive))
	// Save capabilities locally
	m.aptevaCfg.Capabilities = Capabilities{
		Tools:        true,
		Browser:      m.config.Computer,
		Integrations: m.config.Integrations,
		Telegram:     m.config.Telegram,
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
			envVar:       m.config.APIKey,
			"MODEL_LARGE": m.config.ModelLarge,
			"MODEL_SMALL": m.config.ModelSmall,
		},
	})
	providerData, err := m.client.serverPost("/providers", providerBody)
	cliLog("SETUP", fmt.Sprintf("POST /providers response: %s err=%v", string(providerData), err))
	var providerResult struct {
		ID int64 `json:"id"`
	}
	json.Unmarshal(providerData, &providerResult)
	cliLog("SETUP", fmt.Sprintf("provider created: id=%d", providerResult.ID))

	// Create instance on server
	instanceBody, _ := json.Marshal(map[string]any{
		"name":        "default",
		"directive":   m.config.Directive,
		"mode":        "autonomous",
		"provider_id": providerResult.ID,
	})
	instanceData, err2 := m.client.serverPost("/instances", instanceBody)
	cliLog("SETUP", fmt.Sprintf("POST /instances response: %s err=%v", string(instanceData), err2))
	var instanceResult struct {
		ID int64 `json:"id"`
	}
	json.Unmarshal(instanceData, &instanceResult)
	m.aptevaCfg.InstanceID = instanceResult.ID
	cliLog("SETUP", fmt.Sprintf("instance created: id=%d", instanceResult.ID))
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
