package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

type coreClient struct {
	base           string
	client         *http.Client
	apiKey         string // Bearer token for server auth
	instancePrefix string // e.g. "/instances/1" — prepended to core API paths
}

func newCoreClient(addr string) *coreClient {
	return &coreClient{
		base:   "http://" + addr,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// do executes an HTTP request with auth header.
func (c *coreClient) do(req *http.Request) (*http.Response, error) {
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	return c.client.Do(req)
}

// apiBase returns the server's /api prefix. All REST/JSON endpoints live
// under /api/ to avoid colliding with the SPA's client-side routes. Only
// external endpoints (/webhooks, /oauth, /mcp) and the public /health
// liveness check stay at root on the server.
func (c *coreClient) apiBase() string {
	return c.base + "/api"
}

// coreURL builds a URL for a core API path, with instance prefix if set.
// Everything gets routed under /api — the server proxies per-instance paths
// like /api/instances/:id/status through to the actual core process.
func (c *coreClient) coreURL(path string) string {
	if c.instancePrefix != "" {
		return c.apiBase() + c.instancePrefix + path
	}
	return c.apiBase() + path
}

// health checks if server/core is reachable.
func (c *coreClient) health() error {
	req, _ := http.NewRequest("GET", c.coreURL("/health"), nil)
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("health: HTTP %d", resp.StatusCode)
	}
	return nil
}

// switchInstance disconnects MCP from current instance and connects to a new one.
func (c *coreClient) switchInstance(instanceID int64) error {
	// Disconnect from old instance
	c.sendEvent("[cli] root user disconnected from terminal", "main")

	// Switch to new instance
	c.instancePrefix = fmt.Sprintf("/instances/%d", instanceID)

	// Start it if needed
	startInstance(c, instanceID)

	// Wait for it
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if err := c.health(); err == nil {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	// No RULES bootstrap on switch — chat goes through the
	// channel-chat app, which the agent already knows how to reply
	// on via channels_respond(channel="chat", ...). The previous
	// bootstrap was a workaround for the telemetry-stitched chat
	// path that's been retired.
	return nil
}

// startInstance starts a stopped instance via server API.
func startInstance(client *coreClient, instanceID int64) error {
	req, _ := http.NewRequest("POST", client.apiBase()+fmt.Sprintf("/instances/%d/start", instanceID), nil)
	resp, err := client.do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// submitCLIReply sends the user's answer to a pending channels_ask call.
func (c *coreClient) submitCLIReply(text string) error {
	body, _ := json.Marshal(map[string]string{"text": text})
	req, _ := http.NewRequest("POST", c.coreURL("/channels/cli/reply"), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// pushProvidersToCore fetches all LLM providers from server and pushes config to core (hot-reload).
func (c *coreClient) pushProvidersToCore() {
	data, err := c.serverGet("/providers")
	if err != nil {
		return
	}
	var provs []struct {
		ID   int64  `json:"id"`
		Type string `json:"type"`
	}
	json.Unmarshal(data, &provs)

	// Get current default from core
	defaultProv := ""
	if coreCfg, err := c.getConfig(); err == nil {
		if ps, ok := coreCfg["providers"].([]any); ok {
			for _, raw := range ps {
				if pm, ok := raw.(map[string]any); ok {
					if def, _ := pm["default"].(bool); def {
						defaultProv, _ = pm["name"].(string)
					}
				}
			}
		}
	}

	var configs []map[string]any
	for _, p := range provs {
		switch p.Type {
		case "fireworks", "openai", "anthropic", "google", "ollama":
			detail, _ := c.serverGet(fmt.Sprintf("/providers/%d", p.ID))
			var pd struct{ Data map[string]string `json:"data"` }
			json.Unmarshal(detail, &pd)
			entry := map[string]any{
				"name":    p.Type,
				"default": p.Type == defaultProv,
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
		c.do(c.putRequest("/config", body))
	}
}

// connectTelegram tells the server to start a Telegram gateway for this instance.
func (c *coreClient) connectTelegram(token string) (string, error) {
	body, _ := json.Marshal(map[string]string{"token": token})
	req, _ := http.NewRequest("POST", c.coreURL("/channels/telegram"), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var result struct {
		BotName string `json:"bot_name"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("server error: HTTP %d", resp.StatusCode)
	}
	return result.BotName, nil
}

// status fetches core status.
func (c *coreClient) status() (map[string]any, error) {
	req, _ := http.NewRequest("GET", c.coreURL("/status"), nil)
	resp, err := c.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return out, nil
}

// threads fetches active threads.
func (c *coreClient) threads() ([]map[string]any, error) {
	req, _ := http.NewRequest("GET", c.coreURL("/threads"), nil)
	resp, err := c.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out []map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return out, nil
}

// sendEvent posts a message to the core event bus.
// Raw path — bypasses the channel-chat app and lands the text in the
// thinker's inbox with no prefix. Used by the CLI's inject slash
// commands (/inject, /inject-mode) and by platform bookkeeping events
// like the disconnect signal on instance switch.
func (c *coreClient) sendEvent(message, threadID string) error {
	body, _ := json.Marshal(map[string]string{
		"message":   message,
		"thread_id": threadID,
	})
	req, _ := http.NewRequest("POST", c.coreURL("/event"), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// --- channel-chat app client ------------------------------------------
//
// Mirrors the dashboard's chat.* client. The CLI targets the same
// endpoints so both consumers of the same instance see exactly the
// same chat rows (DB-backed, monotonic id, no ordering / dedup bugs).

type chatRow struct {
	ID         string `json:"id"`
	InstanceID int64  `json:"instance_id"`
	Title      string `json:"title"`
}

type chatMessage struct {
	ID        int64  `json:"id"`
	ChatID    string `json:"chat_id"`
	Role      string `json:"role"` // user | agent | system
	Content   string `json:"content"`
	ThreadID  string `json:"thread_id,omitempty"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
}

// chatDefaultID returns the default chat id for an instance — creates
// one if it doesn't exist yet. Idempotent on the server (insert-or-
// ignore), so safe to call on every TUI startup.
func (c *coreClient) chatDefaultID(instanceID int64) (string, error) {
	u := c.apiBase() + "/apps/channel-chat/chats?instance_id=" + itoaInt64(instanceID)
	req, _ := http.NewRequest("GET", u, nil)
	resp, err := c.do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("list chats: HTTP %d", resp.StatusCode)
	}
	var chats []chatRow
	if err := json.NewDecoder(resp.Body).Decode(&chats); err != nil {
		return "", err
	}
	if len(chats) == 0 {
		// POST to create the default chat.
		body, _ := json.Marshal(map[string]any{"instance_id": instanceID})
		req, _ := http.NewRequest("POST", c.apiBase()+"/apps/channel-chat/chats", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := c.do(req)
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		var created chatRow
		if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
			return "", err
		}
		return created.ID, nil
	}
	return chats[0].ID, nil
}

// chatMessages fetches history since a cursor. since=0 loads everything.
func (c *coreClient) chatMessages(chatID string, since int64) ([]chatMessage, error) {
	u := fmt.Sprintf("%s/apps/channel-chat/messages?chat_id=%s&since=%d",
		c.apiBase(), urlEncode(chatID), since)
	req, _ := http.NewRequest("GET", u, nil)
	resp, err := c.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("messages: HTTP %d", resp.StatusCode)
	}
	var msgs []chatMessage
	if err := json.NewDecoder(resp.Body).Decode(&msgs); err != nil {
		return nil, err
	}
	return msgs, nil
}

// chatPost writes a user message to the chat. Server echoes it back
// on the SSE stream, so the caller must NOT also optimistic-insert
// — the stream handler in the TUI is the single point of truth.
func (c *coreClient) chatPost(chatID, content string) error {
	body, _ := json.Marshal(map[string]string{"content": content})
	u := fmt.Sprintf("%s/apps/channel-chat/messages?chat_id=%s",
		c.apiBase(), urlEncode(chatID))
	req, _ := http.NewRequest("POST", u, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("chat post: HTTP %d", resp.StatusCode)
	}
	return nil
}

// chatClear wipes every message in the chat. The chat row itself and
// the agent's LLM memory are untouched — separate concerns.
func (c *coreClient) chatClear(chatID string) error {
	u := fmt.Sprintf("%s/apps/channel-chat/messages?chat_id=%s",
		c.apiBase(), urlEncode(chatID))
	req, _ := http.NewRequest("DELETE", u, nil)
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// streamChatMessages opens the chat SSE stream and pushes each new
// message onto ch. Reconnect with since=<last_id> fills any gap — the
// caller tracks the highest id it has seen and bumps on each delivery.
// Closes when done is closed.
func (c *coreClient) streamChatMessages(chatID string, since int64, ch chan<- chatMessage, done <-chan struct{}) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() { <-done; cancel() }()

	u := fmt.Sprintf("%s/apps/channel-chat/stream?chat_id=%s&since=%d",
		c.apiBase(), urlEncode(chatID), since)
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	sseClient := &http.Client{Timeout: 0}
	resp, err := sseClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()

	buf := make([]byte, 4096)
	var line []byte
	for {
		select {
		case <-done:
			return
		default:
		}
		n, err := resp.Body.Read(buf)
		if n > 0 {
			line = append(line, buf[:n]...)
			for {
				idx := bytes.IndexByte(line, '\n')
				if idx < 0 {
					break
				}
				raw := bytes.TrimSpace(line[:idx])
				line = line[idx+1:]
				if bytes.HasPrefix(raw, []byte("data: ")) {
					var m chatMessage
					if json.Unmarshal(raw[6:], &m) == nil {
						select {
						case ch <- m:
						case <-done:
							return
						}
					}
				}
			}
		}
		if err == io.EOF || err != nil {
			return
		}
	}
}

// itoaInt64 / urlEncode are local helpers kept in client.go so we
// don't pull in strconv / net/url for two tiny call sites.
func itoaInt64(n int64) string { return fmt.Sprintf("%d", n) }

func urlEncode(s string) string {
	// Chat ids are safe kebab/alpha-numeric; percent-encode
	// defensively for the few characters that could leak if someone
	// ever renames the id scheme.
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' {
			out = append(out, c)
		} else {
			out = append(out, '%',
				"0123456789ABCDEF"[c>>4],
				"0123456789ABCDEF"[c&0x0F])
		}
	}
	return string(out)
}

// pause toggles pause.
func (c *coreClient) pause() (bool, error) {
	req, _ := http.NewRequest("POST", c.coreURL("/pause"), nil)
	resp, err := c.do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	var out struct {
		Paused bool `json:"paused"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	return out.Paused, nil
}

// getConfig fetches current config.
func (c *coreClient) getConfig() (map[string]any, error) {
	req, _ := http.NewRequest("GET", c.coreURL("/config"), nil)
	resp, err := c.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return out, nil
}

type mcpServerEntry struct {
	Name       string `json:"name"`
	URL        string `json:"url,omitempty"`
	Command    string `json:"command,omitempty"`
	Transport  string `json:"transport,omitempty"`
	MainAccess bool   `json:"main_access,omitempty"`
}

// connectMCP adds the CLI's MCP server to core config.
func (c *coreClient) connectMCP(name, url string) error {
	// Get current config to read existing mcp_servers
	cfg, err := c.getConfig()
	if err != nil {
		return fmt.Errorf("get config: %w", err)
	}

	// Build desired list: existing servers + our new one
	var servers []mcpServerEntry
	if raw, ok := cfg["mcp_servers"]; ok && raw != nil {
		data, _ := json.Marshal(raw)
		json.Unmarshal(data, &servers)
	}

	// Remove any stale entry with same name
	var clean []mcpServerEntry
	for _, s := range servers {
		if s.Name != name {
			clean = append(clean, s)
		}
	}
	clean = append(clean, mcpServerEntry{
		Name:       name,
		URL:        url,
		Transport:  "http",
		MainAccess: true,
	})

	body, _ := json.Marshal(map[string]any{"mcp_servers": clean})
	resp, err := c.do(c.putRequest("/config", body))
	if err != nil {
		return fmt.Errorf("put config: %w", err)
	}
	resp.Body.Close()
	return nil
}

// disconnectMCP removes the CLI's MCP server from core config.
func (c *coreClient) disconnectMCP(name string) error {
	cfg, err := c.getConfig()
	if err != nil {
		return err
	}

	var servers []mcpServerEntry
	if raw, ok := cfg["mcp_servers"]; ok && raw != nil {
		data, _ := json.Marshal(raw)
		json.Unmarshal(data, &servers)
	}

	var clean []mcpServerEntry
	for _, s := range servers {
		if s.Name != name {
			clean = append(clean, s)
		}
	}

	body, _ := json.Marshal(map[string]any{"mcp_servers": clean})
	resp, err := c.do(c.putRequest("/config", body))
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// setComputer updates the computer config via PUT /config.
func (c *coreClient) setComputer(computer map[string]any) error {
	body, _ := json.Marshal(map[string]any{"computer": computer})
	resp, err := c.do(c.putRequest("/config", body))
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// killThread kills a thread via DELETE /threads/{id}.
func (c *coreClient) killThread(id string) error {
	req, _ := http.NewRequest("DELETE", c.coreURL("/threads/"+id), nil)
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

// setMode updates the core mode via PUT /config.
func (c *coreClient) setMode(mode string) error {
	body, _ := json.Marshal(map[string]string{"mode": mode})
	resp, err := c.do(c.putRequest("/config", body))
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// setDirective updates the core directive via PUT /config.
func (c *coreClient) setDirective(directive string) error {
	body, _ := json.Marshal(map[string]string{"directive": directive})
	resp, err := c.do(c.putRequest("/config", body))
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

func (c *coreClient) putRequest(path string, body []byte) *http.Request {
	req, _ := http.NewRequest("PUT", c.coreURL(path), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	return req
}

// streamEvents opens SSE connection and sends events to a channel.
func (c *coreClient) streamEvents(ch chan<- map[string]any, done <-chan struct{}) {
	// Use context so closing done cancels the HTTP request and unblocks Read
	ctx, cancel := context.WithCancel(context.Background())
	go func() { <-done; cancel() }()

	req, _ := http.NewRequestWithContext(ctx, "GET", c.coreURL("/events"), nil)
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	sseClient := &http.Client{Timeout: 0}
	resp, err := sseClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()

	buf := make([]byte, 4096)
	var line []byte
	for {
		select {
		case <-done:
			return
		default:
		}
		n, err := resp.Body.Read(buf)
		if n > 0 {
			line = append(line, buf[:n]...)
			// Process complete SSE lines
			for {
				idx := bytes.IndexByte(line, '\n')
				if idx < 0 {
					break
				}
				raw := bytes.TrimSpace(line[:idx])
				line = line[idx+1:]
				if bytes.HasPrefix(raw, []byte("data: ")) {
					var ev map[string]any
					if json.Unmarshal(raw[6:], &ev) == nil {
						ch <- ev
					}
				}
			}
		}
		if err == io.EOF {
			return
		}
		if err != nil {
			return
		}
	}
}

// streamToolChunks listens to SSE events and forwards structured
// messages to the TUI. This used to stitch chat text from
// channels_respond tool args — that responsibility has moved to the
// channel-chat app's dedicated stream (see streamChatMessages). What
// remains here is tool-activity + thinking + status telemetry that
// drives the status line and the side panel, not the chat itself.
func streamToolChunks(client *coreClient, p *tea.Program, done <-chan struct{}) {
	evCh := make(chan map[string]any, 256)
	go client.streamEvents(evCh, done)

	for {
		select {
		case <-done:
			return
		case ev, ok := <-evCh:
			if !ok {
				return
			}
			typ, _ := ev["type"].(string)
			data, _ := ev["data"].(map[string]any)

			switch typ {
			case "tool.call":
				if data != nil {
					threadID, _ := ev["thread_id"].(string)
					if threadID == "" {
						threadID = "main"
					}
					name, _ := data["name"].(string)
					reason, _ := data["reason"].(string)
					callID, _ := data["id"].(string)
					if name != "" {
						p.Send(toolStartMsg{
							ThreadID: threadID,
							Name:     name,
							Reason:   reason,
							CallID:   callID,
						})
					}
					// Channel tools: signal CLI for status-line updates.
					if name == "channels_status" {
						args, _ := data["args"].(map[string]any)
						if args != nil {
							line, _ := args["line"].(string)
							level, _ := args["level"].(string)
							if level == "" {
								level = "info"
							}
							p.Send(statusMsg(statusUpdate{Line: line, Level: level}))
						}
					}
				}
			case "tool.result":
				if data != nil {
					threadID, _ := ev["thread_id"].(string)
					if threadID == "" {
						threadID = "main"
					}
					name, _ := data["name"].(string)
					callID, _ := data["id"].(string)
					durMs, _ := data["duration_ms"].(float64)
					success, _ := data["success"].(bool)
					if name != "" {
						p.Send(toolDoneMsg{
							ThreadID:   threadID,
							Name:       name,
							CallID:     callID,
							DurationMs: int64(durMs),
							Success:    success,
						})
					}
				}
			case "llm.done":
				if data != nil {
					threadID, _ := ev["thread_id"].(string)
					if threadID == "" {
						threadID = "main"
					}
					msg, _ := data["message"].(string)
					if msg != "" {
						if len(msg) > 200 {
							msg = msg[:200] + "..."
						}
						p.Send(thoughtMsg{ThreadID: threadID, Text: msg})
					}
					// Update side panel from llm.done data
					iter, _ := data["iteration"].(float64)
					rate, _ := data["rate"].(string)
					model, _ := data["model"].(string)
					memCount, _ := data["memory_count"].(float64)
					threadCount, _ := data["thread_count"].(float64)
					tokensIn, _ := data["tokens_in"].(float64)
					tokensCached, _ := data["tokens_cached"].(float64)
					tokensOut, _ := data["tokens_out"].(float64)
					costUSD, _ := data["cost_usd"].(float64)
					p.Send(sideSSEUpdate{
						ThreadID:     threadID,
						Iteration:    int(iter),
						Rate:         rate,
						Model:        model,
						MemoryCount:  int(memCount),
						ThreadCount:  int(threadCount),
						TokensIn:     int(tokensIn),
						TokensCached: int(tokensCached),
						TokensOut:    int(tokensOut),
						CostUSD:      costUSD,
					})
				}
			case "thread.spawn":
				if data != nil {
					id, _ := data["id"].(string)
					parentID, _ := data["parent_id"].(string)
					directive, _ := data["directive"].(string)
					p.Send(threadSpawnMsg{ID: id, ParentID: parentID, Directive: directive})
				}
			case "thread.done":
				if data != nil {
					id, _ := data["id"].(string)
					p.Send(threadDoneMsg(id))
				}
			case "directive.evolved":
				if data != nil {
					newDir, _ := data["new"].(string)
					if newDir != "" {
						p.Send(directiveChangedMsg(newDir))
					}
				}
			case "mode.changed":
				if data != nil {
					mode, _ := data["mode"].(string)
					if mode != "" {
						p.Send(modeChangedMsg(mode))
					}
				}
			case "event.received":
				if data != nil {
					threadID, _ := ev["thread_id"].(string)
					if threadID == "" {
						threadID = "main"
					}
					source, _ := data["source"].(string)
					message, _ := data["message"].(string)
					if message != "" {
						if len(message) > 100 {
							message = message[:100] + "..."
						}
						p.Send(eventReceivedMsg{ThreadID: threadID, Source: source, Message: message})
					}
				}
				// llm.tool_chunk is intentionally ignored here — chat
				// text arrives through the channel-chat SSE stream, not
				// reconstructed from streaming tool-call JSON fragments.
			}
		}
	}
}

// textExtractor incrementally extracts the "text" value from streaming JSON
// fragments like: {"te  →  xt": "H  →  ello  →  "}
// Once it finds "text":" it emits everything after that as text,
// handling escaped characters. Handles escape sequences split across chunks.
type textExtractor struct {
	buf        strings.Builder
	inText     bool // we've found "text":" and are extracting
	emitted    int  // how many bytes of the text value we've already emitted
	pendingEsc bool // previous chunk ended with a backslash
}

func (e *textExtractor) reset() {
	e.buf.Reset()
	e.inText = false
	e.emitted = 0
	e.pendingEsc = false
}

func (e *textExtractor) feed(chunk string) string {
	e.buf.WriteString(chunk)
	s := e.buf.String()

	if !e.inText {
		// Look for "text":"  or  "text": " in accumulated buffer
		idx := strings.Index(s, `"text":"`)
		start := 0
		if idx >= 0 {
			start = idx + 8 // len(`"text":"`)
		} else {
			idx = strings.Index(s, `"text": "`)
			if idx >= 0 {
				start = idx + 9 // len(`"text": "`)
			}
		}
		if idx < 0 {
			return ""
		}
		e.inText = true
		e.emitted = start
	}

	// Extract text from emitted position, handling escape sequences
	var result strings.Builder
	i := e.emitted
	for i < len(s) {
		ch := s[i]
		if e.pendingEsc {
			e.pendingEsc = false
			switch ch {
			case '"':
				result.WriteByte('"')
			case '\\':
				result.WriteByte('\\')
			case 'n':
				result.WriteByte('\n')
			case 'r':
				result.WriteByte('\r')
			case 't':
				result.WriteByte('\t')
			case '/':
				result.WriteByte('/')
			default:
				result.WriteByte('\\')
				result.WriteByte(ch)
			}
			i++
			continue
		}
		if ch == '\\' {
			if i+1 >= len(s) {
				// Backslash at end of buffer — wait for next chunk
				e.pendingEsc = true
				i++
				continue
			}
			next := s[i+1]
			switch next {
			case '"':
				result.WriteByte('"')
			case '\\':
				result.WriteByte('\\')
			case 'n':
				result.WriteByte('\n')
			case 'r':
				result.WriteByte('\r')
			case 't':
				result.WriteByte('\t')
			case '/':
				result.WriteByte('/')
			default:
				result.WriteByte('\\')
				result.WriteByte(next)
			}
			i += 2
			continue
		}
		if ch == '"' {
			// End of string value — reset for next tool call
			e.buf.Reset()
			e.inText = false
			e.emitted = 0
			e.pendingEsc = false
			break
		}
		result.WriteByte(ch)
		i++
	}
	e.emitted = i

	return result.String()
}

// serverGet does an authenticated GET to the server API (/api/<path>).
func (c *coreClient) serverGet(path string) ([]byte, error) {
	req, _ := http.NewRequest("GET", c.apiBase()+path, nil)
	resp, err := c.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

// serverPost does an authenticated POST to the server API (/api/<path>).
func (c *coreClient) serverPost(path string, body []byte) ([]byte, error) {
	req, _ := http.NewRequest("POST", c.apiBase()+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

// serverDelete does an authenticated DELETE to the server API (/api/<path>).
func (c *coreClient) serverDelete(path string) error {
	req, _ := http.NewRequest("DELETE", c.apiBase()+path, nil)
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

// httpGet is a simple unauthenticated GET helper.
func httpGet(url string) ([]byte, error) {
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}
