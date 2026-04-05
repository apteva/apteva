package main

// CLIChannel implements Channel for the local terminal TUI.
type CLIChannel struct {
	respond  chan string
	askCh    chan string
	askReply chan string
	statusCh chan statusUpdate
}

func NewCLIChannel(respond chan string, askCh, askReply chan string, statusCh chan statusUpdate) *CLIChannel {
	return &CLIChannel{
		respond:  respond,
		askCh:    askCh,
		askReply: askReply,
		statusCh: statusCh,
	}
}

func (c *CLIChannel) ID() string { return "cli" }

func (c *CLIChannel) Send(text string) error {
	c.respond <- text
	return nil
}

func (c *CLIChannel) Ask(question string) (string, error) {
	c.askCh <- question
	answer := <-c.askReply
	return answer, nil
}

func (c *CLIChannel) Status(text, level string) error {
	c.statusCh <- statusUpdate{Line: text, Level: level}
	return nil
}

func (c *CLIChannel) Close() {
	// CLI channel lives as long as the process — nothing to close
}
