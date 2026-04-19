package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Messages
type respondMsg string
type askMsg string

// chatRowMsg carries one row delivered by the channel-chat app's SSE
// stream. The TUI appends it to scrollback, keyed by monotonic DB id
// so dedup is trivial (reject any row whose id we've already rendered).
type chatRowMsg struct {
	ID       int64
	Role     string // user | agent | system
	Content  string
	ThreadID string
	Status   string // streaming | final
}

// chatStreamFailedMsg signals the SSE connection ended. The TUI logs
// it and the background reconnect loop will restart the stream.
type chatStreamFailedMsg struct{ Err string }

type statusUpdate struct {
	Line  string
	Level string
}
type statusMsg statusUpdate
type connectedMsg struct{}
type tickMsg time.Time
type streamChunkMsg string    // incremental text from tool arg streaming
type toolStartMsg struct {    // tool call started
	ThreadID string
	Name     string
	Reason   string
	CallID   string
}
type toolDoneMsg struct {     // tool call completed
	ThreadID   string
	Name       string
	CallID     string
	DurationMs int64
	Success    bool
}
type eventReceivedMsg struct {    // event received by a thread
	ThreadID string
	Source   string
	Message  string
}
type settingsUpdatedMsg AptevaConfig    // settings toggled
type providerPoolMsg struct {           // all providers fetched
	providers []providerDetail
}
type providerDetail struct {
	id                int64
	ptype             string
	name              string
	isDefault         bool
	currentLarge      string
	currentMedium     string
	currentSmall      string
	builtinTools      []string
	availableBuiltins []string
	models            []struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		ContextSize int    `json:"context_size"`
	}
}
type providerInfoMsg struct {           // single provider selected for editing
	detail providerDetail
}
type providerModelSetMsg struct {       // model changed
	tier  string // "large" or "small"
	model string
	err   error
}
type providerModelListMsg struct {      // model list ready for search modal
	tier       string
	providerID int64
	items      []modalSearchItem
	client     *coreClient
}
type credentialUpdateMsg struct {       // chain through credential fields
	providerID int64
	ptype      string
	fields     []string
	values     map[string]string
	fieldIdx   int
	client     *coreClient
}
type providerAddMsg struct {            // add a new provider
	client *coreClient
}
type providerAddedMsg struct {          // provider was added
	ptype string
	err   error
}
type providerNeedKeyMsg struct {        // need API key input for new provider
	client *coreClient
	ptype  string
	envVar string
	large  string
	medium string
	small  string
}
type builtinToolsToggleMsg struct {     // show toggle for built-in tools
	providerID int64
	available  []string
	enabled    []string
	items      []string
	lines      []string
	client     *coreClient
}
type projectsListMsg struct {           // projects fetched
	projects []projectInfo
}
type projectInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type projectSwitchedMsg struct {        // switched to a different project
	projectID  string
	projectName string
	instanceID int64
	err        error
}
type projectCreatedMsg struct {         // new project + instance created
	projectID   string
	projectName string
	instanceID  int64
	err         error
}
type integrateNextFieldMsg struct{}     // prompt next credential field
type integrateFieldValueMsg string     // value entered for a credential field
type directiveChangedMsg string        // directive evolved via SSE
type modeChangedMsg string             // mode changed via SSE
type threadDoneMsg string              // thread done via SSE
type threadSpawnMsg struct {           // thread spawned via SSE
	ID        string
	ParentID  string
	Directive string
}
type sideSSEUpdate struct {            // side panel update from llm.done
	ThreadID     string
	Iteration    int
	Rate         string
	Model        string
	MemoryCount  int
	ThreadCount  int
	TokensIn     int
	TokensCached int
	TokensOut    int
	CostUSD      float64
}
type integrateListMsg struct {       // catalog fetched for searchable list
	apps []struct {
		Slug        string `json:"slug"`
		Name        string `json:"name"`
		Description string `json:"description"`
		ToolCount   int    `json:"tool_count"`
	}
	connected []string
}
type computerSelectMsg string       // re-dispatch /computer with selected value
type computerMenuMsg struct {      // computer menu data loaded
	current      string
	bbLabel      string
	hasBBProvider bool
	bbProviderID int64
}
type browserbaseKeyMsg string     // trigger credential prompt (empty = no saved provider)
type browserbaseProjectMsg string // API key entered, chain to project ID input
type integrateConnectMsg struct { // integration connected result
	slug  string
	connID int64
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

type activeTool struct {
	name     string
	reason   string
	callID   string
	threadID string
	lineIdx  int       // index in m.lines for in-place update
	started  time.Time
}

type cmdDef struct {
	name string
	desc string
	cap  string // required capability ("" = always shown)
}

var allCommands = []cmdDef{
	{"/status", "core status", ""},
	{"/config", "show config", ""},
	{"/directive", "show/set directive", ""},
	{"/mode", "set safety mode", ""},
	{"/threads", "list/kill threads", ""},
	{"/computer", "browser control", ""},
	{"/provider", "switch provider/models", ""},
	{"/integrate", "connect integrations", "integrations"},
	{"/projects", "switch/create projects", "projects"},
	{"/connect", "add gateway (telegram)", ""},
	{"/disconnect", "remove gateway", ""},
	{"/channels", "list channels", ""},
	{"/mcp", "manage MCP servers", ""},
	{"/settings", "toggle features", ""},
	{"/pause", "toggle pause", ""},
	{"/clear", "clear screen", ""},
	{"/stats", "usage stats (cost, tokens, calls)", ""},
	{"/history", "browse past activity", ""},
	{"/dashboard", "open web dashboard", ""},
	{"/help", "all commands", ""},
	{"/quit", "exit", ""},
}

type tuiModel struct {
	th          theme
	client      *coreClient
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

	// Tool call visualization
	activeTools  map[string]*activeTool // callID → running tool
	threadTools  map[string]string      // threadID → current tool display ("⟳ name")
	statusLine   string
	statusLevel  string
	startTime    time.Time
	pollCounter  int // counts ticks for periodic polling

	// Live side panel data
	sideStatus    *sideData
	lastPollTick  int
	thoughts      map[string]*threadThought // latest thought per thread
	events        map[string]*threadEvent  // latest event per thread

	// CLI ask reply — set when agent asks a question via channels_ask
	askPending bool

	// Apteva config
	aptevaCfg AptevaConfig
	serverURL string // integration server URL (empty = no server)

	// SSE reconnect support
	sseDone    chan struct{}
	teaProgram *tea.Program

	// Integration credential collection (multi-field)
	integrateSlug     string
	integrateName     string
	integrateFields   []struct{ Name, Label, Description string }
	integrateCreds    map[string]string
	integrateFieldIdx int

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

	// Searchable list modal
	modalSearch       bool                        // modal has search + filterable list
	modalSearchAll    []modalSearchItem            // all items
	modalSearchFiltered []modalSearchItem          // filtered items
	modalSearchOnSelect     func(slug string) tea.Cmd  // callback
	modalSearchCreateOnEmpty func(name string) tea.Cmd // callback when Enter with no results (create new)

	// --- Channel-chat integration (replaces old telemetry-stitched chat) ---
	chatID       string      // default chat id for the current instance
	chatSince    int64       // highest message id we've rendered (used for SSE reconnect)
	chatSeen     map[int64]bool // dedup for chat SSE — id → seen
	chatDone     chan struct{} // closes the current chat stream goroutine
	chatTarget   string      // thread id for /inject commands (default "main")
	injectMode   bool        // true = Enter sends raw /event instead of chat
}

type modalSearchItem struct {
	slug  string
	label string // display text
}

// sideData holds live data for the side panel.
type sideData struct {
	Status         string
	Uptime         string
	Iteration      int
	Rate           string
	Model          string
	Mode           string
	Threads        []sideThread
	Memories       int
	Directive      string
	Computer       string // "local", "browserbase", or "" (off)
	TotalTokensIn     int
	TotalTokensCached int
	TotalTokensOut    int
	TotalCost         float64
}

type sideThread struct {
	ID       string
	ParentID string
	Depth    int
	Rate     string
	Iter     int
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

func newTUI(th theme, client *coreClient) tuiModel {
	ti := textinput.New()
	ti.Placeholder = ""
	ti.CharLimit = 1000
	ti.Prompt = ""
	ti.Focus()
	ti.TextStyle = lipgloss.NewStyle().Foreground(th.Primary)
	ti.Cursor.Style = lipgloss.NewStyle().Foreground(th.Accent)

	return tuiModel{
		th:          th,
		thoughts:    make(map[string]*threadThought),
		events:      make(map[string]*threadEvent),
		activeTools: make(map[string]*activeTool),
		threadTools: make(map[string]string),
		client:      client,
		input:       ti,
		startTime:   time.Now(),
		chatSeen:    make(map[int64]bool),
		chatTarget:  "main",
	}
}

func (m tuiModel) Init() tea.Cmd {
	return tea.Batch(
		textinput.Blink,
		tickEvery(),
		pollSideData(m.client),
		// Kick off the channel-chat bootstrap on startup. This fetches
		// (or creates) the default chat, loads recent history, and
		// opens the SSE stream. Returns a message that primes the
		// model with chatID + historical rows; subsequent live rows
		// arrive as chatRowMsg from a background goroutine.
		bootstrapChat(m.client, m.aptevaCfg.InstanceID),
	)
}

// chatBootstrapMsg is the one-shot result of the initial
// chatDefaultID + chatMessages fetch. Carries the chat id, the
// history to pre-populate scrollback, and an error if the fetch
// failed (in which case the TUI logs and continues — next manual
// refresh or reconnect will retry).
type chatBootstrapMsg struct {
	ChatID  string
	History []chatMessage
	Err     error
}

// bootstrapChat runs the HTTP setup (no SSE yet) as a tea.Cmd so the
// main goroutine can sequence it inside the bubbletea update loop.
// Uses the CLI's configured instance id — the in-cluster CLI always
// has one. We do NOT start the SSE here because tea.Cmd runs once;
// streaming is driven by a long-lived goroutine, spun up by the
// Update handler for chatBootstrapMsg.
func bootstrapChat(client *coreClient, instanceID int64) tea.Cmd {
	return func() tea.Msg {
		if instanceID <= 0 {
			return chatBootstrapMsg{Err: fmt.Errorf("no instance id configured")}
		}
		chatID, err := client.chatDefaultID(instanceID)
		if err != nil {
			return chatBootstrapMsg{Err: err}
		}
		history, err := client.chatMessages(chatID, 0)
		if err != nil {
			return chatBootstrapMsg{ChatID: chatID, Err: err}
		}
		return chatBootstrapMsg{ChatID: chatID, History: history}
	}
}

// startChatStream spins up a goroutine that reads the channel-chat
// SSE stream and forwards each row as a chatRowMsg to the bubbletea
// program. On stream end it sends chatStreamFailedMsg; the Update
// handler restarts the stream with the updated cursor.
//
// On each successful SSE open we fire "[chat] user connected to chat"
// as a raw event to the core. The agent's channel-chat routing uses
// this signal to learn that a human is present and to advertise the
// chat channel in channels_respond — without it the agent has no way
// to target a reply back at the CLI. The dashboard fires the same
// signal from ChatPanel.tsx on its onopen handler. Reconnects fire
// again so the agent re-learns presence after a stream blip.
func startChatStream(client *coreClient, p *tea.Program, chatID string, since int64, done <-chan struct{}) {
	if p == nil {
		return
	}
	onOpen := func() {
		go client.sendEvent("[chat] user connected to chat", "main")
	}
	go func() {
		ch := make(chan chatMessage, 64)
		go client.streamChatMessages(chatID, since, ch, done, onOpen)
		for {
			select {
			case <-done:
				return
			case m, ok := <-ch:
				if !ok {
					p.Send(chatStreamFailedMsg{Err: "stream ended"})
					return
				}
				p.Send(chatRowMsg{
					ID: m.ID, Role: m.Role, Content: m.Content,
					ThreadID: m.ThreadID, Status: m.Status,
				})
			}
		}
	}()
}

// renderChatRow appends one chat message to the TUI scrollback. Uses
// the same styling slots (input/output/dim) the old telemetry-stitched
// path did so the visual output is unchanged — only the data source
// moved.
func (m *tuiModel) renderChatRow(row chatMessage) {
	switch row.Role {
	case "user":
		if len(m.lines) > 0 && m.lines[len(m.lines)-1].text != "" {
			m.addLine("", "dim")
		}
		m.addLine("> "+row.Content, "input")
		m.addLine("", "dim")
	case "agent":
		if len(m.lines) > 0 && m.lines[len(m.lines)-1].text != "" {
			m.addLine("", "dim")
		}
		// Split multi-line agent replies into multiple rendered lines
		// so long responses don't blow past the terminal width.
		for _, ln := range strings.Split(row.Content, "\n") {
			m.addLine(ln, "output")
		}
	case "system":
		m.addLine("ℹ "+row.Content, "dim")
	}
}

// respondMsg, askMsg, statusMsg are now sent by the SSE handler in client.go
// when it sees tool.call/tool.result for channels_respond/channels_ask/channels_status.

func tickEvery() tea.Cmd {
	return tea.Tick(150*time.Millisecond, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func pollSideData(client *coreClient) tea.Cmd {
	return func() tea.Msg {
		sd := &sideData{}

		// Run all three polls concurrently to avoid sequential blocking
		type statusResult struct {
			data map[string]any
			err  error
		}
		type threadsResult struct {
			data []map[string]any
			err  error
		}
		type configResult struct {
			data map[string]any
			err  error
		}

		stCh := make(chan statusResult, 1)
		thCh := make(chan threadsResult, 1)
		cfgCh := make(chan configResult, 1)

		go func() { d, e := client.status(); stCh <- statusResult{d, e} }()
		go func() { d, e := client.threads(); thCh <- threadsResult{d, e} }()
		go func() { d, e := client.getConfig(); cfgCh <- configResult{d, e} }()

		if st := <-stCh; st.err == nil {
			uptime, _ := st.data["uptime_seconds"].(float64)
			iter, _ := st.data["iteration"].(float64)
			rate, _ := st.data["rate"].(string)
			model, _ := st.data["model"].(string)
			mode, _ := st.data["mode"].(string)
			paused, _ := st.data["paused"].(bool)
			memories, _ := st.data["memories"].(float64)
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

		if th := <-thCh; th.err == nil {
			for _, t := range th.data {
				id, _ := t["id"].(string)
				rate, _ := t["rate"].(string)
				iter, _ := t["iteration"].(float64)
				parentID, _ := t["parent_id"].(string)
				depth, _ := t["depth"].(float64)
				sd.Threads = append(sd.Threads, sideThread{ID: id, ParentID: parentID, Depth: int(depth), Rate: rate, Iter: int(iter)})
			}
		}

		if cfg := <-cfgCh; cfg.err == nil {
			directive, _ := cfg.data["directive"].(string)
			sd.Directive = directive
			if comp, ok := cfg.data["computer"].(map[string]any); ok && comp != nil {
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
				// Search modal — select current item or create new
				if m.modalSearch && m.modalSearchOnSelect != nil {
					if len(m.modalSearchFiltered) > 0 && m.modalCursor < len(m.modalSearchFiltered) {
						slug := m.modalSearchFiltered[m.modalCursor].slug
						cb := m.modalSearchOnSelect
						m.closeModal()
						return m, cb(slug)
					}
					// No results — create new if handler exists
					if m.modalSearchCreateOnEmpty != nil {
						name := strings.TrimSpace(m.input.Value())
						if name != "" {
							cb := m.modalSearchCreateOnEmpty
							m.closeModal()
							return m, cb(name)
						}
					}
				}
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
			case "up":
				if m.modalSearch || m.modalSelect {
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
			case "k":
				// Only use k for navigation when no input is active
				if !m.modalInput && !m.modalSearch {
					if m.modalSelect {
						if m.modalCursor > 0 {
							m.modalCursor--
						}
						return m, nil
					}
					if m.modalScroll > 0 {
						m.modalScroll--
					}
					return m, nil
				}
			case "down":
				if m.modalSearch {
					if m.modalCursor < len(m.modalSearchFiltered)-1 {
						m.modalCursor++
					}
					return m, nil
				}
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
			case "j":
				if !m.modalInput && !m.modalSearch {
					if m.modalSelect {
						if m.modalCursor < len(m.modalItems)-1 {
							m.modalCursor++
						}
						return m, nil
					}
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
				// Filter search results on every keystroke
				if m.modalSearch {
					query := strings.ToLower(strings.TrimSpace(m.input.Value()))
					if query == "" {
						m.modalSearchFiltered = m.modalSearchAll
					} else {
						var filtered []modalSearchItem
						for _, item := range m.modalSearchAll {
							if strings.Contains(strings.ToLower(item.slug), query) || strings.Contains(strings.ToLower(item.label), query) {
								filtered = append(filtered, item)
							}
						}
						m.modalSearchFiltered = filtered
					}
					m.modalCursor = 0
				}
				return m, inputCmd
			}
			return m, nil
		}
		if msg.String() == "ctrl+c" {
			return m, tea.Quit
		}

		switch msg.String() {
		case "esc":
			// no-op outside modal
		case "tab":
			// Autocomplete: fill first matching command
			val := m.input.Value()
			if strings.HasPrefix(val, "/") {
				query := strings.ToLower(val)
				for _, cmd := range allCommands {
					if cmd.cap != "" {
						switch cmd.cap {
						case "integrations":
							if !m.aptevaCfg.Capabilities.Integrations {
								continue
							}
						}
					}
					if strings.HasPrefix(cmd.name, query) && cmd.name != query {
						m.input.SetValue(cmd.name)
						m.input.CursorEnd()
						break
					}
				}
			}
			return m, nil
		case "enter":
			if m.waitingConnect {
				// waitingConnect used to gate the RULES bootstrap send
				// that set up the old [cli] channel. The new channel-
				// chat path needs no bootstrap — chat history loads on
				// startup and is always live — so first-enter is just
				// the normal input path.
				m.waitingConnect = false
				return m.handleInput()
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

	case chatBootstrapMsg:
		// Initial chat load — set chat id, pre-populate scrollback
		// from history, kick off the SSE stream. If the initial fetch
		// failed, keep the TUI usable and log — typing still works,
		// we just don't have history yet and won't stream. A /chat
		// slash command (below) offers a manual retry.
		if msg.Err != nil {
			cliLog("CHAT", "bootstrap error: "+msg.Err.Error())
		}
		if msg.ChatID == "" {
			return m, nil
		}
		m.chatID = msg.ChatID
		for _, row := range msg.History {
			m.renderChatRow(row)
			if row.ID > m.chatSince {
				m.chatSince = row.ID
			}
			m.chatSeen[row.ID] = true
		}
		m.scrollOff = 0
		// Start SSE stream from the highest id we have.
		m.chatDone = make(chan struct{})
		startChatStream(m.client, m.teaProgram, m.chatID, m.chatSince, m.chatDone)
		return m, nil

	case chatRowMsg:
		// Dedup: the hub MAY deliver a row we already saw across a
		// reconnect boundary (we bumped chatSince locally but the
		// server echoed the row again). Cheap id-based guard.
		if m.chatSeen[msg.ID] {
			return m, nil
		}
		m.chatSeen[msg.ID] = true
		if msg.ID > m.chatSince {
			m.chatSince = msg.ID
		}
		m.renderChatRow(chatMessage{
			ID: msg.ID, Role: msg.Role, Content: msg.Content,
			ThreadID: msg.ThreadID, Status: msg.Status,
		})
		// Any agent/system message clears the "waiting" spinner —
		// the agent did respond (just not via the streaming-text
		// path that used to set it, which is retired).
		if msg.Role != "user" {
			m.waiting = false
		}
		m.scrollOff = 0
		return m, nil

	case chatStreamFailedMsg:
		if msg.Err != "" {
			cliLog("CHAT", "stream ended: "+msg.Err)
		}
		// Background reconnect — same cursor, bubbletea doesn't need
		// to block. If SSE keeps failing there's a deeper problem
		// and /chat manual-refresh will show it.
		if m.chatID != "" {
			if m.chatDone != nil {
				close(m.chatDone)
			}
			m.chatDone = make(chan struct{})
			startChatStream(m.client, m.teaProgram, m.chatID, m.chatSince, m.chatDone)
		}
		return m, nil

	case streamChunkMsg:
		text := string(msg)
		if !m.streaming {
			// Start a new streaming line — add spacing if there's content above
			m.streaming = true
			m.waiting = false
			// (tool reason now tracked via activeTools)
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
		// Response arrived — if streaming, just finalize; otherwise display text
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
		m.scrollOff = 0

	case askMsg:
		m.asking = true
		m.askPending = true
		m.waiting = false
		m.addLine(string(msg), "output")
		m.scrollOff = 0

	case statusMsg:
		m.statusLine = msg.Line
		m.statusLevel = msg.Level

	case connectedMsg:
		m.connected = true
		m.waitingConnect = true // wait for user to press Enter before sending connect event

	case connectResultMsg:
		if msg.err != nil {
			m.openModal("CONNECT ERROR", []string{"", "  " + msg.err.Error(), "", "  Press Esc to close."})
		} else {
			m.openModal(strings.ToUpper(msg.gateway)+" CONNECTED", []string{"", fmt.Sprintf("  Bot @%s online.", msg.botName), "", "  Press Esc to close."})
		}
		return m, nil

	case toolStartMsg:
		isChannel := strings.HasPrefix(msg.Name, "channels_")
		// Hide noisy internal tools (same as dashboard)
		isHidden := isChannel
		switch msg.Name {
		case "send", "pace", "done", "evolve", "remember":
			isHidden = true
		}
		if isHidden {
			m.threadTools[msg.ThreadID] = "⟳ " + msg.Name
			if m.sideStatus != nil && msg.ThreadID != "main" {
				found := false
				for _, t := range m.sideStatus.Threads {
					if t.ID == msg.ThreadID {
						found = true
						break
					}
				}
				if !found {
					m.sideStatus.Threads = append(m.sideStatus.Threads, sideThread{ID: msg.ThreadID})
				}
			}
			return m, nil
		}
		callID := msg.CallID
		if callID == "" {
			callID = msg.Name + "-" + fmt.Sprintf("%d", time.Now().UnixNano())
		}
		// Add a blank line before tool call (skip if previous line is already blank)
		if len(m.lines) > 0 && m.lines[len(m.lines)-1].text != "" {
			m.addLine("", "")
		}
		label := "  ⟳ " + msg.Name
		if msg.Reason != "" {
			label += " — " + msg.Reason
		}
		m.addLine(label, "tool-active")
		lineIdx := len(m.lines) - 1

		m.activeTools[callID] = &activeTool{
			name:     msg.Name,
			reason:   msg.Reason,
			callID:   callID,
			threadID: msg.ThreadID,
			lineIdx:  lineIdx,
			started:  time.Now(),
		}
		m.threadTools[msg.ThreadID] = "⟳ " + msg.Name
		// Ensure thread exists in side panel
		if m.sideStatus != nil && msg.ThreadID != "main" {
			found := false
			for _, t := range m.sideStatus.Threads {
				if t.ID == msg.ThreadID {
					found = true
					break
				}
			}
			if !found {
				m.sideStatus.Threads = append(m.sideStatus.Threads, sideThread{ID: msg.ThreadID})
			}
		}
		m.scrollOff = 0
		return m, nil

	case toolDoneMsg:
		isHidden := strings.HasPrefix(msg.Name, "channels_")
		switch msg.Name {
		case "send", "pace", "done", "evolve", "remember":
			isHidden = true
		}
		if isHidden {
			// Clear thread tool in side panel
			hasActive := false
			for _, t := range m.activeTools {
				if t.threadID == msg.ThreadID {
					hasActive = true
					break
				}
			}
			if !hasActive {
				delete(m.threadTools, msg.ThreadID)
			}
			return m, nil
		}
		callID := msg.CallID
		at, ok := m.activeTools[callID]
		if ok {
			// Replace the running line in-place
			dur := fmt.Sprintf("%dms", msg.DurationMs)
			if msg.DurationMs >= 1000 {
				dur = fmt.Sprintf("%.1fs", float64(msg.DurationMs)/1000)
			}
			doneText := "  ✓ " + msg.Name
			if at.reason != "" {
				doneText += " — " + at.reason
			}
			doneText += " (" + dur + ")"
			if at.lineIdx >= 0 && at.lineIdx < len(m.lines) {
				m.lines[at.lineIdx].text = doneText
				m.lines[at.lineIdx].style = "tool-done"
			}
			delete(m.activeTools, callID)
			// Clear thread tool if no more active tools for this thread
			hasActive := false
			for _, t := range m.activeTools {
				if t.threadID == msg.ThreadID {
					hasActive = true
					break
				}
			}
			if !hasActive {
				delete(m.threadTools, msg.ThreadID)
			}
		} else {
			// No matching start — just show done line
			dur := fmt.Sprintf("%dms", msg.DurationMs)
			if msg.DurationMs >= 1000 {
				dur = fmt.Sprintf("%.1fs", float64(msg.DurationMs)/1000)
			}
			m.addLine("  ✓ "+msg.Name+" ("+dur+")", "tool-done")
		}
		return m, nil

	case integrateAppInfoMsg:
		fields := msg.Fields()
		if len(fields) == 0 {
			m.openModal("INTEGRATE", []string{"", "  No credential fields for " + msg.Name})
			return m, nil
		}
		// Start collecting credentials — prompt for first field, chain the rest
		m.integrateSlug = msg.Slug
		m.integrateName = msg.Name
		m.integrateFields = fields
		m.integrateCreds = make(map[string]string)
		m.integrateFieldIdx = 0
		return m, func() tea.Msg { return integrateNextFieldMsg{} }

	case integrateNextFieldMsg:
		idx := m.integrateFieldIdx
		fields := m.integrateFields
		if idx >= len(fields) {
			// All fields collected — create connection
			cli := m.client
			slug := m.integrateSlug
			creds := m.integrateCreds
			return m, func() tea.Msg {
				body, _ := json.Marshal(map[string]any{
					"app_slug":    slug,
					"name":        slug,
					"auth_type":   "api_key",
					"credentials": creds,
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
				return integrateConnectMsg{slug: slug, connID: result.ID}
			}
		}
		// Prompt for current field
		field := fields[idx]
		label := field.Label
		if label == "" {
			label = field.Name
		}
		desc := field.Description
		if desc == "" {
			desc = fmt.Sprintf("Enter your %s %s", m.integrateName, label)
		}
		title := fmt.Sprintf("CONNECT %s (%d/%d)", strings.ToUpper(m.integrateName), idx+1, len(fields))
		m.openInputModal(title, []string{"", "  " + desc, ""}, label, func(value string) tea.Cmd {
			return func() tea.Msg {
				return integrateFieldValueMsg(value)
			}
		})
		return m, nil

	case integrateFieldValueMsg:
		// Store the value and advance to next field
		field := m.integrateFields[m.integrateFieldIdx]
		m.integrateCreds[field.Name] = string(msg)
		m.integrateFieldIdx++
		return m, func() tea.Msg { return integrateNextFieldMsg{} }

	case integrateConnectMsg:
		if msg.err != nil {
			m.openModal("INTEGRATE ERROR", []string{"", "  " + msg.err.Error(), "", "  Press Esc to close."})
		} else {
			m.openModal(strings.ToUpper(msg.slug)+" CONNECTED", []string{
				"",
				"  Connection created.",
				"",
				"  The agent will discover and connect to it.",
				"",
				"  Press Esc to close.",
			})
			// Notify the agent with the MCP URL so it can connect directly
			mcpURL := fmt.Sprintf("http://127.0.0.1:%d/mcp/%d", m.aptevaCfg.ServerPort, msg.connID)
			go m.client.sendEvent(fmt.Sprintf(
				"[system] New integration connected: %s. Connect to it now: [[connect name=\"%s\" url=\"%s\" transport=\"http\"]]",
				msg.slug, msg.slug, mcpURL), "main")
		}
		return m, nil

	case integrateListMsg:
		// Auto-download catalog if empty
		if len(msg.apps) == 0 && m.serverURL != "" {
			m.addLine("Downloading integration catalog...", "dim")
			cli := m.client
			return m, func() tea.Msg {
				cli.serverPost("/integrations/catalog/download", nil)
				// Re-fetch after download
				data, err := cli.serverGet("/integrations/catalog")
				if err != nil {
					return modalMsg{title: "INTEGRATIONS", text: "  Download failed."}
				}
				var apps []struct {
					Slug        string `json:"slug"`
					Name        string `json:"name"`
					Description string `json:"description"`
					ToolCount   int    `json:"tool_count"`
				}
				json.Unmarshal(data, &apps)
				return integrateListMsg{apps: apps, connected: msg.connected}
			}
		}
		// Build header with connected apps
		var header []string
		connSet := make(map[string]bool)
		for _, s := range msg.connected {
			connSet[s] = true
		}
		if len(msg.connected) > 0 {
			header = append(header, fmt.Sprintf("  Connected: %d", len(msg.connected)))
			for _, s := range msg.connected {
				header = append(header, fmt.Sprintf("    ✓ %s", s))
			}
			header = append(header, "")
		}
		header = append(header, fmt.Sprintf("  Available: %d apps", len(msg.apps)))
		header = append(header, "")
		// Build search items
		var items []modalSearchItem
		for _, app := range msg.apps {
			prefix := "  "
			if connSet[app.Slug] {
				prefix = "✓ "
			}
			items = append(items, modalSearchItem{
				slug:  app.Slug,
				label: fmt.Sprintf("%s%-18s %s (%d tools)", prefix, app.Slug, app.Name, app.ToolCount),
			})
		}
		cli := m.client
		connSetCopy := connSet
		m.openSearchModal("INTEGRATIONS", header, items, func(slug string) tea.Cmd {
			if connSetCopy[slug] {
				// Already connected — disconnect
				return func() tea.Msg {
					// Find connection ID
					data, err := cli.serverGet("/connections")
					if err != nil {
						return modalMsg{title: "INTEGRATE", text: "  ERROR: " + err.Error()}
					}
					var conns []struct {
						ID      int64  `json:"id"`
						AppSlug string `json:"app_slug"`
					}
					json.Unmarshal(data, &conns)
					for _, c := range conns {
						if c.AppSlug == slug {
							cli.serverDelete(fmt.Sprintf("/connections/%d", c.ID))
							return modalMsg{title: "DISCONNECTED", text: fmt.Sprintf("  %s disconnected.", slug)}
						}
					}
					return modalMsg{title: "INTEGRATE", text: "  Connection not found."}
				}
			}
			// Not connected — fetch app info and prompt for credentials
			return func() tea.Msg {
				data, err := cli.serverGet("/integrations/catalog/" + slug)
				if err != nil {
					return modalMsg{title: "INTEGRATE", text: fmt.Sprintf("  App not found: %s", slug)}
				}
				var info integrateAppInfoMsg
				json.Unmarshal(data, &info)
				if info.Name == "" {
					return modalMsg{title: "INTEGRATE", text: fmt.Sprintf("  App not found: %s", slug)}
				}
				info.Slug = slug
				return info
			}
		})
		return m, nil

	case projectsListMsg:
		var lines []string
		lines = append(lines, fmt.Sprintf("  %d projects", len(msg.projects)))
		lines = append(lines, "")
		lines = append(lines, "  Select to switch, or type a new name to create:")
		lines = append(lines, "")
		cli := m.client
		projects := msg.projects
		// Build search items — include a "+" create option
		var si []modalSearchItem
		for _, p := range projects {
			label := p.Name
			if p.ID == m.aptevaCfg.ProjectID {
				label = "✓ " + label
			} else {
				label = "  " + label
			}
			si = append(si, modalSearchItem{slug: p.ID, label: label})
		}
		m.openSearchModal("PROJECTS", lines, si, func(selected string) tea.Cmd {
			// Check if selected is an existing project ID
			for _, p := range projects {
				if p.ID == selected {
					if selected == m.aptevaCfg.ProjectID {
						return func() tea.Msg {
							return modalMsg{title: "PROJECTS", text: fmt.Sprintf("  Already on: %s", p.Name)}
						}
					}
					name := p.Name
					return func() tea.Msg {
						data, err := cli.serverGet("/instances?project_id=" + selected)
						if err != nil {
							return projectSwitchedMsg{err: err}
						}
						var instances []struct {
							ID int64 `json:"id"`
						}
						json.Unmarshal(data, &instances)
						if len(instances) == 0 {
							return projectSwitchedMsg{err: fmt.Errorf("no instance in project %s", name)}
						}
						cli.switchInstance(instances[0].ID)
						return projectSwitchedMsg{projectID: selected, projectName: name, instanceID: instances[0].ID}
					}
				}
			}
			// Not found — this is a search query, not a project ID
			// If there are no filtered results, treat the search text as a new project name
			return nil
		})
		// Override: when Enter is pressed with no matching result, create a new project
		m.modalSearchCreateOnEmpty = func(name string) tea.Cmd {
			return func() tea.Msg {
				projBody, _ := json.Marshal(map[string]string{"name": name})
				projData, err := cli.serverPost("/projects", projBody)
				if err != nil {
					return projectCreatedMsg{err: err}
				}
				var proj struct{ ID string `json:"id"` }
				json.Unmarshal(projData, &proj)
				instBody, _ := json.Marshal(map[string]any{
					"name":       name,
					"directive":  "You are a helpful assistant.",
					"mode":       "autonomous",
					"project_id": proj.ID,
				})
				instData, _ := cli.serverPost("/instances", instBody)
				var inst struct{ ID int64 `json:"id"` }
				json.Unmarshal(instData, &inst)
				cli.switchInstance(inst.ID)
				return projectCreatedMsg{projectID: proj.ID, projectName: name, instanceID: inst.ID}
			}
		}
		return m, nil

	case projectSwitchedMsg:
		if msg.err != nil {
			m.openModal("PROJECT ERROR", []string{"", "  " + msg.err.Error()})
		} else {
			m.aptevaCfg.ProjectID = msg.projectID
			m.aptevaCfg.InstanceID = msg.instanceID
			saveAptevaConfig(m.aptevaCfg)
			m.cleanProjectSwitch(msg.projectName)
		}
		return m, nil

	case projectCreatedMsg:
		if msg.err != nil {
			m.openModal("PROJECT ERROR", []string{"", "  " + msg.err.Error()})
		} else {
			m.aptevaCfg.ProjectID = msg.projectID
			m.aptevaCfg.InstanceID = msg.instanceID
			saveAptevaConfig(m.aptevaCfg)
			m.cleanProjectSwitch(msg.projectName)
		}
		return m, nil

	case providerPoolMsg:
		var lines []string
		var items []string

		for _, p := range msg.providers {
			marker := "  ○"
			if p.isDefault {
				marker = "  ●"
			}
			label := fmt.Sprintf("%s %s", marker, p.ptype)
			if p.isDefault {
				label += " (default)"
			}
			lines = append(lines, label)
			lg := p.currentLarge
			if lg == "" {
				lg = "(default)"
			}
			sm := p.currentSmall
			if sm == "" {
				sm = "(default)"
			}
			lines = append(lines, fmt.Sprintf("    large: %s  small: %s", lg, sm))
			if len(p.builtinTools) > 0 {
				lines = append(lines, fmt.Sprintf("    built-in: %s", strings.Join(p.builtinTools, ", ")))
			}
			lines = append(lines, "")
			items = append(items, p.ptype)
		}
		items = append(items, "add provider")

		allProviders := msg.providers
		cli := m.client
		m.openSelectModal("PROVIDERS", lines, items, "", func(selected string) tea.Cmd {
			if selected == "add provider" {
				return func() tea.Msg {
					return providerAddMsg{client: cli}
				}
			}
			// Find the selected provider
			for _, p := range allProviders {
				if p.ptype == selected {
					detail := p
					return func() tea.Msg {
						return providerInfoMsg{detail: detail}
					}
				}
			}
			return nil
		})
		return m, nil

	case providerInfoMsg:
		p := msg.detail
		var lines []string
		lines = append(lines, fmt.Sprintf("  Provider: %s", p.ptype))
		if p.isDefault {
			lines = append(lines, "  Status:   default")
		}
		lines = append(lines, fmt.Sprintf("  Large:    %s", p.currentLarge))
		lines = append(lines, fmt.Sprintf("  Medium:   %s", p.currentMedium))
		lines = append(lines, fmt.Sprintf("  Small:    %s", p.currentSmall))
		if len(p.builtinTools) > 0 {
			lines = append(lines, fmt.Sprintf("  Built-in: %s", strings.Join(p.builtinTools, ", ")))
		}
		lines = append(lines, "")
		lines = append(lines, fmt.Sprintf("  %d models available", len(p.models)))
		lines = append(lines, "")

		items := []string{"large model", "medium model", "small model"}
		if len(p.availableBuiltins) > 0 {
			items = append(items, "toggle built-in tools")
		}
		if !p.isDefault {
			items = append(items, "set as default")
		}
		items = append(items, "remove provider")

		cli := m.client
		providerID := p.id
		models := p.models
		builtins := p.builtinTools
		availBuiltins := p.availableBuiltins
		m.openSelectModal("PROVIDER — "+strings.ToUpper(p.ptype), lines, items, "", func(selected string) tea.Cmd {
			if selected == "toggle built-in tools" {
				enabledSet := make(map[string]bool)
				for _, b := range builtins {
					enabledSet[b] = true
				}
				var toggleItems []string
				var toggleLines []string
				toggleLines = append(toggleLines, "")
				for _, b := range availBuiltins {
					check := "[ ]"
					if enabledSet[b] {
						check = "[x]"
					}
					toggleLines = append(toggleLines, fmt.Sprintf("  %s %s", check, b))
					toggleItems = append(toggleItems, b)
				}
				toggleLines = append(toggleLines, "")
				toggleLines = append(toggleLines, "  Select to toggle:")
				return func() tea.Msg {
					return builtinToolsToggleMsg{providerID: providerID, available: availBuiltins, enabled: builtins, items: toggleItems, lines: toggleLines, client: cli}
				}
			}
			if selected == "set as default" {
				ptype := p.ptype
				return func() tea.Msg {
					// Fetch all providers, rebuild with this one as default, push to core
					data, err := cli.serverGet("/providers")
					if err != nil {
						return modalMsg{title: "ERROR", text: "  " + err.Error()}
					}
					var provs []struct {
						ID   int64  `json:"id"`
						Type string `json:"type"`
					}
					json.Unmarshal(data, &provs)

					var configs []map[string]any
					for _, p := range provs {
						switch p.Type {
						case "fireworks", "openai", "anthropic", "google", "ollama":
							detail, _ := cli.serverGet(fmt.Sprintf("/providers/%d", p.ID))
							var pd struct{ Data map[string]string `json:"data"` }
							json.Unmarshal(detail, &pd)
							entry := map[string]any{
								"name":    p.Type,
								"default": p.Type == ptype,
								"models": map[string]string{
									"large":  pd.Data["model_large"],
									"medium": pd.Data["model_medium"],
									"small":  pd.Data["model_small"],
								},
							}
							configs = append(configs, entry)
						}
					}
					if len(configs) > 0 {
						body, _ := json.Marshal(map[string]any{"providers": configs})
						cli.do(cli.putRequest("/config", body))
					}
					return modalMsg{title: "DEFAULT", text: fmt.Sprintf("  %s is now the default provider.", ptype)}
				}
			}
			if selected == "remove provider" {
				return func() tea.Msg {
					err := cli.serverDelete(fmt.Sprintf("/providers/%d", providerID))
					if err != nil {
						return modalMsg{title: "ERROR", text: "  " + err.Error()}
					}
					return modalMsg{title: "REMOVED", text: fmt.Sprintf("  Provider %s removed.\n  Restart instance to apply.", p.ptype)}
				}
			}
			// Model change
			tier := strings.TrimSuffix(selected, " model")
			var si []modalSearchItem
			for _, model := range models {
				label := model.ID
				if model.ContextSize > 0 {
					label = fmt.Sprintf("%-40s %dK ctx", model.ID, model.ContextSize/1024)
				}
				si = append(si, modalSearchItem{slug: model.ID, label: label})
			}
			return func() tea.Msg {
				return providerModelListMsg{tier: tier, providerID: providerID, items: si, client: cli}
			}
		})
		return m, nil

	case credentialUpdateMsg:
		if msg.fieldIdx >= len(msg.fields) {
			// All fields collected — update provider + hot-connect
			cli := msg.client
			pid := msg.providerID
			ptype := msg.ptype
			values := msg.values
			return m, func() tea.Msg {
				// Read existing, merge, PUT back
				detail, err := cli.serverGet(fmt.Sprintf("/providers/%d", pid))
				if err != nil {
					return modalMsg{title: "ERROR", text: "  " + err.Error()}
				}
				var pd struct {
					Type string            `json:"type"`
					Name string            `json:"name"`
					Data map[string]string `json:"data"`
				}
				json.Unmarshal(detail, &pd)
				if pd.Data == nil {
					pd.Data = map[string]string{}
				}
				for k, v := range values {
					pd.Data[k] = v
				}
				putBody, _ := json.Marshal(pd)
				req, _ := http.NewRequest("PUT", cli.apiBase()+fmt.Sprintf("/providers/%d", pid), bytes.NewReader(putBody))
				req.Header.Set("Content-Type", "application/json")
				if cli.apiKey != "" {
					req.Header.Set("Authorization", "Bearer "+cli.apiKey)
				}
				resp, err := cli.do(req)
				if err != nil {
					return modalMsg{title: "ERROR", text: "  " + err.Error()}
				}
				resp.Body.Close()
				// Auto-connect if browser provider
				if ptype == "browserbase" || ptype == "browser" {
					apiKey := values["BROWSERBASE_API_KEY"]
					projectID := values["BROWSERBASE_PROJECT_ID"]
					if apiKey != "" {
						err := cli.setComputer(map[string]any{
							"type": "browserbase", "api_key": apiKey,
							"project_id": projectID, "width": 1280, "height": 800,
						})
						if err != nil {
							return modalMsg{title: "CREDENTIALS", text: fmt.Sprintf("  Credentials saved but connect failed: %v", err)}
						}
						return modalMsg{title: "BROWSERBASE", text: "  Credentials updated and connected."}
					}
				}
				return modalMsg{title: "CREDENTIALS", text: "  Credentials updated."}
			}
		}
		field := msg.fields[msg.fieldIdx]
		remaining := msg
		m.openInputModal(
			"CREDENTIALS — "+strings.ToUpper(msg.ptype),
			[]string{"", fmt.Sprintf("  Field %d/%d: %s", msg.fieldIdx+1, len(msg.fields), field), ""},
			field,
			func(value string) tea.Cmd {
				remaining.values[field] = value
				remaining.fieldIdx++
				return func() tea.Msg { return remaining }
			},
		)
		return m, nil

	case providerAddMsg:
		cli := msg.client
		providerTypes := []string{"fireworks", "openai", "anthropic", "google", "ollama"}
		m.openSelectModal("ADD PROVIDER", []string{"", "  Select provider type:", ""}, providerTypes, "", func(selected string) tea.Cmd {
			p := getProviderByName(selected)
			if p == nil {
				return func() tea.Msg {
					return modalMsg{title: "ERROR", text: fmt.Sprintf("  Unknown provider: %s", selected)}
				}
			}
			if selected == "ollama" {
				// No API key needed
				return func() tea.Msg {
					body, _ := json.Marshal(map[string]any{
						"type": selected, "name": selected,
						"data": map[string]string{
							"model_large":  p.Large,
							"model_medium": p.Medium,
							"model_small":  p.Small,
						},
					})
					_, err := cli.serverPost("/providers", body)
					return providerAddedMsg{ptype: selected, err: err}
				}
			}
			// Need API key — return msg to trigger input modal
			provName := selected
			envVar := p.EnvVar
			lg, md, sm := p.Large, p.Medium, p.Small
			return func() tea.Msg {
				return providerNeedKeyMsg{client: cli, ptype: provName, envVar: envVar, large: lg, medium: md, small: sm}
			}
		})
		return m, nil

	case providerNeedKeyMsg:
		cli := msg.client
		ptype := msg.ptype
		envVar := msg.envVar
		lg, md, sm := msg.large, msg.medium, msg.small
		m.openInputModal(strings.ToUpper(ptype)+" API KEY", []string{"", "  Enter API key:", ""}, "Key", func(apiKey string) tea.Cmd {
			return func() tea.Msg {
				body, _ := json.Marshal(map[string]any{
					"type": ptype, "name": ptype,
					"data": map[string]string{
						envVar:         apiKey,
						"model_large":  lg,
						"model_medium": md,
						"model_small":  sm,
					},
				})
				_, err := cli.serverPost("/providers", body)
				return providerAddedMsg{ptype: ptype, err: err}
			}
		})
		return m, nil

	case providerAddedMsg:
		if msg.err != nil {
			m.openModal("ERROR", []string{"", "  " + msg.err.Error()})
		} else {
			go m.client.pushProvidersToCore()
			m.openModal("PROVIDER ADDED", []string{"", fmt.Sprintf("  %s added and activated.", msg.ptype)})
		}
		return m, nil

	case providerModelListMsg:
		m.openSearchModal(
			fmt.Sprintf("%s MODEL", strings.ToUpper(msg.tier)),
			[]string{"", "  Select a model:", ""},
			msg.items,
			func(modelID string) tea.Cmd {
				cli := msg.client
				providerID := msg.providerID
				tier := msg.tier
				return func() tea.Msg {
					// Read existing provider data, merge change, PUT back
					detail, err := cli.serverGet(fmt.Sprintf("/providers/%d", providerID))
					if err != nil {
						return providerModelSetMsg{tier: tier, err: err}
					}
					var pd struct {
						Type string            `json:"type"`
						Name string            `json:"name"`
						Data map[string]string `json:"data"`
					}
					json.Unmarshal(detail, &pd)
					if pd.Data == nil {
						pd.Data = map[string]string{}
					}
					pd.Data["model_"+tier] = modelID
					body, _ := json.Marshal(pd)
					req, _ := http.NewRequest("PUT", cli.apiBase()+fmt.Sprintf("/providers/%d", providerID), bytes.NewReader(body))
					req.Header.Set("Content-Type", "application/json")
					if cli.apiKey != "" {
						req.Header.Set("Authorization", "Bearer "+cli.apiKey)
					}
					resp, err := cli.do(req)
					if err != nil {
						return providerModelSetMsg{tier: tier, err: err}
					}
					resp.Body.Close()
					return providerModelSetMsg{tier: tier, model: modelID}
				}
			},
		)
		return m, nil

	case builtinToolsToggleMsg:
		cli := msg.client
		providerID := msg.providerID
		enabled := msg.enabled
		m.openSelectModal("BUILT-IN TOOLS", msg.lines, msg.items, "", func(tool string) tea.Cmd {
			// Toggle: add if not present, remove if present
			enabledSet := make(map[string]bool)
			for _, b := range enabled {
				enabledSet[b] = true
			}
			if enabledSet[tool] {
				delete(enabledSet, tool)
			} else {
				enabledSet[tool] = true
			}
			var newEnabled []string
			for b := range enabledSet {
				newEnabled = append(newEnabled, b)
			}
			btJSON, _ := json.Marshal(newEnabled)
			return func() tea.Msg {
				// Read existing, merge, PUT back
				detail, err := cli.serverGet(fmt.Sprintf("/providers/%d", providerID))
				if err != nil {
					return providerModelSetMsg{tier: "builtin", err: err}
				}
				var pd struct {
					Type string            `json:"type"`
					Name string            `json:"name"`
					Data map[string]string `json:"data"`
				}
				json.Unmarshal(detail, &pd)
				if pd.Data == nil {
					pd.Data = map[string]string{}
				}
				pd.Data["builtin_tools"] = string(btJSON)
				body, _ := json.Marshal(pd)
				req, _ := http.NewRequest("PUT", cli.apiBase()+fmt.Sprintf("/providers/%d", providerID), bytes.NewReader(body))
				req.Header.Set("Content-Type", "application/json")
				if cli.apiKey != "" {
					req.Header.Set("Authorization", "Bearer "+cli.apiKey)
				}
				resp, err := cli.do(req)
				if err != nil {
					return providerModelSetMsg{tier: "builtin", err: err}
				}
				resp.Body.Close()
				return providerModelSetMsg{tier: "builtin", model: strings.Join(newEnabled, ", ")}
			}
		})
		return m, nil

	case providerModelSetMsg:
		if msg.err != nil {
			m.openModal("PROVIDER", []string{"", "  ERROR: " + msg.err.Error()})
		} else {
			go m.client.pushProvidersToCore()
			m.openModal("PROVIDER", []string{"", fmt.Sprintf("  %s model set to: %s", msg.tier, msg.model)})
		}
		return m, nil

	case settingsUpdatedMsg:
		m.aptevaCfg = AptevaConfig(msg)
		status := fmt.Sprintf("  tools=%v  browser=%v  integrations=%v  telegram=%v  projects=%v",
			msg.Capabilities.Tools, msg.Capabilities.Browser, msg.Capabilities.Integrations, msg.Capabilities.Telegram, msg.Capabilities.Projects)
		m.openModal("SETTINGS UPDATED", []string{"", status, "", "  Changes take effect immediately.", "", "  Press Esc to close."})
		return m, nil

	case computerSelectMsg:
		// Re-dispatch as if user typed /computer <value>
		return m.handleCommand("/computer " + string(msg))

	case computerMenuMsg:
		items := []string{"local", "browserbase", "off"}
		if msg.hasBBProvider {
			items = append(items, "update credentials")
		}
		m.openSelectModal(
			"COMPUTER",
			[]string{
				"",
				fmt.Sprintf("  Current: %s", msg.current),
				"",
				"  local        — launch local Chrome via CDP",
				"  " + msg.bbLabel,
				"  off          — disconnect",
				"",
			},
			items,
			msg.current,
			func(value string) tea.Cmd {
				if value == "update credentials" {
					return func() tea.Msg {
						return credentialUpdateMsg{
							providerID: msg.bbProviderID,
							ptype:      "browserbase",
							fields:     []string{"BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"},
							values:     map[string]string{},
							fieldIdx:   0,
							client:     m.client,
						}
					}
				}
				return func() tea.Msg {
					return computerSelectMsg(value)
				}
			},
		)
		return m, nil

	case browserbaseKeyMsg:
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
					return browserbaseProjectMsg(apiKey)
				}
			},
		)
		return m, nil

	case browserbaseProjectMsg:
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
					// Remove old browser provider if exists
					if provData, err := cli.serverGet("/providers"); err == nil {
						var provs []struct {
							ID   int64  `json:"id"`
							Type string `json:"type"`
						}
						json.Unmarshal(provData, &provs)
						for _, p := range provs {
							if p.Type == "browserbase" || p.Type == "browser" {
								cli.serverDelete(fmt.Sprintf("/providers/%d", p.ID))
							}
						}
					}

					// Save new provider
					provBody, _ := json.Marshal(map[string]any{
						"type": "browserbase", "name": "Browserbase",
						"data": map[string]string{
							"BROWSERBASE_API_KEY":    apiKey,
							"BROWSERBASE_PROJECT_ID": projectID,
						},
					})
					cli.serverPost("/providers", provBody)

					// Connect to core
					err := cli.setComputer(map[string]any{
						"type": "browserbase", "api_key": apiKey,
						"project_id": projectID, "width": 1280, "height": 800,
					})
					if err != nil {
						return modalMsg{title: "BROWSERBASE", text: fmt.Sprintf("  ERROR: %v", err)}
					}
					return modalMsg{title: "BROWSERBASE", text: "  Browserbase connected and credentials saved."}
				}
			},
		)
		return m, nil

	case sideDataMsg:
		// Merge poll data into existing sideStatus to preserve SSE-injected state
		if m.sideStatus == nil {
			m.sideStatus = msg
		} else {
			m.sideStatus.Uptime = msg.Uptime
			m.sideStatus.Status = msg.Status
			m.sideStatus.Mode = msg.Mode
			m.sideStatus.Directive = msg.Directive
			m.sideStatus.Computer = msg.Computer
			m.sideStatus.Memories = msg.Memories
			// Only overwrite iteration/rate/model if poll has newer data
			if msg.Iteration >= m.sideStatus.Iteration {
				m.sideStatus.Iteration = msg.Iteration
				m.sideStatus.Rate = msg.Rate
				m.sideStatus.Model = msg.Model
			}
			// Replace thread list from poll — poll is authoritative for which threads exist
			m.sideStatus.Threads = msg.Threads
		}
		return m, nil

	case sideSSEUpdate:
		if m.sideStatus == nil {
			m.sideStatus = &sideData{}
		}
		m.sideStatus.Status = "RUNNING"
		m.sideStatus.Uptime = formatDuration(time.Since(m.startTime))
		m.sideStatus.Memories = msg.MemoryCount
		// Accumulate tokens and cost
		m.sideStatus.TotalTokensIn += msg.TokensIn
		m.sideStatus.TotalTokensCached += msg.TokensCached
		m.sideStatus.TotalTokensOut += msg.TokensOut
		m.sideStatus.TotalCost += msg.CostUSD
		// Only update global status from main thread
		if msg.ThreadID == "main" || msg.ThreadID == "" {
			m.sideStatus.Iteration = msg.Iteration
			m.sideStatus.Rate = msg.Rate
			m.sideStatus.Model = msg.Model
		}
		// Update thread in list
		found := false
		for i, t := range m.sideStatus.Threads {
			if t.ID == msg.ThreadID {
				m.sideStatus.Threads[i].Iter = msg.Iteration
				m.sideStatus.Threads[i].Rate = msg.Rate
				found = true
				break
			}
		}
		if !found && msg.ThreadID != "" {
			m.sideStatus.Threads = append(m.sideStatus.Threads, sideThread{
				ID: msg.ThreadID, Rate: msg.Rate, Iter: msg.Iteration,
			})
		}
		return m, nil

	case threadSpawnMsg:
		if m.sideStatus == nil {
			m.sideStatus = &sideData{}
		}
		// Calculate depth from parent chain
		depth := 0
		if msg.ParentID != "" && msg.ParentID != "main" {
			depth = 1 // at least depth 1
			for _, t := range m.sideStatus.Threads {
				if t.ID == msg.ParentID {
					depth = t.Depth + 1
					break
				}
			}
		}
		m.sideStatus.Threads = append(m.sideStatus.Threads, sideThread{
			ID: msg.ID, ParentID: msg.ParentID, Depth: depth, Rate: "reactive", Iter: 0,
		})
		return m, nil

	case threadDoneMsg:
		if m.sideStatus != nil {
			id := string(msg)
			var kept []sideThread
			for _, t := range m.sideStatus.Threads {
				if t.ID != id {
					kept = append(kept, t)
				}
			}
			m.sideStatus.Threads = kept
		}
		// Clean up thought/event data
		delete(m.thoughts, string(msg))
		delete(m.events, string(msg))
		return m, nil

	case directiveChangedMsg:
		if m.sideStatus != nil {
			m.sideStatus.Directive = string(msg)
		}
		return m, nil

	case modeChangedMsg:
		if m.sideStatus != nil {
			m.sideStatus.Mode = string(msg)
		}
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
		// Poll every ~5s for thread list + status (SSE handles thoughts/events in real-time)
		if m.pollCounter-m.lastPollTick >= 33 { // 33 * 150ms = ~5s
			m.lastPollTick = m.pollCounter
			cmds = append(cmds, pollSideData(m.client))
		}
		// Update uptime locally
		if m.sideStatus != nil {
			m.sideStatus.Uptime = formatDuration(time.Since(m.startTime))
		}
		cmds = append(cmds, tickEvery())

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.input.Width = m.chatWidth() - 8 // panel padding (4) + prompt (2) + margin (2)
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

	// If answering a cli_ask question — send reply to server
	if m.asking && m.askPending {
		m.asking = false
		m.askPending = false
		m.addLine("> "+text, "input")
		go m.client.submitCLIReply(text)
		return *m, nil
	}

	// Local commands
	if strings.HasPrefix(text, "/") {
		return m.handleCommand(text)
	}

	// Send path — either chat (default) or raw inject depending on
	// the current mode. Inject sends the text verbatim to the core's
	// /event endpoint with no prefix, mirroring the dashboard's
	// Inject panel. Chat posts through the channel-chat app; server
	// writes the row + echoes it back via SSE, so we do NOT
	// optimistic-insert (the chat-stream handler is the single
	// source of truth — avoids every ordering/dedup bug the old
	// path had).
	m.waiting = true
	m.scrollOff = 0

	if m.injectMode {
		// Raw inject — no [tag] prefix, no chat bookkeeping. The
		// row shows up in scrollback immediately because nothing
		// will echo it back. Distinct styling so it's obvious the
		// event bypassed chat.
		if len(m.lines) > 0 {
			m.addLine("", "dim")
		}
		m.addLine("» "+text, "input") // » = inject, vs > for chat
		m.addLine("", "dim")
		target := m.chatTarget
		if target == "" {
			target = "main"
		}
		go m.client.sendEvent(text, target)
		return *m, nil
	}

	if m.chatID == "" {
		// Bootstrap hasn't resolved the chat yet (transient during
		// startup). Fall back to the raw path so the user's first
		// message isn't lost. Rare — bootstrap is one HTTP round-trip.
		if len(m.lines) > 0 {
			m.addLine("", "dim")
		}
		m.addLine("> "+text, "input")
		m.addLine("", "dim")
		go m.client.sendEvent("[chat] "+text, "main")
		return *m, nil
	}

	// Chat path — post, wait for the SSE echo to render.
	chatID := m.chatID
	go func(content string) {
		if err := m.client.chatPost(chatID, content); err != nil {
			cliLog("CHAT", "post failed: "+err.Error())
		}
	}(text)

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
		// Wipe DB-backed chat history via the channel-chat app so
		// the dashboard and the CLI see the same state. Previously
		// we also nuked core's LLM history via /config reset — that
		// conflates two concerns (UI history vs agent memory). Keep
		// /clear as UI-only; use /reset for the LLM side.
		if m.chatID != "" {
			cli := m.client
			chatID := m.chatID
			go func() {
				if err := cli.chatClear(chatID); err != nil {
					cliLog("CHAT", "clear failed: "+err.Error())
				}
			}()
		}
		m.chatSince = 0
		m.chatSeen = make(map[int64]bool)

	case "/reset":
		// Reset the agent's LLM message history WITHOUT clearing
		// the chat UI. Useful when the agent gets stuck in a
		// tangent but you want to keep the conversation visible.
		cli := m.client
		go func() {
			body, _ := json.Marshal(map[string]any{"reset": map[string]bool{"history": true}})
			cli.do(cli.putRequest("/config", body))
		}()
		m.addLine("ℹ agent LLM history reset (chat UI kept)", "dim")

	case "/inject":
		// One-shot inject. Rest of the line becomes the payload,
		// sent as-is to the core's /event endpoint with the current
		// target thread (default "main"). Does NOT flip inject mode.
		rest := strings.TrimSpace(strings.TrimPrefix(text, "/inject"))
		if rest == "" {
			m.addLine("ℹ /inject <text> — send one raw event without entering inject mode", "dim")
			return *m, nil
		}
		target := m.chatTarget
		if target == "" {
			target = "main"
		}
		cli := m.client
		go func(payload, t string) {
			if err := cli.sendEvent(payload, t); err != nil {
				cliLog("INJECT", "send failed: "+err.Error())
			}
		}(rest, target)
		m.addLine(fmt.Sprintf("» [inject→%s] %s", target, rest), "input")

	case "/inject-mode":
		// Persistent toggle: every subsequent Enter sends raw /event
		// instead of chat. Status line reflects the current mode.
		m.injectMode = !m.injectMode
		if m.injectMode {
			m.addLine("ℹ inject mode ON — messages go raw to core /event. Use /chat to return.", "dim")
		} else {
			m.addLine("ℹ inject mode OFF — back to normal chat.", "dim")
		}

	case "/chat":
		// Shortcut to leave inject mode.
		if m.injectMode {
			m.injectMode = false
			m.addLine("ℹ chat mode — messages go through channel-chat.", "dim")
		} else {
			m.addLine("ℹ already in chat mode.", "dim")
		}

	case "/target":
		// Set the target thread for /inject and inject-mode sends.
		// Empty / "main" returns to the default. No validation —
		// unknown threads just get an event they'll ignore.
		if len(parts) < 2 {
			m.addLine(fmt.Sprintf("ℹ /target <thread>  (current: %s)", m.chatTarget), "dim")
			return *m, nil
		}
		m.chatTarget = parts[1]
		m.addLine("ℹ inject target → "+m.chatTarget, "dim")

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
						botName, err := cli.connectTelegram(token)
						if err != nil {
							return connectResultMsg{gateway: "telegram", err: err}
						}
						return connectResultMsg{gateway: "telegram", botName: botName}
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
			m.addLine("Disconnecting telegram...", "dim")
			// TODO: add server endpoint to disconnect telegram
			m.client.sendEvent("[telegram] gateway disconnected", "main")
			m.addLine("Telegram disconnected.", "output")
		default:
			m.addLine(fmt.Sprintf("Unknown gateway: %s", rest), "warn")
		}

	case "/channels":
		cli := m.client
		return *m, func() tea.Msg {
			data, err := cli.serverGet(fmt.Sprintf("/instances/%d/channels", m.aptevaCfg.InstanceID))
			if err != nil {
				return modalMsg{title: "CHANNELS", text: "  ERROR: " + err.Error()}
			}
			var channels []struct {
				ID      string `json:"id"`
				Status  string `json:"status"`
				BotName string `json:"bot_name"`
			}
			json.Unmarshal(data, &channels)
			var lines []string
			lines = append(lines, fmt.Sprintf("  %d connected", len(channels)))
			lines = append(lines, "")
			for _, ch := range channels {
				label := fmt.Sprintf("  %-15s %s", ch.ID, ch.Status)
				if ch.BotName != "" {
					label += "  @" + ch.BotName
				}
				lines = append(lines, label)
			}
			lines = append(lines, "", "  /connect telegram — add Telegram bot")
			return modalMsg{title: "CHANNELS", text: strings.Join(lines, "\n")}
		}

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
				w, h := 1024, 768
				err := cli.setComputer(map[string]any{"type": "local", "width": w, "height": h})
				if err != nil {
					return modalMsg{title: "COMPUTER", text: fmt.Sprintf("  ERROR: %v", err)}
				}
				return modalMsg{title: "COMPUTER", text: fmt.Sprintf("  Local Chrome launched (%dx%d).", w, h)}
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
			cli := m.client
			// Check if browserbase provider already exists
			return *m, func() tea.Msg {
				data, err := cli.serverGet("/providers")
				if err != nil {
					return browserbaseKeyMsg("") // fall through to prompt
				}
				var provs []struct {
					ID   int64  `json:"id"`
					Type string `json:"type"`
				}
				json.Unmarshal(data, &provs)
				for _, p := range provs {
					if p.Type == "browserbase" || p.Type == "browser" {
						// Provider exists — get credentials and connect
						detail, err := cli.serverGet(fmt.Sprintf("/providers/%d", p.ID))
						if err != nil {
							continue
						}
						var pd struct {
							Data map[string]string `json:"data"`
						}
						json.Unmarshal(detail, &pd)
						apiKey := pd.Data["BROWSERBASE_API_KEY"]
						projectID := pd.Data["BROWSERBASE_PROJECT_ID"]
						if apiKey != "" {
							err := cli.setComputer(map[string]any{
								"type": "browserbase", "api_key": apiKey,
								"project_id": projectID, "width": 1280, "height": 800,
							})
							if err != nil {
								return modalMsg{title: "BROWSERBASE", text: fmt.Sprintf("  ERROR: %v", err)}
							}
							return modalMsg{title: "BROWSERBASE", text: "  Browserbase connected (saved credentials)."}
						}
					}
				}
				// No provider — prompt for credentials
				return browserbaseKeyMsg("")
			}
		case "":
			// Interactive select — check current status + saved provider
			cli := m.client
			return *m, func() tea.Msg {
				cfg, _ := cli.getConfig()
				current := "off"
				if cfg != nil {
					if comp, ok := cfg["computer"].(map[string]any); ok && comp != nil {
						if t, ok := comp["type"].(string); ok && t != "" {
							current = t
						}
					}
				}
				// Check for saved browserbase provider
				var bbProviderID int64
				provData, _ := cli.serverGet("/providers")
				if provData != nil {
					var provs []struct {
						ID   int64  `json:"id"`
						Type string `json:"type"`
					}
					json.Unmarshal(provData, &provs)
					for _, p := range provs {
						if p.Type == "browserbase" || p.Type == "browser" {
							bbProviderID = p.ID
						}
					}
				}
				bbLabel := "browserbase  — cloud browser (needs API key)"
				if bbProviderID > 0 {
					bbLabel = "browserbase  — cloud browser (credentials saved ✓)"
				}
				return computerMenuMsg{current: current, bbLabel: bbLabel, hasBBProvider: bbProviderID > 0, bbProviderID: bbProviderID}
			}
		default:
			m.openModal("COMPUTER", []string{"", fmt.Sprintf("  Unknown type: %s", rest), "", "  Available: local, browserbase, off"})
		}

	case "/provider":
		cli := m.client
		return *m, func() tea.Msg {
			data, err := cli.serverGet("/providers")
			if err != nil {
				return modalMsg{title: "PROVIDERS", text: "  ERROR: " + err.Error()}
			}
			var providers []struct {
				ID   int64  `json:"id"`
				Type string `json:"type"`
				Name string `json:"name"`
			}
			json.Unmarshal(data, &providers)
			if len(providers) == 0 {
				return modalMsg{title: "PROVIDERS", text: "  No provider configured.\n  Run /setup to add one."}
			}

			// Available built-in tools per provider type
			availableBuiltins := map[string][]string{
				"anthropic": {"code_execution", "web_search"},
				"openai":    {"code_interpreter"},
				"google":    {"code_execution"},
			}

			// Get actual default from core's config
			defaultProvider := ""
			if coreCfg, err := cli.getConfig(); err == nil {
				if provs, ok := coreCfg["providers"].([]any); ok {
					for _, raw := range provs {
						if pm, ok := raw.(map[string]any); ok {
							if def, _ := pm["default"].(bool); def {
								defaultProvider, _ = pm["name"].(string)
							}
						}
					}
				}
			}

			var details []providerDetail
			for _, p := range providers {
				// Only include LLM providers
				switch strings.ToLower(p.Type) {
				case "fireworks", "openai", "anthropic", "google", "ollama":
				default:
					continue
				}

				detail := providerDetail{
					id:        p.ID,
					ptype:     p.Type,
					name:      p.Name,
					isDefault: strings.EqualFold(p.Type, defaultProvider),
				}

				// Get model list
				modelData, _ := cli.serverGet(fmt.Sprintf("/providers/%d/models", p.ID))
				json.Unmarshal(modelData, &detail.models)

				// Get current config
				cfgData, _ := cli.serverGet(fmt.Sprintf("/providers/%d", p.ID))
				var provCfg struct {
					Data map[string]string `json:"data"`
				}
				json.Unmarshal(cfgData, &provCfg)
				detail.currentLarge = provCfg.Data["model_large"]
				detail.currentMedium = provCfg.Data["model_medium"]
				detail.currentSmall = provCfg.Data["model_small"]
				if bt := provCfg.Data["builtin_tools"]; bt != "" {
					json.Unmarshal([]byte(bt), &detail.builtinTools)
				}
				detail.availableBuiltins = availableBuiltins[p.Type]

				details = append(details, detail)
			}

			return providerPoolMsg{providers: details}
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
			// Fetch apps and show searchable list
			return *m, func() tea.Msg {
				// Fetch connected
				var connectedSlugs []string
				if data, err := cli.serverGet("/connections"); err == nil {
					var connected []struct {
						AppSlug string `json:"app_slug"`
					}
					json.Unmarshal(data, &connected)
					for _, c := range connected {
						connectedSlugs = append(connectedSlugs, c.AppSlug)
					}
				}
				// Fetch catalog
				data, err := cli.serverGet("/integrations/catalog")
				if err != nil {
					return modalMsg{title: "INTEGRATIONS", text: fmt.Sprintf("  ERROR: %v", err)}
				}
				var apps []struct {
					Slug        string `json:"slug"`
					Name        string `json:"name"`
					Description string `json:"description"`
					ToolCount   int    `json:"tool_count"`
				}
				json.Unmarshal(data, &apps)
				return integrateListMsg{apps: apps, connected: connectedSlugs}
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

	case "/projects":
		if !m.aptevaCfg.Capabilities.Projects {
			m.openModal("PROJECTS", []string{"", "  Projects not enabled.", "  Use /settings to enable."})
			return *m, nil
		}
		rest := strings.TrimSpace(strings.TrimPrefix(text, "/projects"))
		cli := m.client
		if rest != "" {
			// /projects create <name>
			if strings.HasPrefix(rest, "create ") {
				name := strings.TrimPrefix(rest, "create ")
				return *m, func() tea.Msg {
					// Create project
					projBody, _ := json.Marshal(map[string]string{"name": name})
					projData, err := cli.serverPost("/projects", projBody)
					if err != nil {
						return projectCreatedMsg{err: err}
					}
					var proj struct{ ID string `json:"id"` }
					json.Unmarshal(projData, &proj)
					// Create instance in project
					instBody, _ := json.Marshal(map[string]any{
						"name":       name,
						"directive":  "You are a helpful assistant.",
						"mode":       "autonomous",
						"project_id": proj.ID,
					})
					instData, _ := cli.serverPost("/instances", instBody)
					var inst struct{ ID int64 `json:"id"` }
					json.Unmarshal(instData, &inst)
					// Switch to it
					cli.switchInstance(inst.ID)
					return projectCreatedMsg{projectID: proj.ID, projectName: name, instanceID: inst.ID}
				}
			}
			m.openModal("PROJECTS", []string{"", "  Usage: /projects or /projects create <name>"})
			return *m, nil
		}
		// List projects
		return *m, func() tea.Msg {
			data, err := cli.serverGet("/projects")
			if err != nil {
				return modalMsg{title: "PROJECTS", text: "  ERROR: " + err.Error()}
			}
			var projects []projectInfo
			json.Unmarshal(data, &projects)
			return projectsListMsg{projects: projects}
		}

	case "/settings":
		items := []string{"tools", "browser", "integrations", "telegram", "projects"}
		var lines []string
		lines = append(lines, "")
		lines = append(lines, "  Toggle features on/off:")
		lines = append(lines, "")
		for _, item := range items {
			check := "[ ]"
			switch item {
			case "tools":
				if m.aptevaCfg.Capabilities.Tools {
					check = "[x]"
				}
			case "browser":
				if m.aptevaCfg.Capabilities.Browser {
					check = "[x]"
				}
			case "integrations":
				if m.aptevaCfg.Capabilities.Integrations {
					check = "[x]"
				}
			case "telegram":
				if m.aptevaCfg.Capabilities.Telegram {
					check = "[x]"
				}
			case "projects":
				if m.aptevaCfg.Capabilities.Projects {
					check = "[x]"
				}
			}
			label := map[string]string{
				"tools":        "System tools (exec, web)",
				"browser":      "Browser (local Chrome)",
				"integrations": "Integrations (263+ apps)",
				"telegram":     "Telegram gateway",
				"projects":     "Projects (multi-project)",
			}[item]
			lines = append(lines, fmt.Sprintf("  %s %s", check, label))
		}
		lines = append(lines, "")
		lines = append(lines, "  Select to toggle:")
		m.openSelectModal("SETTINGS", lines, items, "", func(item string) tea.Cmd {
			return func() tea.Msg {
				cfg := loadAptevaConfig()
				switch item {
				case "tools":
					cfg.Capabilities.Tools = !cfg.Capabilities.Tools
				case "browser":
					cfg.Capabilities.Browser = !cfg.Capabilities.Browser
				case "integrations":
					cfg.Capabilities.Integrations = !cfg.Capabilities.Integrations
				case "telegram":
					cfg.Capabilities.Telegram = !cfg.Capabilities.Telegram
				case "projects":
					cfg.Capabilities.Projects = !cfg.Capabilities.Projects
				}
				saveAptevaConfig(cfg)
				return settingsUpdatedMsg(cfg)
			}
		})

	case "/setup":
		m.addLine("Re-run full setup: ./apteva --setup", "dim")

	case "/stats":
		cli := m.client
		instID := m.aptevaCfg.InstanceID
		return *m, func() tea.Msg {
			data, err := cli.serverGet(fmt.Sprintf("/telemetry/stats?instance_id=%d&period=24h", instID))
			if err != nil {
				return modalMsg{title: "STATS", text: "  ERROR: " + err.Error()}
			}
			var stats struct {
				TotalEvents  int     `json:"total_events"`
				LLMCalls     int     `json:"llm_calls"`
				TokensIn     int     `json:"total_tokens_in"`
				TokensOut    int     `json:"total_tokens_out"`
				TotalCost    float64 `json:"total_cost"`
				AvgDuration  float64 `json:"avg_duration_ms"`
				ThreadsSpawn int     `json:"threads_spawned"`
				ThreadsDone  int     `json:"threads_done"`
				ToolCalls    int     `json:"tool_calls"`
				Errors       int     `json:"errors"`
			}
			json.Unmarshal(data, &stats)
			lines := fmt.Sprintf(
				"  USAGE (last 24h)\n"+
					"  ─────────────────────────────\n"+
					"  LLM Calls:      %d\n"+
					"  Tokens In:      %d\n"+
					"  Tokens Out:     %d\n"+
					"  Total Cost:     $%.4f\n"+
					"  Avg Duration:   %.0fms\n"+
					"  ─────────────────────────────\n"+
					"  Tool Calls:     %d\n"+
					"  Threads:        %d spawned / %d done\n"+
					"  Errors:         %d\n"+
					"  Total Events:   %d",
				stats.LLMCalls, stats.TokensIn, stats.TokensOut,
				stats.TotalCost, stats.AvgDuration,
				stats.ToolCalls, stats.ThreadsSpawn, stats.ThreadsDone,
				stats.Errors, stats.TotalEvents,
			)
			return modalMsg{title: "STATS", text: lines}
		}

	case "/history":
		rest := strings.TrimSpace(strings.TrimPrefix(text, "/history"))
		cli := m.client
		instID := m.aptevaCfg.InstanceID
		// /history         — show recent activity (thoughts + tool calls)
		// /history tools   — show recent tool calls
		// /history errors  — show recent errors
		// /history threads — show thread spawn/done history
		eventType := ""
		title := "RECENT ACTIVITY"
		limit := 20
		switch rest {
		case "tools":
			eventType = "tool.call"
			title = "TOOL CALLS"
		case "errors":
			eventType = "llm.error"
			title = "ERRORS"
		case "threads":
			eventType = "thread.spawn"
			title = "THREAD HISTORY"
			limit = 30
		}
		return *m, func() tea.Msg {
			params := fmt.Sprintf("/telemetry?instance_id=%d&limit=%d", instID, limit)
			if eventType != "" {
				params += "&type=" + eventType
			}
			data, err := cli.serverGet(params)
			if err != nil {
				return modalMsg{title: title, text: "  ERROR: " + err.Error()}
			}
			var events []struct {
				ThreadID string         `json:"thread_id"`
				Type     string         `json:"type"`
				Time     string         `json:"time"`
				Data     map[string]any `json:"data"`
			}
			json.Unmarshal(data, &events)
			if len(events) == 0 {
				return modalMsg{title: title, text: "  No events found."}
			}
			var lines []string
			for _, ev := range events {
				ts := ev.Time
				if len(ts) > 19 {
					ts = ts[11:19] // HH:MM:SS
				}
				switch ev.Type {
				case "llm.done":
					msg, _ := ev.Data["message"].(string)
					if len(msg) > 80 {
						msg = msg[:80] + "..."
					}
					tokIn, _ := ev.Data["tokens_in"].(float64)
					tokOut, _ := ev.Data["tokens_out"].(float64)
					cost, _ := ev.Data["cost_usd"].(float64)
					lines = append(lines, fmt.Sprintf("  %s [%s] %d→%d tok $%.4f", ts, ev.ThreadID, int(tokIn), int(tokOut), cost))
					if msg != "" {
						lines = append(lines, fmt.Sprintf("         %s", msg))
					}
				case "tool.call":
					name, _ := ev.Data["name"].(string)
					reason, _ := ev.Data["reason"].(string)
					line := fmt.Sprintf("  %s [%s] ⚡ %s", ts, ev.ThreadID, name)
					if reason != "" {
						if len(reason) > 50 {
							reason = reason[:50] + "..."
						}
						line += " — " + reason
					}
					lines = append(lines, line)
				case "tool.result":
					name, _ := ev.Data["name"].(string)
					durMs, _ := ev.Data["duration_ms"].(float64)
					success, _ := ev.Data["success"].(bool)
					icon := "✓"
					if !success {
						icon = "✗"
					}
					lines = append(lines, fmt.Sprintf("  %s [%s] %s %s (%dms)", ts, ev.ThreadID, icon, name, int(durMs)))
				case "thread.spawn":
					dir, _ := ev.Data["directive"].(string)
					if len(dir) > 60 {
						dir = dir[:60] + "..."
					}
					lines = append(lines, fmt.Sprintf("  %s ⚙ %s spawned", ts, ev.ThreadID))
					if dir != "" {
						lines = append(lines, fmt.Sprintf("         %s", dir))
					}
				case "thread.done":
					lines = append(lines, fmt.Sprintf("  %s ✓ %s done", ts, ev.ThreadID))
				case "llm.error":
					errMsg, _ := ev.Data["error"].(string)
					if len(errMsg) > 70 {
						errMsg = errMsg[:70] + "..."
					}
					lines = append(lines, fmt.Sprintf("  %s [%s] ✗ %s", ts, ev.ThreadID, errMsg))
				default:
					lines = append(lines, fmt.Sprintf("  %s [%s] %s", ts, ev.ThreadID, ev.Type))
				}
			}
			return modalMsg{title: title, text: strings.Join(lines, "\n")}
		}

	case "/dashboard":
		url := fmt.Sprintf("http://localhost:%d/app/", m.aptevaCfg.ServerPort)
		m.addLine("Opening dashboard: "+url, "dim")
		go exec.Command("xdg-open", url).Run()

	case "/help":
		m.modal = true
		m.modalTitle = "HELP"
		m.modalLines = []string{
			"  /status              show core status",
			"  /config              show full config",
			"  /directive [text]    show or set directive",
			"  /mode [name]         show or set mode",
			"  /provider            switch provider/models",
			"  /computer [type]     connect browser (local/browserbase/off)",
			"  /threads             list/kill threads",
			"  /mcp                 manage MCP servers",
		}
		if m.aptevaCfg.Capabilities.Integrations {
			m.modalLines = append(m.modalLines, "  /integrate [app]     manage integrations (263+ apps)")
		}
		if m.aptevaCfg.Capabilities.Projects {
			m.modalLines = append(m.modalLines, "  /projects            switch/create projects")
		}
		m.modalLines = append(m.modalLines,
			"  /pause               toggle pause/resume",
			"  /connect <gateway>   connect a gateway (telegram)",
			"  /disconnect <gw>    disconnect a gateway",
			"  /channels            list connected channels",
			"  /settings            toggle features on/off",
			"  /setup               re-run full setup wizard",
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

func (m *tuiModel) cleanProjectSwitch(name string) {
	m.lines = nil
	m.sideStatus = nil
	m.thoughts = make(map[string]*threadThought)
	m.events = make(map[string]*threadEvent)
	m.activeTools = make(map[string]*activeTool)
	m.threadTools = make(map[string]string)
	m.streaming = false
	m.waiting = false
	m.waitingConnect = true // require Enter to connect to new instance

	// Restart SSE by closing old and starting new
	if m.sseDone != nil {
		close(m.sseDone)
	}
	m.sseDone = make(chan struct{})
	if m.teaProgram != nil {
		go streamToolChunks(m.client, m.teaProgram, m.sseDone)
	}

	m.addLine(fmt.Sprintf("Switched to: %s", name), "dim")
	m.addLine("", "dim")
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
	m.modalSearch = false
	m.modalSearchAll = nil
	m.modalSearchFiltered = nil
	m.modalSearchOnSelect = nil
	m.modalSearchCreateOnEmpty = nil
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

func (m *tuiModel) openSearchModal(title string, header []string, items []modalSearchItem, onSelect func(string) tea.Cmd) {
	m.modal = true
	m.modalTitle = title
	m.modalLines = header
	m.modalScroll = 0
	m.modalSearch = true
	m.modalSearchAll = items
	m.modalSearchFiltered = items
	m.modalCursor = 0
	m.modalSearchOnSelect = onSelect
	m.modalInput = true
	m.modalPrompt = "Search"
	m.input.SetValue("")
	m.input.Placeholder = "type to filter..."
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
		cli := m.client
		m.addLine("Connecting to Telegram...", "dim")
		return *m, func() tea.Msg {
			botName, err := cli.connectTelegram(token)
			if err != nil {
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
	chatContentH := contentHeight - 2 // -2 for separator + input
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
		case "tool-active":
			// Smooth breathing: cycle through 8 phases (150ms * 8 = 1.2s full cycle)
			phase := m.spinnerTick % 8
			var toolColor lipgloss.Color
			switch {
			case phase < 2:
				toolColor = m.th.ToolActive // bright
			case phase < 4:
				toolColor = m.th.ToolDim // fading
			case phase < 6:
				toolColor = m.th.ToolDim // dim
			default:
				toolColor = m.th.ToolActive // rising
			}
			styled = lipgloss.NewStyle().Foreground(toolColor).Render(line.text)
		case "tool-done":
			styled = lipgloss.NewStyle().Foreground(m.th.ToolDone).Render(line.text)
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
		if m.serverURL != "" {
			chatLines = append(chatLines, "")
			chatLines = append(chatLines, dim.Render("  Dashboard: "+m.serverURL))
		}
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

	// Input line — truncate to panel width so long text scrolls instead of overflowing
	prompt := primary.Bold(true).Render("> ")
	inputView := m.input.View()
	inputLine := prompt + inputView

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
	// Reserve space for input/select/search rows if needed
	extraRows := 0
	if m.modalSearch {
		extraRows = 2 + min(len(m.modalSearchFiltered)+1, 12) // separator + input + results
	} else if m.modalInput {
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

	// Search results inside modal
	if m.modalSearch {
		maxShow := 10
		filtered := m.modalSearchFiltered
		if len(filtered) > maxShow {
			filtered = filtered[:maxShow]
		}
		for i, item := range filtered {
			var label string
			if i == m.modalCursor {
				label = accent.Bold(true).Render("  > " + item.label)
			} else {
				label = primary.Render("    " + item.label)
			}
			if lipgloss.Width(label) > innerW {
				label = truncateToWidth(label, innerW)
			}
			itemPad := innerW - lipgloss.Width(label)
			if itemPad < 0 {
				itemPad = 0
			}
			contentLines = append(contentLines, dim.Render("│ ")+label+strings.Repeat(" ", itemPad)+dim.Render(" │"))
		}
		if len(m.modalSearchFiltered) > maxShow {
			more := fmt.Sprintf("    ...%d more", len(m.modalSearchFiltered)-maxShow)
			pad := innerW - len(more)
			if pad < 0 {
				pad = 0
			}
			contentLines = append(contentLines, dim.Render("│ ")+dim.Render(more)+strings.Repeat(" ", pad)+dim.Render(" │"))
		}
		if len(m.modalSearchFiltered) == 0 {
			noResults := "    no results"
			pad := innerW - len(noResults)
			if pad < 0 {
				pad = 0
			}
			contentLines = append(contentLines, dim.Render("│ ")+dim.Render(noResults)+strings.Repeat(" ", pad)+dim.Render(" │"))
		}
	}

	// Footer
	footer := dim.Render("  esc to close")
	if m.modalSearch {
		footer = dim.Render("  type to filter · ↑↓ select · enter to connect · esc to close")
	} else if m.modalInput {
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
		// Token/cost tracker
		if sd.TotalTokensIn > 0 || sd.TotalTokensOut > 0 || sd.TotalTokensCached > 0 {
			lines = append(lines, "")
			tokIn := formatTokenCount(sd.TotalTokensIn)
			tokOut := formatTokenCount(sd.TotalTokensOut)
			tokenLine := tokIn + " in / " + tokOut + " out"
			if sd.TotalTokensCached > 0 {
				tokenLine += " / " + formatTokenCount(sd.TotalTokensCached) + " cached"
			}
			lines = append(lines, dim.Render("TOKENS  ")+primary.Render(tokenLine))
			if sd.TotalCost > 0 {
				lines = append(lines, dim.Render("COST    ")+accent.Render(fmt.Sprintf("$%.4f", sd.TotalCost)))
			}
		}
		lines = append(lines, "")

		// Directive (truncated to 3 lines max)
		lines = append(lines, dim.Render(strings.Repeat("─", w)))
		lines = append(lines, accent.Bold(true).Render("DIRECTIVE"))
		lines = append(lines, "")
		directive := sd.Directive
		wrapped := wrapText(directive, w)
		maxLines := 3
		for i, dl := range wrapped {
			if i >= maxLines {
				lines = append(lines, dim.Render("…"))
				break
			}
			lines = append(lines, dim.Render(dl))
		}
		lines = append(lines, "")

		// Threads + latest thoughts — rendered as tree
		lines = append(lines, dim.Render(strings.Repeat("─", w)))
		lines = append(lines, accent.Bold(true).Render(fmt.Sprintf("THREADS (%d)", len(sd.Threads))))
		lines = append(lines, "")

		// Sort threads: group children under parents using depth-first ordering
		orderedThreads := orderThreadTree(sd.Threads)

		for _, t := range orderedThreads {
			// Build tree prefix based on depth
			indent := ""
			for i := 0; i < t.Depth; i++ {
				indent += "  "
			}
			if t.Depth > 0 {
				indent += "├ "
			}

			// Thread name — truncate to fit
			name := t.ID
			maxName := w - len(indent) - 10
			if maxName < 6 {
				maxName = 6
			}
			if len(name) > maxName {
				name = name[:maxName-1] + "…"
			}

			label := dim.Render(indent) + primary.Render(name) + " "
			// Show active tool or rate
			if toolLabel, ok := m.threadTools[t.ID]; ok {
				phase := m.spinnerTick % 8
				toolColor := m.th.ToolActive
				if phase >= 2 && phase < 6 {
					toolColor = m.th.ToolDim
				}
				lines = append(lines, label+lipgloss.NewStyle().Foreground(toolColor).Render(toolLabel))
			} else {
				info := dim.Render(fmt.Sprintf("#%d %s", t.Iter, t.Rate))
				lines = append(lines, label+info)
			}

			// Show latest thought with decay
			if thought, ok := m.thoughts[t.ID]; ok {
				age := time.Since(thought.Time)
				if age < 2*time.Minute {
					text := thought.Text
					// Clean up: single line, truncate
					text = strings.ReplaceAll(text, "\n", " ")
					text = strings.Join(strings.Fields(text), " ")
					thoughtIndent := indent
					if t.Depth > 0 {
						thoughtIndent += "  "
					}
					maxLen := w - len(thoughtIndent) - 2
					if maxLen > 80 {
						maxLen = 80
					}
					if maxLen < 10 {
						maxLen = 10
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
					lines = append(lines, thoughtStyle.Render(thoughtIndent+"  "+text))
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
					if maxLen > 1 && len(text) > maxLen {
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

// orderThreadTree sorts threads into depth-first tree order.
// Children appear directly after their parent, grouped by parent.
func orderThreadTree(threads []sideThread) []sideThread {
	if len(threads) == 0 {
		return threads
	}

	// Separate root (main) from children
	var roots []sideThread
	children := map[string][]sideThread{} // parentID → children
	for _, t := range threads {
		if t.ID == "main" || (t.ParentID == "" && t.Depth == 0 && t.ID != "main") {
			// Root-level: main itself, or depth-0 threads with no parent (legacy)
			if t.ID == "main" {
				roots = append([]sideThread{t}, roots...) // main always first
			} else {
				roots = append(roots, t)
			}
		} else {
			pid := t.ParentID
			if pid == "" {
				pid = "main"
			}
			children[pid] = append(children[pid], t)
		}
	}

	// DFS: roots first, then their children
	var result []sideThread
	var walk func(node sideThread)
	walk = func(node sideThread) {
		result = append(result, node)
		for _, child := range children[node.ID] {
			walk(child)
		}
	}
	for _, root := range roots {
		walk(root)
	}

	// If any threads weren't reached (orphans), append them at the end
	if len(result) < len(threads) {
		seen := map[string]bool{}
		for _, t := range result {
			seen[t.ID] = true
		}
		for _, t := range threads {
			if !seen[t.ID] {
				result = append(result, t)
			}
		}
	}

	return result
}

func formatTokenCount(n int) string {
	if n >= 1_000_000 {
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	}
	if n >= 1_000 {
		return fmt.Sprintf("%.1fK", float64(n)/1_000)
	}
	return fmt.Sprintf("%d", n)
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
