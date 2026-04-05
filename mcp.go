package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

// mcpServer is a minimal MCP HTTP server exposing unified channel tools for the core.
type mcpServer struct {
	port     int
	listener net.Listener
	registry *ChannelRegistry

	mu     sync.Mutex
	closed bool
}

type statusUpdate struct {
	Line  string
	Level string // "info", "warn", "alert"
}

func newMCPServer(registry *ChannelRegistry) (*mcpServer, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &mcpServer{
		port:     ln.Addr().(*net.TCPAddr).Port,
		listener: ln,
		registry: registry,
	}
	return s, nil
}

func (s *mcpServer) url() string {
	return fmt.Sprintf("http://127.0.0.1:%d", s.port)
}

func (s *mcpServer) serve() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handle)
	http.Serve(s.listener, mux)
}

func (s *mcpServer) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.closed = true
		s.listener.Close()
	}
}

type rpcRequest struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Method  string           `json:"method"`
	Params  json.RawMessage  `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Result  any              `json:"result,omitempty"`
	Error   *rpcError        `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (s *mcpServer) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}

	var req rpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid JSON-RPC", http.StatusBadRequest)
		return
	}

	// Notifications (no ID) — just ack
	if req.ID == nil {
		w.WriteHeader(http.StatusAccepted)
		return
	}

	var result any
	var rpcErr *rpcError

	switch req.Method {
	case "initialize":
		result = map[string]any{
			"protocolVersion": "2025-03-26",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo": map[string]string{
				"name":    "apteva-channels",
				"version": "1.0.0",
			},
		}

	case "tools/list":
		result = s.toolsList()

	case "tools/call":
		result, rpcErr = s.handleToolCall(req.Params)

	default:
		rpcErr = &rpcError{Code: -32601, Message: "method not found"}
	}

	resp := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	if rpcErr != nil {
		resp.Error = rpcErr
	} else {
		resp.Result = result
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *mcpServer) toolsList() map[string]any {
	// Build channel list for descriptions
	var channelIDs []string
	for _, ch := range s.registry.List() {
		channelIDs = append(channelIDs, ch.ID())
	}
	channelList := strings.Join(channelIDs, ", ")
	if channelList == "" {
		channelList = "cli"
	}

	return map[string]any{
		"tools": []map[string]any{
			{
				"name": "respond",
				"description": fmt.Sprintf(
					"CRITICAL: Send a message to a user on a channel. Every message from a user on ANY channel MUST receive a response via this tool. "+
						"Never ignore user messages. When a user asks you to do something, FIRST respond acknowledging what you will do, THEN do it, THEN follow up with the result. "+
						"When a user connects, always greet them immediately. "+
						"Connected channels: [%s]. "+
						"Match the channel from the event prefix: [cli] → channel=\"cli\", [telegram:@john:12345] → channel=\"telegram:12345\".",
					channelList,
				),
				"inputSchema": map[string]any{
					"type":     "object",
					"required": []string{"text", "channel"},
					"properties": map[string]any{
						"text": map[string]any{
							"type":        "string",
							"description": "The message to send",
						},
						"channel": map[string]any{
							"type":        "string",
							"description": "Target channel ID, e.g. \"cli\", \"telegram:12345\"",
						},
					},
				},
			},
			{
				"name": "ask",
				"description": fmt.Sprintf(
					"Ask a user a question on a specific channel and wait for their reply. Blocks until they respond. "+
						"Connected channels: [%s].",
					channelList,
				),
				"inputSchema": map[string]any{
					"type":     "object",
					"required": []string{"question", "channel"},
					"properties": map[string]any{
						"question": map[string]any{
							"type":        "string",
							"description": "The question to ask",
						},
						"channel": map[string]any{
							"type":        "string",
							"description": "Target channel ID",
						},
					},
				},
			},
			{
				"name": "status",
				"description": "Send a status update to a specific channel.",
				"inputSchema": map[string]any{
					"type":     "object",
					"required": []string{"line", "channel"},
					"properties": map[string]any{
						"line": map[string]any{
							"type":        "string",
							"description": "Status text",
						},
						"channel": map[string]any{
							"type":        "string",
							"description": "Target channel ID",
						},
						"level": map[string]any{
							"type":        "string",
							"description": "Severity: info, warn, or alert",
							"enum":        []string{"info", "warn", "alert"},
						},
					},
				},
			},
			{
				"name":        "list_channels",
				"description": "List all currently connected communication channels.",
				"inputSchema": map[string]any{
					"type":       "object",
					"properties": map[string]any{},
				},
			},
		},
	}
}

func (s *mcpServer) handleToolCall(params json.RawMessage) (any, *rpcError) {
	var call struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(params, &call); err != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid params"}
	}

	textResult := func(text string) any {
		return map[string]any{
			"content": []map[string]string{{"type": "text", "text": text}},
		}
	}

	switch call.Name {
	case "respond":
		text, _ := call.Arguments["text"].(string)
		channel, _ := call.Arguments["channel"].(string)
		if text == "" {
			return nil, &rpcError{Code: -32602, Message: "text required"}
		}
		if channel == "" {
			channel = "cli" // default
		}
		if err := s.registry.Send(channel, text); err != nil {
			return nil, &rpcError{Code: -32602, Message: err.Error()}
		}
		return textResult("delivered to " + channel), nil

	case "ask":
		question, _ := call.Arguments["question"].(string)
		channel, _ := call.Arguments["channel"].(string)
		if question == "" {
			return nil, &rpcError{Code: -32602, Message: "question required"}
		}
		if channel == "" {
			channel = "cli"
		}
		answer, err := s.registry.Ask(channel, question)
		if err != nil {
			return nil, &rpcError{Code: -32602, Message: err.Error()}
		}
		return textResult(answer), nil

	case "status":
		line, _ := call.Arguments["line"].(string)
		channel, _ := call.Arguments["channel"].(string)
		level, _ := call.Arguments["level"].(string)
		if channel == "" {
			channel = "cli"
		}
		if level == "" {
			level = "info"
		}
		ch := s.registry.Get(channel)
		if ch == nil {
			return nil, &rpcError{Code: -32602, Message: fmt.Sprintf("channel %q not found", channel)}
		}
		ch.Status(line, level)
		return textResult("ok"), nil

	case "list_channels":
		var ids []string
		for _, ch := range s.registry.List() {
			ids = append(ids, ch.ID())
		}
		return textResult(fmt.Sprintf("Connected channels: %s", strings.Join(ids, ", "))), nil

	default:
		return nil, &rpcError{Code: -32602, Message: fmt.Sprintf("unknown tool: %s", call.Name)}
	}
}
