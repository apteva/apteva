package main

import (
	"fmt"
	"sync"
)

// Channel is a communication endpoint (CLI terminal, Telegram chat, Discord channel, etc.)
type Channel interface {
	// ID returns the channel identifier, e.g. "cli", "telegram:12345"
	ID() string
	// Send delivers a message to this channel.
	Send(text string) error
	// Ask sends a question and blocks until the user replies.
	Ask(question string) (string, error)
	// Status sends a status/ephemeral message.
	Status(text, level string) error
	// Close shuts down this channel.
	Close()
}

// ChannelFactory creates a channel on demand for an unknown channel ID.
type ChannelFactory func(id string) Channel

// ChannelRegistry manages all active channels.
type ChannelRegistry struct {
	mu        sync.RWMutex
	channels  map[string]Channel
	factories []ChannelFactory
}

func NewChannelRegistry() *ChannelRegistry {
	return &ChannelRegistry{
		channels: make(map[string]Channel),
	}
}

// AddFactory registers a factory that can create channels on demand.
func (r *ChannelRegistry) AddFactory(f ChannelFactory) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.factories = append(r.factories, f)
}

func (r *ChannelRegistry) Register(ch Channel) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.channels[ch.ID()] = ch
}

func (r *ChannelRegistry) Unregister(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ch, ok := r.channels[id]; ok {
		ch.Close()
		delete(r.channels, id)
	}
}

func (r *ChannelRegistry) Get(id string) Channel {
	r.mu.RLock()
	ch, ok := r.channels[id]
	r.mu.RUnlock()
	if ok {
		return ch
	}
	// Try factories
	r.mu.Lock()
	defer r.mu.Unlock()
	// Double-check after lock upgrade
	if ch, ok := r.channels[id]; ok {
		return ch
	}
	for _, f := range r.factories {
		if ch := f(id); ch != nil {
			r.channels[id] = ch
			return ch
		}
	}
	return nil
}

// Find returns the first channel matching a prefix, e.g. "telegram" matches "telegram:12345".
func (r *ChannelRegistry) Find(prefix string) Channel {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for id, ch := range r.channels {
		if id == prefix {
			return ch
		}
	}
	// Prefix match
	for id, ch := range r.channels {
		if len(id) > len(prefix) && id[:len(prefix)+1] == prefix+":" {
			return ch
		}
	}
	return nil
}

func (r *ChannelRegistry) List() []Channel {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Channel, 0, len(r.channels))
	for _, ch := range r.channels {
		out = append(out, ch)
	}
	return out
}

func (r *ChannelRegistry) Send(channelID, text string) error {
	ch := r.Get(channelID)
	if ch == nil {
		return fmt.Errorf("channel %q not found", channelID)
	}
	return ch.Send(text)
}

func (r *ChannelRegistry) Ask(channelID, question string) (string, error) {
	ch := r.Get(channelID)
	if ch == nil {
		return "", fmt.Errorf("channel %q not found", channelID)
	}
	return ch.Ask(question)
}

func (r *ChannelRegistry) CloseAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, ch := range r.channels {
		ch.Close()
	}
	r.channels = make(map[string]Channel)
}
