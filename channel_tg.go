package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// TelegramGateway manages the Telegram bot connection and per-chat channels.
type TelegramGateway struct {
	token    string
	client   *http.Client
	registry *ChannelRegistry
	core     *coreClient
	botName  string

	mu       sync.RWMutex
	chats    map[string]*TelegramChannel // chat_id → channel
	stopCh   chan struct{}
	stopped  bool
}

func NewTelegramGateway(token string, registry *ChannelRegistry, core *coreClient) *TelegramGateway {
	return &TelegramGateway{
		token:    token,
		client:   &http.Client{Timeout: 10 * time.Second},
		registry: registry,
		core:     core,
		chats:    make(map[string]*TelegramChannel),
		stopCh:   make(chan struct{}),
	}
}

// Start begins polling and returns the bot username, or an error.
func (g *TelegramGateway) Start() (string, error) {
	// Verify token with getMe
	var me struct {
		OK     bool `json:"ok"`
		Result struct {
			Username string `json:"username"`
		} `json:"result"`
	}
	if err := g.apiCall("getMe", nil, &me); err != nil {
		return "", fmt.Errorf("invalid token: %w", err)
	}
	if !me.OK {
		return "", fmt.Errorf("telegram rejected the token")
	}
	g.botName = me.Result.Username

	// Switch to longer timeout for long-polling
	g.client.Timeout = 60 * time.Second

	go g.pollLoop()
	return g.botName, nil
}

func (g *TelegramGateway) Stop() {
	g.mu.Lock()
	if g.stopped {
		g.mu.Unlock()
		return
	}
	g.stopped = true
	close(g.stopCh)
	// Unregister all telegram channels
	for id, ch := range g.chats {
		ch.Close()
		g.registry.Unregister("telegram:" + id)
	}
	g.chats = make(map[string]*TelegramChannel)
	g.mu.Unlock()
}

func (g *TelegramGateway) BotName() string {
	return g.botName
}

// ChannelFactory returns a factory that creates Telegram channels on demand
// for any "telegram:<chat_id>" channel ID.
func (g *TelegramGateway) ChannelFactory() ChannelFactory {
	return func(id string) Channel {
		if !strings.HasPrefix(id, "telegram:") {
			return nil
		}
		chatID := strings.TrimPrefix(id, "telegram:")
		if chatID == "" {
			return nil
		}
		g.mu.Lock()
		defer g.mu.Unlock()
		if ch, ok := g.chats[chatID]; ok {
			return ch
		}
		ch := &TelegramChannel{
			chatID:  chatID,
			gateway: g,
			askWait: make(map[string]chan string),
		}
		g.chats[chatID] = ch
		return ch
	}
}

func (g *TelegramGateway) pollLoop() {
	offset := 0
	for {
		select {
		case <-g.stopCh:
			return
		default:
		}

		var updates struct {
			OK     bool `json:"ok"`
			Result []struct {
				UpdateID int `json:"update_id"`
				Message  *struct {
					MessageID int `json:"message_id"`
					Chat      struct {
						ID int64  `json:"id"`
					} `json:"chat"`
					From *struct {
						Username  string `json:"username"`
						FirstName string `json:"first_name"`
					} `json:"from"`
					Text string `json:"text"`
				} `json:"message"`
			} `json:"result"`
		}

		err := g.apiCall("getUpdates", map[string]any{
			"offset":  offset,
			"timeout": 30,
		}, &updates)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}

		for _, u := range updates.Result {
			offset = u.UpdateID + 1
			if u.Message == nil || u.Message.Text == "" {
				continue
			}

			chatID := fmt.Sprintf("%d", u.Message.Chat.ID)
			username := "unknown"
			if u.Message.From != nil {
				if u.Message.From.Username != "" {
					username = "@" + u.Message.From.Username
				} else {
					username = u.Message.From.FirstName
				}
			}

			// Ensure channel exists for this chat
			g.ensureChannel(chatID)

			// Forward to core
			event := fmt.Sprintf("[telegram:%s:%s] %s", username, chatID, u.Message.Text)
			g.core.sendEvent(event, "main")
		}
	}
}

func (g *TelegramGateway) ensureChannel(chatID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if _, ok := g.chats[chatID]; ok {
		return
	}
	ch := &TelegramChannel{
		chatID:  chatID,
		gateway: g,
		askWait: make(map[string]chan string),
	}
	g.chats[chatID] = ch
	g.registry.Register(ch)
}

func (g *TelegramGateway) apiCall(method string, params map[string]any, result any) error {
	url := fmt.Sprintf("https://api.telegram.org/bot%s/%s", g.token, method)

	var body io.Reader
	if params != nil {
		data, _ := json.Marshal(params)
		body = bytes.NewReader(data)
	}

	req, _ := http.NewRequest("POST", url, body)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := g.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if result != nil {
		return json.NewDecoder(resp.Body).Decode(result)
	}
	return nil
}

func (g *TelegramGateway) sendMessage(chatID, text string) error {
	// Telegram max message length is 4096
	for len(text) > 0 {
		chunk := text
		if len(chunk) > 4000 {
			// Break at last newline before 4000
			idx := strings.LastIndex(chunk[:4000], "\n")
			if idx < 0 {
				idx = 4000
			}
			chunk = text[:idx]
			text = text[idx:]
		} else {
			text = ""
		}

		var resp struct {
			OK bool `json:"ok"`
		}
		err := g.apiCall("sendMessage", map[string]any{
			"chat_id":    chatID,
			"text":       chunk,
			"parse_mode": "Markdown",
		}, &resp)
		if err != nil {
			return err
		}
	}
	return nil
}

// TelegramChannel implements Channel for a single Telegram chat.
type TelegramChannel struct {
	chatID  string
	gateway *TelegramGateway

	mu      sync.Mutex
	askWait map[string]chan string // pending ask replies
}

func (c *TelegramChannel) ID() string {
	return "telegram:" + c.chatID
}

func (c *TelegramChannel) Send(text string) error {
	return c.gateway.sendMessage(c.chatID, text)
}

func (c *TelegramChannel) Ask(question string) (string, error) {
	// Send the question
	if err := c.gateway.sendMessage(c.chatID, question); err != nil {
		return "", err
	}
	// Wait for the next message from this chat (timeout 5 min)
	replyCh := make(chan string, 1)
	c.mu.Lock()
	c.askWait[c.chatID] = replyCh
	c.mu.Unlock()

	defer func() {
		c.mu.Lock()
		delete(c.askWait, c.chatID)
		c.mu.Unlock()
	}()

	select {
	case reply := <-replyCh:
		return reply, nil
	case <-time.After(5 * time.Minute):
		return "", fmt.Errorf("ask timeout")
	}
}

func (c *TelegramChannel) Status(text, level string) error {
	prefix := ""
	switch level {
	case "warn":
		prefix = "⚠️ "
	case "alert":
		prefix = "🚨 "
	}
	return c.gateway.sendMessage(c.chatID, prefix+text)
}

func (c *TelegramChannel) Close() {
	// Nothing to close per-chat
}
