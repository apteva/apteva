package main

import "github.com/charmbracelet/lipgloss"

type theme struct {
	Name      string
	Primary   lipgloss.Color // main text, agent output
	Dim       lipgloss.Color // secondary info, separators
	Accent    lipgloss.Color // highlights, status
	Faded     lipgloss.Color // user input text (softer than primary)
	Warn      lipgloss.Color // warnings
	Alert     lipgloss.Color // errors, alerts
	BG        lipgloss.Color // background (empty = terminal default)
	InputMark lipgloss.Color // the > prompt
}

var themes = map[string]theme{
	"orange": {
		Name:      "orange",
		Primary:   lipgloss.Color("208"), // orange
		Dim:       lipgloss.Color("94"),  // dark orange/brown
		Accent:    lipgloss.Color("214"), // bright orange
		Faded:     lipgloss.Color("172"), // muted/faded orange for user input
		Warn:      lipgloss.Color("220"), // yellow
		Alert:     lipgloss.Color("196"), // red
		InputMark: lipgloss.Color("208"),
	},
	"amber": {
		Name:      "amber",
		Primary:   lipgloss.Color("214"),
		Dim:       lipgloss.Color("136"),
		Accent:    lipgloss.Color("220"),
		Faded:     lipgloss.Color("178"),
		Warn:      lipgloss.Color("220"),
		Alert:     lipgloss.Color("196"),
		InputMark: lipgloss.Color("214"),
	},
	"white": {
		Name:      "white",
		Primary:   lipgloss.Color("252"),
		Dim:       lipgloss.Color("241"),
		Accent:    lipgloss.Color("255"),
		Faded:     lipgloss.Color("245"),
		Warn:      lipgloss.Color("220"),
		Alert:     lipgloss.Color("196"),
		InputMark: lipgloss.Color("252"),
	},
}
