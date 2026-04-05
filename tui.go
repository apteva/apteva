package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Messages
type respondMsg string
type askMsg string
type statusMsg statusUpdate
type connectedMsg struct{}
type tickMsg time.Time
type streamChunkMsg string    // incremental text from tool arg streaming
type toolReasonMsg string     // _reason from a tool call, for spinner display
type eventReceivedMsg struct {    // event received by a thread
	ThreadID string
	Source   string
	Message  string
}
type computerSelectMsg string    // re-dispatch /computer with selected value
type browserbaseKeyMsg string    // API key entered, chain to project ID input
type integrateConnectMsg struct { // integration connected result
	slug  string
	tools int
	err   error
}
type integrateAppInfoMsg struct { // app info fetched, needs credential input
	Slug  string         `json:"slug"`
	Name  string         `json:"name"`
	Auth  struct {
		CredentialFields []struct {
			Name        string `json:"name"`
			Label       string `json:"label"`
			Description string `json:"description"`
		} `json:"credential_fields"`
	} `json:"auth"`
	Tools []any `json:"tools"`
}

func (m integrateAppInfoMsg) Fields() []struct{ Name, Label, Description string } {
	var out []struct{ Name, Label, Description string }
	for _, f := range m.Auth.CredentialFields {
		out = append(out, struct{ Name, Label, Description string }{f.Name, f.Label, f.Description})
	}
	return out
}

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

type tuiModel struct {
	th          theme
	mcp         *mcpServer
	client      *coreClient
	registry    *ChannelRegistry
	input       textinput.Model
	lines       []styledLine // scrollback buffer
	scrollOff   int
	width       int
	height      int
	connected      bool
	waitingConnect bool // waiting for user to press Enter to connect
	waiting        bool // waiting for core to cli_respond
	asking      bool // core asked a question via cli_ask
	streaming   bool // currently receiving streamed tool chunks
	streamLine  int  // index into lines for the active streaming line
	spinnerTick  int    // animation frame counter
	toolReason   string // latest _reason from tool call, shown in spinner
	statusLine   string
	statusLevel  string
	startTime    time.Time
	pollCounter  int // counts ticks for periodic polling

	// Live side panel data
	sideStatus    *sideData
	lastPollTick  int
	thoughts      map[string]*threadThought // latest thought per thread
	events        map[string]*threadEvent  // latest event per thread

	// CLI channel pipes (set by main after construction)
	cliRespond  chan string
	cliAskCh    chan string
	cliAskReply chan string
	cliStatusCh chan statusUpdate

	// Apteva config
	aptevaCfg AptevaConfig
	serverURL string // integration server URL (empty = no server)

	// Gateways
	telegramGW *TelegramGateway

	// Modal overlay — display, input, or select
	modal        bool
	modalTitle   string
	modalLines   []string
	modalScroll  int
	modalInput   bool                        // modal has an input field
	modalPrompt  string                      // input label
	modalOnSubmit func(value string) tea.Cmd // callback when input submitted
	modalSelect  bool                        // modal has selectable items
	modalItems   []string                    // selectable items
	modalCursor  int                         // selected item index
	modalOnSelect func(value string) tea.Cmd // callback when item selected
}

// sideData holds live data for the side panel.
type sideData struct {
	Status    string
	Uptime    string
	Iteration int
	Rate      string
	Model     string
	Mode      string
	Threads   []sideThread
	Memories  int
	Directive string
	Computer  string // "local", "browserbase", or "" (off)
}

type sideThread struct {
	ID   string
	Rate string
	Iter int
}

type sideDataMsg *sideData

type threadThought struct {
	Text string
	Time time.Time
}

type thoughtMsg struct {
	ThreadID string
	Text     string
}

type threadEvent struct {
	Source  string
	Message string
	Time    time.Time
}

type connectResultMsg struct {
	gateway string
	botName string
	err     error
	gw      *TelegramGateway
}

type modalMsg struct {
	title string
	text  string
}

type styledLine struct {
	text  string
	style string // "input", "output", "dim", "warn", "alert", "system"
	ts    time.Time
}

func newTUI(th theme, mcp *mcpServer, client *coreClient, registry *ChannelRegistry) tuiModel {
	ti := textinput.New()
	ti.Placeholder = ""
	ti.CharLimit = 1000
	ti.Prompt = ""
	ti.Focus()
	ti.TextStyle = lipgloss.NewStyle().Foreground(th.Primary)
	ti.Cursor.Style = lipgloss.NewStyle().Foreground(th.Accent)

	return tuiModel{
		th:        th,
		mcp:       mcp,
		registry:  registry,
		thoughts:  make(map[string]*threadThought),
		events:    make(map[string]*threadEvent),
		client:    client,
		input:     ti,
		startTime: time.Now(),
	}
}

func (m tuiModel) Init() tea.Cmd {
	return tea.Batch(
		textinput.Blink,
		listenRespond(m.cliRespond),
		listenAsk(m.cliAskCh),
		listenStatus(m.cliStatusCh),
		tickEvery(),
		pollSideData(m.client),
	)
}

func listenRespond(ch chan string) tea.Cmd {
	return func() tea.Msg {
		return respondMsg(<-ch)
	}
}

func listenAsk(ch chan string) tea.Cmd {
	return func() tea.Msg {
		return askMsg(<-ch)
	}
}

func listenStatus(ch chan statusUpdate) tea.Cmd {
	return func() tea.Msg {
		return statusMsg(<-ch)
	}
}

func tickEvery() tea.Cmd {
	return tea.Tick(150*time.Millisecond, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func pollSideData(client *coreClient) tea.Cmd {
	return func() tea.Msg {
		sd := &sideData{}

		if st, err := client.status(); err == nil {
			uptime, _ := st["uptime_seconds"].(float64)
			iter, _ := st["iteration"].(float64)
			rate, _ := st["rate"].(string)
			model, _ := st["model"].(string)
			mode, _ := st["mode"].(string)
			paused, _ := st["paused"].(bool)
			memories, _ := st["memories"].(float64)
			sd.Uptime = formatDuration(time.Duration(uptime) * time.Second)
			sd.Iteration = int(iter)
			sd.Rate = rate
			sd.Model = model
			sd.Mode = mode
			sd.Memories = int(memories)
			if paused {
				sd.Status = "PAUSED"
			} else {
				sd.Status = "RUNNING"
			}
		}

		if threads, err := client.threads(); err == nil {
			for _, t := range threads {
				id, _ := t["id"].(string)
				rate, _ := t["rate"].(string)
				iter, _ := t["iteration"].(float64)
				sd.Threads = append(sd.Threads, sideThread{ID: id, Rate: rate, Iter: int(iter)})
			}
		}

		if cfg, err := client.getConfig(); err == nil {
			directive, _ := cfg["directive"].(string)
			sd.Directive = directive
			if comp, ok := cfg["computer"].(map[string]any); ok && comp != nil {
				if connected, _ := comp["connected"].(bool); connected {
					if t, ok := comp["type"].(string); ok {
						sd.Computer = t
					}
				}
			}
		}

		return sideDataMsg(sd)
	}
}

func (m tuiModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.KeyMsg:
		// Modal mode
		if m.modal {
			switch msg.String() {
			case "esc":
				m.closeModal()
				return m, nil
			case "enter":
				if m.modalInput && m.modalOnSubmit != nil {
					value := strings.TrimSpace(m.input.Value())
					m.input.SetValue("")
					m.input.Placeholder = ""
					cb := m.modalOnSubmit
					m.closeModal()
					if value != "" {
						return m, cb(value)
					}
					return m, nil
				}
				if m.modalSelect && m.modalOnSelect != nil && m.modalCursor < len(m.modalItems) {
					value := m.modalItems[m.modalCursor]
					cb := m.modalOnSelect
					m.closeModal()
					return m, cb(value)
				}
			case "q":
				if !m.modalInput && !m.modalSelect {
					m.closeModal()
					return m, nil
				}
			case "up", "k":
				if m.modalSelect {
					if m.modalCursor > 0 {
						m.modalCursor--
					}
					return m, nil
				}
				if !m.modalInput {
					if m.modalScroll > 0 {
						m.modalScroll--
					}
					return m, nil
				}
			case "down", "j":
				if m.modalSelect {
					if m.modalCursor < len(m.modalItems)-1 {
						m.modalCursor++
					}
					return m, nil
				}
				if !m.modalInput {
					m.modalScroll++
					return m, nil
				}
			case "pgup":
				if !m.modalInput && !m.modalSelect {
					if m.modalScroll > 0 {
						m.modalScroll--
					}
					return m, nil
				}
			case "pgdown":
				if !m.modalInput && !m.modalSelect {
					m.modalScroll++
					return m, nil
				}
			}
			if m.modalInput {
				var inputCmd tea.Cmd
				m.input, inputCmd = m.input.Update(msg)
				return m, inputCmd
			}
			return m, nil
		}
		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "esc":
			// no-op outside modal
		case "enter":
			if m.waitingConnect {
				m.waitingConnect = false
				go m.client.sendEvent("[cli] root user connected. RULES: 1) Reply to ALL [cli] messages using channels_respond(channel=\"cli\"). 2) When the user asks you to do something, IMMEDIATELY acknowledge what you will do BEFORE doing it, then follow up with the result. 3) Never leave a message unanswered. Greet them now.", "main")
				return m, nil
			}
			return m.handleInput()
		case "pgup":
			if m.scrollOff < len(m.lines)-1 {
				m.scrollOff += 5
			}
			return m, nil
		case "pgdown":
			m.scrollOff -= 5
			if m.scrollOff < 0 {
				m.scrollOff = 0
			}
			return m, nil
		}

	case modalMsg:
		m.modal = true
		m.modalTitle = msg.title
		m.modalLines = strings.Split(msg.text, "\n")
		m.modalScroll = 0
		return m, nil

	case streamChunkMsg:
		text := string(msg)
		if !m.streaming {
			// Start a new streaming line — add spacing if there's content above
			m.streaming = true
			m.waiting = false
			m.toolReason = ""
			if len(m.lines) > 0 && m.lines[len(m.lines)-1].text != "" {
				m.addLine("", "dim")
			}
			m.addLine(text, "output")
			m.streamLine = len(m.lines) - 1
		} else {
			// Append to current streaming line, handling newlines
			lines := strings.Split(text, "\n")
			if m.streamLine >= 0 && m.streamLine < len(m.lines) {
				m.lines[m.streamLine].text += lines[0]
			}
			for _, extra := range lines[1:] {
				m.addLine(extra, "output")
				m.streamLine = len(m.lines) - 1
			}
		}
		m.scrollOff = 0

	case respondMsg:
		// Full response arrived via MCP tool call — if we were streaming, just finalize
		if m.streaming {
			m.streaming = false
			m.streamLine = -1
		} else {
			if len(m.lines) > 0 && m.lines[len(m.lines)-1].text != "" {
				m.addLine("", "dim")
			}
			m.addLine(string(msg), "output")
		}
		m.waiting = false
		m.toolReason = ""
		m.scrollOff = 0
		cmds = append(cmds, listenRespond(m.cliRespond))

	case askMsg:
		m.asking = true
		m.waiting = false
		m.addLine(string(msg), "output")
		m.scrollOff = 0
		cmds = append(cmds, listenAsk(m.cliAskCh))

	case statusMsg:
		m.statusLine = msg.Line
		m.statusLevel = msg.Level
		cmds = append(cmds, listenStatus(m.cliStatusCh))

	case connectedMsg:
		m.connected = true
		m.waitingConnect = true // wait for user to press Enter before sending connect event

	case connectResultMsg:
		if msg.err != nil {
			m.openModal("CONNECT ERROR", []string{"", "  " + msg.err.Error(), "", "  Press Esc to close."})
		} else {
			if msg.gw != nil {
				m.telegramGW = msg.gw
				m.registry.AddFactory(msg.gw.ChannelFactory())
			}
			m.openModal(strings.ToUpper(msg.gateway)+" CONNECTED", []string{"", fmt.Sprintf("  Bot @%s online.", msg.botName), "", "  Press Esc to close."})
			m.client.sendEvent(fmt.Sprintf("[%s] gateway connected. Bot @%s online. The agent can send messages to any telegram user who has started this bot using channels_respond(channel=\"%s:<chat_id>\"). When a user messages the bot, their chat_id appears in the event prefix.",
				msg.gateway, msg.botName, msg.gateway), "main")
		}
		return m, nil

	case toolReasonMsg:
		m.toolReason = string(msg)
		return m, nil

	case integrateAppInfoMsg:
		fields := msg.Fields()
		if len(fields) == 0 {
			m.openModal("INTEGRATE", []string{"", "  No credential fields for " + msg.Name})
			return m, nil
		}
		field := fields[0]
		label := field.Label
		if label == "" {
			label = field.Name
		}
		desc := field.Description
		if desc == "" {
			desc = fmt.Sprintf("Enter your %s %s", msg.Name, label)
		}
		cli := m.client
		slug := msg.Slug
		appName := msg.Name
		fieldName := field.Name
		m.openInputModal(
			"CONNECT "+strings.ToUpper(appName),
			[]string{"", "  " + desc, ""},
			label,
			func(value string) tea.Cmd {
				return func() tea.Msg {
					// Create connection via server API
					body, _ := json.Marshal(map[string]any{
						"app_slug":  slug,
						"name":      slug,
						"auth_type": "api_key",
						"credentials": map[string]string{
							fieldName: value,
						},
					})
					respData, err := cli.serverPost("/connections", body)
					if err != nil {
						return integrateConnectMsg{slug: slug, err: err}
					}
					var result struct {
						ID int64 `json:"id"`
					}
					json.Unmarshal(respData, &result)
					if result.ID == 0 {
						return integrateConnectMsg{slug: slug, err: fmt.Errorf("connection failed")}
					}
					return integrateConnectMsg{slug: slug, tools: 0} // tool count fetched later
				}
			},
		)
		return m, nil

	case integrateConnectMsg:
		if msg.err != nil {
			m.openModal("INTEGRATE ERROR", []string{"", "  " + msg.err.Error(), "", "  Press Esc to close."})
		} else {
			m.openModal(strings.ToUpper(msg.slug)+" CONNECTED", []string{
				"",
				fmt.Sprintf("  %d tools registered.", msg.tools),
				"",
				"  The agent can now use this integration.",
				"",
				"  Press Esc to close.",
			})
		}
		return m, nil

	case computerSelectMsg:
		// Re-dispatch as if user typed /computer <value>
		return m.handleCommand("/computer " + string(msg))

	case browserbaseKeyMsg:
		apiKey := string(msg)
		cli := m.client
		m.openInputModal(
			"BROWSERBASE",
			[]string{
				"",
				"  Now enter your Browserbase project ID.",
				"",
			},
			"Project ID",
			func(projectID string) tea.Cmd {
				return func() tea.Msg {
					err := cli.setComputer(map[string]any{
						"type":       "browserbase",
						"api_key":    apiKey,
						"project_id": projectID,
						"width":      1280,
						"height":     800,
					})
					if err != nil {
						return modalMsg{title: "BROWSERBASE", text: fmt.Sprintf("  ERROR: %v", err)}
					}
					return modalMsg{title: "BROWSERBASE", text: "  Browserbase connected (1280x800)."}
				}
			},
		)
		return m, nil

	case sideDataMsg:
		m.sideStatus = msg
		return m, nil

	case thoughtMsg:
		m.thoughts[msg.ThreadID] = &threadThought{Text: msg.Text, Time: time.Now()}
		return m, nil

	case eventReceivedMsg:
		m.events[msg.ThreadID] = &threadEvent{Source: msg.Source, Message: msg.Message, Time: time.Now()}
		return m, nil

	case tickMsg:
		m.spinnerTick++
		m.pollCounter++
		// Poll every ~3s (20 ticks * 150ms)
		if m.pollCounter-m.lastPollTick >= 20 {
			m.lastPollTick = m.pollCounter
			cmds = append(cmds, pollSideData(m.client))
		}
		cmds = append(cmds, tickEvery())

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.input.Width = m.chatWidth() - 6
	}

	var inputCmd tea.Cmd
	m.input, inputCmd = m.input.Update(msg)
	cmds = append(cmds, inputCmd)

	return m, tea.Batch(cmds...)
}

func (m *tuiModel) chatWidth() int {
	return m.width * 2 / 3
}

func (m *tuiModel) sideWidth() int {
	return m.width - m.chatWidth() - 1 // -1 for the vertical border
}

func (m *tuiModel) handleInput() (tuiModel, tea.Cmd) {
	text := strings.TrimSpace(m.input.Value())
	if text == "" {
		return *m, nil
	}
	m.input.SetValue("")

	// If answering a cli_ask question
	if m.asking {
		m.asking = false
		m.addLine("> "+text, "input")
		m.cliAskReply <- text
		return *m, nil
	}

	// Local commands
	if strings.HasPrefix(text, "/") {
		return m.handleCommand(text)
	}

	// Send to core — add spacing around user message
	if len(m.lines) > 0 {
		m.addLine("", "dim")
	}
	m.addLine("> "+text, "input")
	m.addLine("", "dim")
	m.waiting = true
	m.scrollOff = 0
	go m.client.sendEvent("[cli] "+text, "main")

	return *m, nil
}

func (m *tuiModel) handleCommand(text string) (tuiModel, tea.Cmd) {
	parts := strings.Fields(text)
	cmd := parts[0]

	switch cmd {
	case "/quit", "/exit":
		return *m, tea.Quit

	case "/clear":
		m.lines = nil
		m.scrollOff = 0

	case "/status":
		return *m, func() tea.Msg {
			st, err := m.client.status()
			if err != nil {
				return modalMsg{title: "STATUS", text: fmt.Sprintf("ERROR: %v", err)}
			}
			uptime, _ := st["uptime_seconds"].(float64)
			iter, _ := st["iteration"].(float64)
			rate, _ := st["rate"].(string)
			model, _ := st["model"].(string)
			threads, _ := st["threads"].(float64)
			memories, _ := st["memories"].(float64)
			mode, _ := st["mode"].(string)
			paused, _ := st["paused"].(bool)

			status := "RUNNING"
			if paused {
				status = "PAUSED"
			}

			return modalMsg{
				title: "STATUS",
				text: fmt.Sprintf(
					"  STATUS:     %s\n  UPTIME:     %s\n  ITERATION:  %.0f\n  RATE:       %s\n  MODEL:      %s\n  MODE:       %s\n  THREADS:    %.0f\n  MEMORY:     %.0f entries",
					status, formatDuration(time.Duration(uptime)*time.Second), iter, rate, model, mode, threads, memories,
				),
			}
		}

	case "/config":
		return *m, func() tea.Msg {
			cfg, err := m.client.getConfig()
			if err != nil {
				return modalMsg{title: "CONFIG", text: fmt.Sprintf("ERROR: %v", err)}
			}
			mode, _ := cfg["mode"].(string)
			directive, _ := cfg["directive"].(string)
			var sb strings.Builder
			sb.WriteString(fmt.Sprintf("  MODE:       %s\n\n", mode))
			sb.WriteString(fmt.Sprintf("  DIRECTIVE:\n  %s\n", directive))
			if prov, ok := cfg["provider"].(map[string]any); ok {
				name, _ := prov["name"].(string)
				sb.WriteString(fmt.Sprintf("\n  PROVIDER:   %s\n", name))
				if models, ok := prov["models"].(map[string]any); ok {
					for tier, id := range models {
						sb.WriteString(fmt.Sprintf("    %s: %v\n", tier, id))
					}
				}
			}
			if mcps, ok := cfg["mcp_servers"].([]any); ok && len(mcps) > 0 {
				sb.WriteString(fmt.Sprintf("\n  MCP SERVERS: %d\n", len(mcps)))
				for _, raw := range mcps {
					if entry, ok := raw.(map[string]any); ok {
						name, _ := entry["name"].(string)
						sb.WriteString(fmt.Sprintf("    - %s\n", name))
					}
				}
			}
			return modalMsg{title: "CONFIG", text: sb.String()}
		}

	case "/directive":
		rest := strings.TrimSpace(strings.TrimPrefix(text, "/directive"))
		if rest == "" {
			return *m, func() tea.Msg {
				cfg, err := m.client.getConfig()
				if err != nil {
					return modalMsg{title: "DIRECTIVE", text: fmt.Sprintf("ERROR: %v", err)}
				}
				directive, _ := cfg["directive"].(string)
				return modalMsg{title: "DIRECTIVE", text: "  " + directive}
			}
		}
		return *m, func() tea.Msg {
			if err := m.client.setDirective(rest); err != nil {
				return modalMsg{title: "DIRECTIVE", text: fmt.Sprintf("ERROR: %v", err)}
			}
			return modalMsg{title: "DIRECTIVE", text: "  Updated."}
		}

	case "/threads":
		threads, err := m.client.threads()
		if err != nil {
			m.openModal("THREADS", []string{"", fmt.Sprintf("  ERROR: %v", err)})
			return *m, nil
		}
		// Build display lines
		var lines []string
		lines = append(lines, fmt.Sprintf("  %d active", len(threads)))
		lines = append(lines, "")
		for _, t := range threads {
			id, _ := t["id"].(string)
			rate, _ := t["rate"].(string)
			model, _ := t["model"].(string)
			age, _ := t["age"].(string)
			iter, _ := t["iteration"].(float64)
			lines = append(lines, fmt.Sprintf("  %-12s  iter=%.0f  rate=%s  model=%s  age=%s", id, iter, rate, model, age))
		}
		// Build killable list (exclude main)
		var killable []string
		for _, t := range threads {
			id, _ := t["id"].(string)
			if id != "main" {
				killable = append(killable, id)
			}
		}
		if len(killable) == 0 {
			m.openModal("THREADS", lines)
		} else {
			lines = append(lines, "")
			lines = append(lines, "  Select a thread to kill:")
			cli := m.client
			m.openSelectModal("THREADS", lines, killable, "", func(id string) tea.Cmd {
				return func() tea.Msg {
					if err := cli.killThread(id); err != nil {
						return modalMsg{title: "THREADS", text: fmt.Sprintf("  ERROR: %v", err)}
					}
					return modalMsg{title: "THREADS", text: fmt.Sprintf("  Thread %s killed.", id)}
				}
			})
		}

	case "/pause":
		return *m, func() tea.Msg {
			paused, err := m.client.pause()
			if err != nil {
				return modalMsg{title: "PAUSE", text: fmt.Sprintf("ERROR: %v", err)}
			}
			if paused {
				return modalMsg{title: "PAUSE", text: "  Core paused."}
			}
			return modalMsg{title: "PAUSE", text: "  Core resumed."}
		}

	case "/connect":
		rest := strings.TrimSpace(strings.TrimPrefix(text, "/connect"))
		if rest == "" {
			m.addLine("Usage: /connect <gateway>", "warn")
			m.addLine("Available: telegram", "dim")
			return *m, nil
		}
		switch rest {
		case "telegram":
			if m.telegramGW != nil {
				m.openModal("CONNECT", []string{"", "  Telegram already connected.", "", "  Press Esc to close."})
				return *m, nil
			}
			reg := m.registry
			cli := m.client
			m.openInputModal(
				"CONNECT TELEGRAM",
				[]string{
					"",
					"  Get a bot token from @BotFather on Telegram.",
					"  Paste it below and press Enter.",
					"",
				},
				"Bot token",
				func(token string) tea.Cmd {
					return func() tea.Msg {
						gw := NewTelegramGateway(token, reg, cli)
						botName, err := gw.Start()
						if err != nil {
							return connectResultMsg{gateway: "telegram", err: err}
						}
						return connectResultMsg{gateway: "telegram", botName: botName, gw: gw}
					}
				},
			)
		default:
			m.openModal("CONNECT", []string{"", fmt.Sprintf("  Unknown gateway: %s", rest), "", "  Available: telegram", "", "  Press Esc to close."})
		}

	case "/disconnect":
		rest := strings.TrimSpace(strings.TrimPrefix(text, "/disconnect"))
		if rest == "" {
			m.addLine("Usage: /disconnect <gateway>", "warn")
			return *m, nil
		}
		switch rest {
		case "telegram":
			if m.telegramGW == nil {
				m.addLine("Telegram not connected.", "warn")
			} else {
				m.telegramGW.Stop()
				m.telegramGW = nil
				m.addLine("Telegram disconnected.", "output")
				m.client.sendEvent("[telegram] gateway disconnected", "main")
			}
		default:
			m.addLine(fmt.Sprintf("Unknown gateway: %s", rest), "warn")
		}

	case "/channels":
		channels := m.registry.List()
		m.modal = true
		m.modalTitle = fmt.Sprintf("CHANNELS (%d)", len(channels))
		m.modalLines = []string{""}
		for _, ch := range channels {
			m.modalLines = append(m.modalLines, fmt.Sprintf("  %-20s  connected", ch.ID()))
		}
		m.modalLines = append(m.modalLines, "", "  Press Esc to close.")
		m.modalScroll = 0

	case "/mode":
		rest := strings.TrimSpace(strings.TrimPrefix(text, "/mode"))
		if rest != "" {
			// Direct set
			switch rest {
			case "autonomous", "cautious", "learn":
				return *m, func() tea.Msg {
					if err := m.client.setMode(rest); err != nil {
						return modalMsg{title: "MODE", text: fmt.Sprintf("ERROR: %v", err)}
					}
					return modalMsg{title: "MODE", text: fmt.Sprintf("  Mode set to: %s", rest)}
				}
			default:
				m.openModal("MODE", []string{"", fmt.Sprintf("  Unknown mode: %s", rest), "", "  Available: autonomous, cautious, learn"})
			}
			return *m, nil
		}
		// Interactive select
		cfg, err := m.client.getConfig()
		current := "autonomous"
		if err == nil {
			if mode, ok := cfg["mode"].(string); ok {
				current = mode
			}
		}
		cli := m.client
		m.openSelectModal(
			"MODE",
			[]string{
				"",
				"  autonomous — acts freely, learns from feedback",
				"  cautious   — asks before risky actions",
				"  learn      — asks about every new tool type",
				"",
			},
			[]string{"autonomous", "cautious", "learn"},
			current,
			func(value string) tea.Cmd {
				return func() tea.Msg {
					if err := cli.setMode(value); err != nil {
						return modalMsg{title: "MODE", text: fmt.Sprintf("ERROR: %v", err)}
					}
					return modalMsg{title: "MODE", text: fmt.Sprintf("  Mode set to: %s", value)}
				}
			},
		)

	case "/computer":
		rest := strings.TrimSpace(strings.TrimPrefix(text, "/computer"))
		cli := m.client
		switch rest {
		case "local":
			return *m, func() tea.Msg {
				err := cli.setComputer(map[string]any{"type": "local", "width": 1280, "height": 800})
				if err != nil {
					return modalMsg{title: "COMPUTER", text: fmt.Sprintf("  ERROR: %v", err)}
				}
				return modalMsg{title: "COMPUTER", text: "  Local Chrome launched (1280x800)."}
			}
		case "off":
			return *m, func() tea.Msg {
				err := cli.setComputer(map[string]any{"type": ""})
				if err != nil {
					return modalMsg{title: "COMPUTER", text: fmt.Sprintf("  ERROR: %v", err)}
				}
				return modalMsg{title: "COMPUTER", text: "  Computer disconnected."}
			}
		case "browserbase":
			m.openInputModal(
				"BROWSERBASE",
				[]string{
					"",
					"  Enter your Browserbase API key.",
					"",
				},
				"API key",
				func(apiKey string) tea.Cmd {
					return func() tea.Msg {
						// Return a special msg to chain to project ID input
						return browserbaseKeyMsg(apiKey)
					}
				},
			)
		case "":
			// Interactive select
			cfg, err := m.client.getConfig()
			current := "off"
			if err == nil {
				if comp, ok := cfg["computer"].(map[string]any); ok && comp != nil {
					if t, ok := comp["type"].(string); ok && t != "" {
						current = t
					}
				}
			}
			m.openSelectModal(
				"COMPUTER",
				[]string{
					"",
					"  local        — launch local Chrome via CDP",
					"  browserbase  — cloud browser (needs API key)",
					"  off          — disconnect",
					"",
				},
				[]string{"local", "browserbase", "off"},
				current,
				func(value string) tea.Cmd {
					return func() tea.Msg {
						// Re-trigger the command with the selected value
						return computerSelectMsg(value)
					}
				},
			)
		default:
			m.openModal("COMPUTER", []string{"", fmt.Sprintf("  Unknown type: %s", rest), "", "  Available: local, browserbase, off"})
		}

	case "/mcp":
		rest := strings.TrimSpace(strings.TrimPrefix(text, "/mcp"))
		cli := m.client
		if rest == "" {
			// Show connected MCP servers
			cfg, err := m.client.getConfig()
			if err != nil {
				m.openModal("MCP SERVERS", []string{"", fmt.Sprintf("  ERROR: %v", err)})
				return *m, nil
			}
			var lines []string
			var removable []string
			if mcps, ok := cfg["mcp_servers"].([]any); ok && len(mcps) > 0 {
				lines = append(lines, fmt.Sprintf("  %d connected", len(mcps)))
				lines = append(lines, "")
				for _, raw := range mcps {
					if entry, ok := raw.(map[string]any); ok {
						name, _ := entry["name"].(string)
						connected, _ := entry["connected"].(bool)
						status := "connected"
						if !connected {
							status = "disconnected"
						}
						lines = append(lines, fmt.Sprintf("  %-16s %s", name, status))
						// Don't allow removing the channels MCP (that's us)
						if name != "channels" {
							removable = append(removable, name)
						}
					}
				}
			} else {
				lines = append(lines, "  No MCP servers connected.")
			}
			if len(removable) > 0 {
				lines = append(lines, "")
				lines = append(lines, "  Select to disconnect:")
				m.openSelectModal("MCP SERVERS", lines, removable, "", func(name string) tea.Cmd {
					return func() tea.Msg {
						if err := cli.disconnectMCP(name); err != nil {
							return modalMsg{title: "MCP", text: fmt.Sprintf("  ERROR: %v", err)}
						}
						return modalMsg{title: "MCP", text: fmt.Sprintf("  Disconnected: %s", name)}
					}
				})
			} else {
				m.openModal("MCP SERVERS", lines)
			}
			return *m, nil
		}
		// /mcp connect <name> <url>
		if strings.HasPrefix(rest, "connect ") {
			parts := strings.Fields(rest)
			if len(parts) < 3 {
				m.openModal("MCP", []string{"", "  Usage: /mcp connect <name> <url>"})
				return *m, nil
			}
			name := parts[1]
			url := parts[2]
			return *m, func() tea.Msg {
				if err := cli.connectMCP(name, url); err != nil {
					return modalMsg{title: "MCP", text: fmt.Sprintf("  ERROR: %v", err)}
				}
				return modalMsg{title: "MCP", text: fmt.Sprintf("  Connected: %s at %s", name, url)}
			}
		}
		// /mcp disconnect <name>
		if strings.HasPrefix(rest, "disconnect ") {
			parts := strings.Fields(rest)
			if len(parts) < 2 {
				m.openModal("MCP", []string{"", "  Usage: /mcp disconnect <name>"})
				return *m, nil
			}
			name := parts[1]
			return *m, func() tea.Msg {
				if err := cli.disconnectMCP(name); err != nil {
					return modalMsg{title: "MCP", text: fmt.Sprintf("  ERROR: %v", err)}
				}
				return modalMsg{title: "MCP", text: fmt.Sprintf("  Disconnected: %s", name)}
			}
		}
		m.openModal("MCP", []string{
			"",
			"  Usage:",
			"  /mcp                          list servers",
			"  /mcp connect <name> <url>     add HTTP MCP server",
			"  /mcp disconnect <name>        remove server",
		})

	case "/integrate":
		if !m.aptevaCfg.Capabilities.Integrations || m.serverURL == "" {
			m.openModal("INTEGRATIONS", []string{
				"",
				"  Integrations not enabled.",
				"  Run ./apteva --setup to enable.",
				"",
			})
			return *m, nil
		}
		rest := strings.TrimSpace(strings.TrimPrefix(text, "/integrate"))
		cli := m.client
		if rest == "" {
			// List connected + available via server API
			return *m, func() tea.Msg {
				var lines []string
				// Fetch connected
				if data, err := cli.serverGet("/connections"); err == nil {
					var connected []struct {
						AppSlug string `json:"app_slug"`
						AppName string `json:"app_name"`
					}
					json.Unmarshal(data, &connected)
					if len(connected) > 0 {
						lines = append(lines, fmt.Sprintf("  Connected: %d", len(connected)))
						for _, c := range connected {
							lines = append(lines, fmt.Sprintf("    ✓ %s (%s)", c.AppSlug, c.AppName))
						}
						lines = append(lines, "")
					}
				}
				// Fetch available count
				if data, err := cli.serverGet("/integrations/catalog"); err == nil {
					var apps []any
					json.Unmarshal(data, &apps)
					lines = append(lines, fmt.Sprintf("  Available: %d apps", len(apps)))
				}
				lines = append(lines, "")
				lines = append(lines, "  Usage:")
				lines = append(lines, "  /integrate <app>          connect an app")
				lines = append(lines, "  /integrate search <query> search apps")
				lines = append(lines, "  /integrate disconnect <id>")
				return modalMsg{title: "INTEGRATIONS", text: strings.Join(lines, "\n")}
			}
		}
		// /integrate disconnect <id>
		if strings.HasPrefix(rest, "disconnect ") {
			connID := strings.TrimPrefix(rest, "disconnect ")
			return *m, func() tea.Msg {
				if err := cli.serverDelete("/connections/" + connID); err != nil {
					return modalMsg{title: "INTEGRATE", text: fmt.Sprintf("  ERROR: %v", err)}
				}
				return modalMsg{title: "INTEGRATE", text: fmt.Sprintf("  Disconnected: %s", connID)}
			}
		}
		// /integrate search <query>
		if strings.HasPrefix(rest, "search ") {
			query := strings.TrimPrefix(rest, "search ")
			return *m, func() tea.Msg {
				data, err := cli.serverGet("/integrations/catalog?search=" + query)
				if err != nil {
					return modalMsg{title: "SEARCH", text: fmt.Sprintf("  ERROR: %v", err)}
				}
				var results []struct {
					Slug        string `json:"slug"`
					Name        string `json:"name"`
					Description string `json:"description"`
					ToolCount   int    `json:"tool_count"`
				}
				json.Unmarshal(data, &results)
				var lines []string
				lines = append(lines, fmt.Sprintf("  Results for \"%s\": %d", query, len(results)))
				lines = append(lines, "")
				for _, app := range results {
					lines = append(lines, fmt.Sprintf("  %-20s %s (%d tools)", app.Slug, app.Name, app.ToolCount))
					if len(lines) > 22 {
						lines = append(lines, "  ...")
						break
					}
				}
				return modalMsg{title: "SEARCH", text: strings.Join(lines, "\n")}
			}
		}
		// /integrate <slug> — get app info then prompt for credentials
		slug := rest
		return *m, func() tea.Msg {
			data, err := cli.serverGet("/integrations/catalog/" + slug)
			if err != nil {
				return modalMsg{title: "INTEGRATE", text: fmt.Sprintf("  App not found: %s", slug)}
			}
			var info integrateAppInfoMsg
			json.Unmarshal(data, &info)
			if info.Name == "" {
				return modalMsg{title: "INTEGRATE", text: fmt.Sprintf("  App not found: %s", slug)}
			}
			if len(info.Fields()) == 0 {
				return modalMsg{title: "INTEGRATE", text: fmt.Sprintf("  %s has no credential fields.", info.Name)}
			}
			info.Slug = slug
			return info
		}

	case "/setup":
		m.addLine("Re-run setup: ./apteva --setup", "dim")

	case "/help":
		m.modal = true
		m.modalTitle = "HELP"
		m.modalLines = []string{
			"  /status              show core status",
			"  /config              show full config",
			"  /directive [text]    show or set directive",
			"  /mode [name]         show or set mode",
			"  /computer [type]     connect browser (local/browserbase/off)",
			"  /threads             list/kill threads",
			"  /mcp                 manage MCP servers",
		}
		if m.aptevaCfg.Capabilities.Integrations {
			m.modalLines = append(m.modalLines, "  /integrate [app]     manage integrations (263+ apps)")
		}
		m.modalLines = append(m.modalLines,
			"  /pause               toggle pause/resume",
			"  /connect <gateway>   connect a gateway (telegram)",
			"  /disconnect <gw>    disconnect a gateway",
			"  /channels            list connected channels",
			"  /setup               re-run setup wizard",
			"  /clear               clear screen",
			"  /help                show this help",
			"  /quit                disconnect and exit",
			"",
			"  Everything else is sent to the agent.",
			"",
			"  Press Esc to close.",
		)
		m.modalScroll = 0

	default:
		m.addLine(fmt.Sprintf("UNKNOWN COMMAND: %s", cmd), "warn")
		m.addLine("Type /help for available commands.", "dim")
	}

	return *m, nil
}

func (m *tuiModel) closeModal() {
	m.modal = false
	m.modalLines = nil
	m.modalScroll = 0
	m.modalInput = false
	m.modalPrompt = ""
	m.modalOnSubmit = nil
	m.modalSelect = false
	m.modalItems = nil
	m.modalCursor = 0
	m.modalOnSelect = nil
	m.input.SetValue("")
	m.input.Placeholder = ""
}

func (m *tuiModel) openModal(title string, lines []string) {
	m.modal = true
	m.modalTitle = title
	m.modalLines = lines
	m.modalScroll = 0
	m.modalInput = false
}

func (m *tuiModel) openSelectModal(title string, lines []string, items []string, current string, onSelect func(string) tea.Cmd) {
	m.modal = true
	m.modalTitle = title
	m.modalLines = lines
	m.modalScroll = 0
	m.modalSelect = true
	m.modalItems = items
	m.modalCursor = 0
	m.modalOnSelect = onSelect
	// Pre-select current value
	for i, item := range items {
		if item == current {
			m.modalCursor = i
			break
		}
	}
}

func (m *tuiModel) openInputModal(title string, lines []string, prompt string, onSubmit func(string) tea.Cmd) {
	m.modal = true
	m.modalTitle = title
	m.modalLines = lines
	m.modalScroll = 0
	m.modalInput = true
	m.modalPrompt = prompt
	m.modalOnSubmit = onSubmit
	m.input.SetValue("")
	m.input.Placeholder = ""
}

func (m *tuiModel) connectGateway(target, token string) (tuiModel, tea.Cmd) {
	switch target {
	case "telegram":
		if m.telegramGW != nil {
			m.addLine("Telegram already connected.", "warn")
			return *m, nil
		}
		gw := NewTelegramGateway(token, m.registry, m.client)
		m.telegramGW = gw
		m.addLine("Connecting to Telegram...", "dim")
		return *m, func() tea.Msg {
			botName, err := gw.Start()
			if err != nil {
				m.telegramGW = nil
				return connectResultMsg{gateway: "telegram", err: err}
			}
			return connectResultMsg{gateway: "telegram", botName: botName}
		}
	default:
		m.addLine(fmt.Sprintf("Unknown gateway: %s", target), "warn")
		return *m, nil
	}
}

func (m *tuiModel) addLine(text string, style string) {
	lines := strings.Split(text, "\n")
	prevEmpty := false
	for i, line := range lines {
		// Collapse consecutive empty lines into one
		isEmpty := strings.TrimSpace(line) == ""
		if isEmpty && prevEmpty {
			continue
		}
		prevEmpty = isEmpty

		sl := styledLine{text: line, style: style}
		if i == 0 && style != "dim" && line != "" {
			sl.ts = time.Now()
		}
		m.lines = append(m.lines, sl)
	}
}

// truncateToWidth truncates a string to fit within maxWidth display cells.
func truncateToWidth(s string, maxWidth int) string {
	if lipgloss.Width(s) <= maxWidth {
		return s
	}
	// Truncate rune by rune
	var result []rune
	for _, r := range s {
		next := append(result, r)
		if lipgloss.Width(string(next)) > maxWidth {
			break
		}
		result = next
	}
	return string(result)
}

// wrapText wraps a string to fit within maxWidth display cells, breaking on spaces.
func wrapText(s string, maxWidth int) []string {
	if maxWidth <= 0 {
		return []string{s}
	}
	var result []string
	for _, line := range strings.Split(s, "\n") {
		if lipgloss.Width(line) <= maxWidth {
			result = append(result, line)
			continue
		}
		words := strings.Fields(line)
		if len(words) == 0 {
			result = append(result, "")
			continue
		}
		cur := words[0]
		// Truncate single words that are wider than maxWidth
		if lipgloss.Width(cur) > maxWidth {
			cur = truncateToWidth(cur, maxWidth)
		}
		for _, w := range words[1:] {
			test := cur + " " + w
			if lipgloss.Width(test) > maxWidth {
				result = append(result, cur)
				cur = w
				if lipgloss.Width(cur) > maxWidth {
					cur = truncateToWidth(cur, maxWidth)
				}
			} else {
				cur = test
			}
		}
		result = append(result, cur)
	}
	return result
}

func (m tuiModel) View() string {
	if m.width == 0 || m.height == 0 {
		return ""
	}

	if m.modal {
		return m.renderModal()
	}

	primary := lipgloss.NewStyle().Foreground(m.th.Primary)
	dim := lipgloss.NewStyle().Foreground(m.th.Dim)
	accent := lipgloss.NewStyle().Foreground(m.th.Accent)
	faded := lipgloss.NewStyle().Foreground(m.th.Faded)
	warn := lipgloss.NewStyle().Foreground(m.th.Warn)
	alert := lipgloss.NewStyle().Foreground(m.th.Alert)

	chatW := m.chatWidth()
	sideW := m.sideWidth()
	innerChat := chatW - 4 // 2 padding each side

	// Layout: header(1) + separator(1) + content + separator(1) + input(1) = 4 chrome lines
	contentHeight := m.height - 4
	if contentHeight < 1 {
		contentHeight = 1
	}

	// ── Header ──
	connStatus := dim.Render("◉ DISCONNECTED")
	if m.connected {
		connStatus = accent.Render("◉ CORE LIVE")
	}
	title := primary.Bold(true).Render("APTEVA")
	headerPad := m.width - lipgloss.Width(title) - lipgloss.Width(connStatus)
	if headerPad < 1 {
		headerPad = 1
	}
	header := title + strings.Repeat(" ", headerPad) + connStatus
	sep := dim.Render(strings.Repeat("─", m.width))

	// ── Chat panel (left) ──
	// Wrap and collect visible lines
	var wrappedLines []styledLine
	for _, sl := range m.lines {
		wrapped := wrapText(sl.text, innerChat)
		for i, w := range wrapped {
			wl := styledLine{text: w, style: sl.style}
			if i == len(wrapped)-1 {
				wl.ts = sl.ts // timestamp on last wrapped line (most likely to have room)
			}
			wrappedLines = append(wrappedLines, wl)
		}
	}

	// Visible region
	chatContentH := contentHeight - 2 // -2 for status line + input separator inside chat
	if chatContentH < 1 {
		chatContentH = 1
	}

	start := len(wrappedLines) - chatContentH - m.scrollOff
	if start < 0 {
		start = 0
	}
	end := start + chatContentH
	if end > len(wrappedLines) {
		end = len(wrappedLines)
	}

	var chatLines []string
	for i := start; i < end; i++ {
		line := wrappedLines[i]
		var styled string
		switch line.style {
		case "input":
			styled = faded.Render(line.text)
		case "output":
			styled = renderMarkdown(line.text, primary, accent)
		case "dim", "system":
			styled = dim.Render(line.text)
		case "warn":
			styled = warn.Render(line.text)
		case "alert":
			styled = alert.Render(line.text)
		default:
			styled = line.text
		}
		// Right-aligned timestamp based on plain text width
		if !line.ts.IsZero() {
			tsStr := line.ts.Format("3:04")
			plainW := lipgloss.Width(line.text)
			pad := innerChat - plainW - len(tsStr)
			if pad >= 2 {
				styled = styled + strings.Repeat(" ", pad) + dim.Render(tsStr)
			}
		}
		chatLines = append(chatLines, styled)
	}

	// Press Enter to connect
	if m.waitingConnect && len(chatLines) < chatContentH {
		chatLines = append(chatLines, "")
		chatLines = append(chatLines, dim.Render("  Press Enter to connect."))
	}

	// Spinner while waiting
	if m.waiting && !m.waitingConnect && len(chatLines) < chatContentH {
		frame := spinnerFrames[m.spinnerTick%len(spinnerFrames)]
		chatLines = append(chatLines, dim.Render(frame))
	}

	// Pad to fill
	for len(chatLines) < chatContentH {
		chatLines = append(chatLines, "")
	}

	// Status line inside chat
	statusText := m.statusLine
	if statusText == "" {
		statusText = "READY"
	}
	var statusStyled string
	switch m.statusLevel {
	case "warn":
		statusStyled = warn.Render(statusText)
	case "alert":
		statusStyled = alert.Render(statusText)
	default:
		statusStyled = dim.Render(statusText)
	}

	// Input line
	prompt := primary.Bold(true).Render("> ")
	inputLine := prompt + m.input.View()

	// Build chat column
	chatLines = append(chatLines, dim.Render(strings.Repeat("─", innerChat)))
	chatLines = append(chatLines, inputLine)

	chatPanel := lipgloss.NewStyle().
		Width(chatW).
		Padding(0, 2).
		Render(strings.Join(chatLines, "\n"))

	// ── Side panel (right) ──
	sideLines := m.renderSidePanel(sideW-2, contentHeight, dim, primary, accent, warn)
	sidePanel := lipgloss.NewStyle().
		Width(sideW).
		Padding(0, 1).
		Render(strings.Join(sideLines, "\n"))

	// ── Vertical border ──
	var borderLines []string
	for i := 0; i < contentHeight; i++ {
		borderLines = append(borderLines, dim.Render("│"))
	}
	border := strings.Join(borderLines, "\n")

	// ── Compose ──
	body := lipgloss.JoinHorizontal(lipgloss.Top, chatPanel, border, sidePanel)

	// Bottom status bar across full width
	bottomBar := dim.Render(strings.Repeat("─", chatW)) +
		dim.Render("┴") +
		dim.Render(strings.Repeat("─", sideW))
	_ = statusStyled

	return header + "\n" + sep + "\n" + body + "\n" + bottomBar + " " + statusStyled
}

func (m tuiModel) renderModal() string {
	primary := lipgloss.NewStyle().Foreground(m.th.Primary)
	dim := lipgloss.NewStyle().Foreground(m.th.Dim)
	accent := lipgloss.NewStyle().Foreground(m.th.Accent)

	// Modal box: centered, 60% width, up to 80% height
	boxW := m.width * 60 / 100
	if boxW < 40 {
		boxW = m.width - 4
	}
	innerW := boxW - 4 // 2 border + 2 padding
	boxH := m.height * 80 / 100
	if boxH < 5 {
		boxH = m.height - 2
	}
	// Reserve space for input/select rows if needed
	extraRows := 0
	if m.modalInput {
		extraRows = 2 // separator + input line
	}
	if m.modalSelect {
		extraRows = 1 + len(m.modalItems) // separator + items
	}
	innerH := boxH - 4 - extraRows // top border + title + bottom border + footer

	// Title bar
	titleText := " " + m.modalTitle + " "
	titleLen := lipgloss.Width(titleText)
	topBorder := "┌" + accent.Render(titleText) + dim.Render(strings.Repeat("─", max(0, innerW+2-titleLen))) + "┐"

	// Scrollable content
	totalLines := len(m.modalLines)
	scroll := m.modalScroll
	if scroll > totalLines-innerH {
		scroll = totalLines - innerH
	}
	if scroll < 0 {
		scroll = 0
	}
	endLine := scroll + innerH
	if endLine > totalLines {
		endLine = totalLines
	}

	var contentLines []string
	for i := scroll; i < endLine; i++ {
		line := m.modalLines[i]
		// Truncate if too wide (emoji-safe)
		if lipgloss.Width(line) > innerW {
			line = truncateToWidth(line, innerW-1) + "…"
		}
		pad := innerW - lipgloss.Width(line)
		if pad < 0 {
			pad = 0
		}
		contentLines = append(contentLines, dim.Render("│ ")+primary.Render(line)+strings.Repeat(" ", pad)+dim.Render(" │"))
	}
	// Pad remaining height
	for len(contentLines) < innerH {
		contentLines = append(contentLines, dim.Render("│ ")+strings.Repeat(" ", innerW)+dim.Render(" │"))
	}

	// Input row inside modal
	if m.modalInput {
		contentLines = append(contentLines, dim.Render("│ ")+dim.Render(strings.Repeat("─", innerW))+dim.Render(" │"))
		label := accent.Render("  " + m.modalPrompt + ": ")
		inputView := m.input.View()
		inputLine := label + inputView
		inputW := lipgloss.Width(m.modalPrompt+": ") + 2 + lipgloss.Width(m.input.Value()) + 1
		inputPad := innerW - inputW
		if inputPad < 0 {
			inputPad = 0
		}
		_ = inputPad
		contentLines = append(contentLines, dim.Render("│ ")+inputLine+dim.Render(" │"))
	}

	// Select items inside modal
	if m.modalSelect {
		contentLines = append(contentLines, dim.Render("│ ")+dim.Render(strings.Repeat("─", innerW))+dim.Render(" │"))
		for i, item := range m.modalItems {
			var label string
			if i == m.modalCursor {
				label = accent.Bold(true).Render("  > " + item)
			} else {
				label = primary.Render("    " + item)
			}
			itemPad := innerW - lipgloss.Width(label)
			if itemPad < 0 {
				itemPad = 0
			}
			contentLines = append(contentLines, dim.Render("│ ")+label+strings.Repeat(" ", itemPad)+dim.Render(" │"))
		}
	}

	// Footer
	footer := dim.Render("  esc to close")
	if m.modalInput {
		footer = dim.Render("  enter to submit · esc to cancel")
	} else if m.modalSelect {
		footer = dim.Render("  ↑↓ to select · enter to confirm · esc to cancel")
	} else if totalLines > innerH {
		footer += dim.Render(fmt.Sprintf("  ↑↓ to scroll (%d/%d)", scroll+1, totalLines))
	}
	bottomBorder := dim.Render("└"+strings.Repeat("─", innerW+2)+"┘")

	// Compose
	var lines []string
	// Vertical centering
	topPad := (m.height - boxH) / 2
	leftPad := (m.width - boxW - 2) / 2
	if leftPad < 0 {
		leftPad = 0
	}
	indent := strings.Repeat(" ", leftPad)

	for i := 0; i < topPad; i++ {
		lines = append(lines, "")
	}
	lines = append(lines, indent+topBorder)
	for _, cl := range contentLines {
		lines = append(lines, indent+cl)
	}
	lines = append(lines, indent+bottomBorder)
	lines = append(lines, indent+footer)
	// Fill rest
	for len(lines) < m.height {
		lines = append(lines, "")
	}

	return strings.Join(lines[:m.height], "\n")
}

func (m tuiModel) renderSidePanel(w, h int, dim, primary, accent, warn lipgloss.Style) []string {
	var lines []string
	sd := m.sideStatus

	// Title
	lines = append(lines, accent.Bold(true).Render("SYSTEM"))
	lines = append(lines, dim.Render(strings.Repeat("─", w)))
	lines = append(lines, "")

	if sd != nil {
		// Status + Mode
		if sd.Status == "PAUSED" {
			lines = append(lines, dim.Render("STATUS  ")+warn.Render(sd.Status))
		} else {
			lines = append(lines, dim.Render("STATUS  ")+accent.Render(sd.Status))
		}
		lines = append(lines, dim.Render("MODE    ")+primary.Render(sd.Mode))
		lines = append(lines, dim.Render("UPTIME  ")+primary.Render(sd.Uptime))
		lines = append(lines, dim.Render("ITER    ")+primary.Render(fmt.Sprintf("%d", sd.Iteration)))
		lines = append(lines, dim.Render("RATE    ")+primary.Render(sd.Rate))
		lines = append(lines, dim.Render("MODEL   ")+primary.Render(sd.Model))
		lines = append(lines, dim.Render("MEMORY  ")+primary.Render(fmt.Sprintf("%d", sd.Memories)))
		if sd.Computer != "" {
			lines = append(lines, dim.Render("BROWSER ")+accent.Render(sd.Computer))
		} else {
			lines = append(lines, dim.Render("BROWSER ")+dim.Render("off"))
		}
		lines = append(lines, "")

		// Directive (truncated)
		lines = append(lines, dim.Render(strings.Repeat("─", w)))
		lines = append(lines, accent.Bold(true).Render("DIRECTIVE"))
		lines = append(lines, "")
		directive := sd.Directive
		// Wrap directive to panel width
		for _, dl := range wrapText(directive, w) {
			lines = append(lines, dim.Render(dl))
		}
		lines = append(lines, "")

		// Threads + latest thoughts
		lines = append(lines, dim.Render(strings.Repeat("─", w)))
		lines = append(lines, accent.Bold(true).Render(fmt.Sprintf("THREADS (%d)", len(sd.Threads))))
		lines = append(lines, "")
		for _, t := range sd.Threads {
			label := primary.Render(fmt.Sprintf("%-10s", t.ID))
			info := dim.Render(fmt.Sprintf("#%d %s", t.Iter, t.Rate))
			lines = append(lines, label+info)

			// Show latest thought with decay
			if thought, ok := m.thoughts[t.ID]; ok {
				age := time.Since(thought.Time)
				if age < 2*time.Minute {
					text := thought.Text
					// Clean up: single line, truncate
					text = strings.ReplaceAll(text, "\n", " ")
					text = strings.Join(strings.Fields(text), " ")
					maxLen := w - 2
					if maxLen > 80 {
						maxLen = 80
					}
					if len(text) > maxLen {
						text = text[:maxLen-1] + "…"
					}
					// Decay: bright → dim based on age
					var thoughtStyle lipgloss.Style
					if age < 10*time.Second {
						thoughtStyle = lipgloss.NewStyle().Foreground(m.th.Dim).Italic(true)
					} else if age < 30*time.Second {
						thoughtStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Italic(true)
					} else {
						thoughtStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("237")).Italic(true)
					}
					lines = append(lines, thoughtStyle.Render("  "+text))
				}
			}

			// Show latest event with decay
			if ev, ok := m.events[t.ID]; ok {
				age := time.Since(ev.Time)
				if age < 30*time.Second {
					text := ev.Message
					text = strings.ReplaceAll(text, "\n", " ")
					text = strings.Join(strings.Fields(text), " ")
					maxLen := w - 4
					if len(text) > maxLen {
						text = text[:maxLen-1] + "…"
					}
					icon := "▶"
					if ev.Source == "thread" {
						icon = "⇄"
					} else if ev.Source == "console" {
						icon = "▷"
					}
					var evStyle lipgloss.Style
					if age < 5*time.Second {
						evStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("240"))
					} else {
						evStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("237"))
					}
					lines = append(lines, evStyle.Render("  "+icon+" "+text))
				}
			}
		}
	} else {
		lines = append(lines, dim.Render("loading..."))
	}

	// Pad to fill height
	for len(lines) < h {
		lines = append(lines, "")
	}

	return lines[:h]
}

// renderMarkdown applies basic markdown styling to a line of text.
// Handles **bold**, `code`, and # headers.
func renderMarkdown(text string, base, accent lipgloss.Style) string {
	trimmed := strings.TrimSpace(text)

	// Headers: # ## ###
	if strings.HasPrefix(trimmed, "# ") || strings.HasPrefix(trimmed, "## ") || strings.HasPrefix(trimmed, "### ") {
		// Strip # prefix
		header := strings.TrimLeft(trimmed, "# ")
		return accent.Bold(true).Render(strings.ToUpper(header))
	}

	// Inline: process **bold** and `code`
	var result strings.Builder
	bold := base.Bold(true)
	code := lipgloss.NewStyle().Foreground(accent.GetForeground())
	i := 0
	for i < len(text) {
		// **bold**
		if i+1 < len(text) && text[i] == '*' && text[i+1] == '*' {
			end := strings.Index(text[i+2:], "**")
			if end >= 0 {
				result.WriteString(bold.Render(text[i+2 : i+2+end]))
				i = i + 2 + end + 2
				continue
			}
		}
		// `code`
		if text[i] == '`' {
			end := strings.IndexByte(text[i+1:], '`')
			if end >= 0 {
				result.WriteString(code.Render(text[i+1 : i+1+end]))
				i = i + 1 + end + 1
				continue
			}
		}
		result.WriteByte(text[i])
		i++
	}

	return base.Render(result.String())
}

func formatDuration(d time.Duration) string {
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	s := int(d.Seconds()) % 60
	if h > 0 {
		return fmt.Sprintf("%dh%02dm", h, m)
	}
	if m > 0 {
		return fmt.Sprintf("%dm%02ds", m, s)
	}
	return fmt.Sprintf("%ds", s)
}
