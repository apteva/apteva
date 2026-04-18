package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// instance_picker is the first TUI the user sees on launch. It lists
// every instance the CLI's user owns, lets them pick one with arrow
// keys + Enter, and also supports inline create/delete plus project
// switching (when the projects capability is enabled). Replaces the
// old behavior where the CLI blindly auto-started whatever instanceID
// was saved in apteva.json — which silently failed (404, stale rows)
// and left the user staring at a blank terminal while waitForHealth
// timed out.
//
// Keys:
//   ↑/↓ j/k   move
//   home/g    top
//   end/G     bottom
//   enter     select
//   c         create new (inline: name + directive)
//   d         delete selected (y/N confirmation)
//   p         switch project (only when Capabilities.Projects)
//   n         full setup wizard (legacy — keeps old flag)
//   esc/q     cancel

type pickerItem struct {
	id        int64
	name      string
	projectID string
	status    string
	directive string
}

type pickerProject struct {
	id   string
	name string
}

type pickerMode int

const (
	modeList pickerMode = iota
	modeDeleteConfirm
	modeCreateName
	modeCreateDirective
	modeProjectList
	modeError
)

type pickerModel struct {
	th     theme
	client *coreClient

	// capabilities + current project scope
	projectsEnabled bool
	projectID       string // "" = all projects

	// data
	allItems []pickerItem // unfiltered
	items    []pickerItem // filtered by projectID
	projects []pickerProject

	// view state
	mode          pickerMode
	cursor        int
	projectCursor int
	err           string

	// inline create inputs
	nameInput      textinput.Model
	directiveInput textinput.Model

	// results (consumed by caller)
	selected *pickerItem
	cancel   bool
	newInst  bool // legacy full-setup flag

	// last-known width/height
	width  int
	height int
}

func newPickerModel(th theme, client *coreClient, projectsEnabled bool, projectID string, items []pickerItem, projects []pickerProject, preselectID int64) pickerModel {
	ni := textinput.New()
	ni.CharLimit = 60
	ni.Prompt = ""
	ni.Placeholder = "my-agent"

	di := textinput.New()
	di.CharLimit = 400
	di.Prompt = ""
	di.Placeholder = "what should this agent do?"

	m := pickerModel{
		th:              th,
		client:          client,
		projectsEnabled: projectsEnabled,
		projectID:       projectID,
		allItems:        items,
		projects:        projects,
		nameInput:       ni,
		directiveInput:  di,
	}
	m.applyFilter()
	for i, it := range m.items {
		if it.id == preselectID {
			m.cursor = i
			break
		}
	}
	return m
}

func (m *pickerModel) applyFilter() {
	if m.projectID == "" {
		m.items = append([]pickerItem(nil), m.allItems...)
	} else {
		m.items = m.items[:0]
		for _, it := range m.allItems {
			if it.projectID == m.projectID {
				m.items = append(m.items, it)
			}
		}
	}
	if m.cursor >= len(m.items) {
		m.cursor = len(m.items) - 1
	}
	if m.cursor < 0 {
		m.cursor = 0
	}
}

func (m pickerModel) Init() tea.Cmd { return textinput.Blink }

func (m pickerModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case tea.KeyMsg:
		switch m.mode {
		case modeList:
			return m.updateList(msg)
		case modeDeleteConfirm:
			return m.updateDeleteConfirm(msg)
		case modeCreateName:
			return m.updateCreateName(msg)
		case modeCreateDirective:
			return m.updateCreateDirective(msg)
		case modeProjectList:
			return m.updateProjectList(msg)
		case modeError:
			m.mode = modeList
			m.err = ""
			return m, nil
		}
	}
	// Pass through to whatever input is active.
	var cmd tea.Cmd
	switch m.mode {
	case modeCreateName:
		m.nameInput, cmd = m.nameInput.Update(msg)
	case modeCreateDirective:
		m.directiveInput, cmd = m.directiveInput.Update(msg)
	}
	return m, cmd
}

func (m pickerModel) updateList(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c", "esc", "q":
		m.cancel = true
		return m, tea.Quit
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.items)-1 {
			m.cursor++
		}
	case "home", "g":
		m.cursor = 0
	case "end", "G":
		m.cursor = len(m.items) - 1
	case "enter":
		if len(m.items) > 0 {
			it := m.items[m.cursor]
			m.selected = &it
			return m, tea.Quit
		}
		// empty list → create
		m.mode = modeCreateName
		m.nameInput.SetValue("")
		m.nameInput.Focus()
	case "c", "C":
		m.mode = modeCreateName
		m.nameInput.SetValue("")
		m.nameInput.Focus()
	case "d", "D":
		if len(m.items) > 0 {
			m.mode = modeDeleteConfirm
		}
	case "p", "P":
		if m.projectsEnabled {
			m.projectCursor = 0
			for i, p := range m.projects {
				if p.id == m.projectID {
					m.projectCursor = i + 1 // +1 for the "All projects" row
					break
				}
			}
			m.mode = modeProjectList
		}
	case "n", "N":
		// Legacy: full setup wizard.
		m.newInst = true
		return m, tea.Quit
	}
	return m, nil
}

func (m pickerModel) updateDeleteConfirm(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		if len(m.items) == 0 {
			m.mode = modeList
			return m, nil
		}
		it := m.items[m.cursor]
		if err := deleteInstance(m.client, it.id); err != nil {
			m.err = fmt.Sprintf("delete failed: %v", err)
			m.mode = modeError
			return m, nil
		}
		// Remove from both allItems and items.
		m.allItems = removeByID(m.allItems, it.id)
		m.applyFilter()
		m.mode = modeList
	case "n", "N", "esc":
		m.mode = modeList
	}
	return m, nil
}

func (m pickerModel) updateCreateName(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.mode = modeList
		return m, nil
	case "enter":
		if strings.TrimSpace(m.nameInput.Value()) == "" {
			return m, nil
		}
		m.mode = modeCreateDirective
		m.directiveInput.SetValue("")
		m.directiveInput.Focus()
		m.nameInput.Blur()
		return m, nil
	}
	var cmd tea.Cmd
	m.nameInput, cmd = m.nameInput.Update(msg)
	return m, cmd
}

func (m pickerModel) updateCreateDirective(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.mode = modeCreateName
		m.nameInput.Focus()
		return m, nil
	case "enter":
		name := strings.TrimSpace(m.nameInput.Value())
		directive := strings.TrimSpace(m.directiveInput.Value())
		if directive == "" {
			directive = "Idle. Waiting for directive."
		}
		created, err := createInstance(m.client, name, directive, m.projectID)
		if err != nil {
			m.err = fmt.Sprintf("create failed: %v", err)
			m.mode = modeError
			return m, nil
		}
		m.allItems = append(m.allItems, created)
		m.applyFilter()
		// Move cursor to the new instance.
		for i, it := range m.items {
			if it.id == created.id {
				m.cursor = i
				break
			}
		}
		m.mode = modeList
		m.directiveInput.Blur()
		return m, nil
	}
	var cmd tea.Cmd
	m.directiveInput, cmd = m.directiveInput.Update(msg)
	return m, cmd
}

func (m pickerModel) updateProjectList(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// project list has len(projects)+1 rows (first row = "All projects")
	total := len(m.projects) + 1
	switch msg.String() {
	case "esc", "q":
		m.mode = modeList
	case "up", "k":
		if m.projectCursor > 0 {
			m.projectCursor--
		}
	case "down", "j":
		if m.projectCursor < total-1 {
			m.projectCursor++
		}
	case "enter":
		if m.projectCursor == 0 {
			m.projectID = ""
		} else {
			m.projectID = m.projects[m.projectCursor-1].id
		}
		m.applyFilter()
		m.cursor = 0
		m.mode = modeList
	}
	return m, nil
}

// View renders the picker as a centered APTEVA-branded box, matching
// the setup wizard's look (orange palette, ┌─ title ─┐ border, centered
// on screen). All modes render into the same box so the frame stays
// stable as the user navigates between list / create / delete / project.
func (m pickerModel) View() string {
	if m.width == 0 {
		return ""
	}

	primary := lipgloss.NewStyle().Foreground(m.th.Primary)
	dim := lipgloss.NewStyle().Foreground(m.th.Dim)
	accent := lipgloss.NewStyle().Foreground(m.th.Accent)
	selected := lipgloss.NewStyle().Foreground(m.th.Accent).Bold(true)

	boxW := m.width * 70 / 100
	if boxW < 60 {
		boxW = m.width - 4
	}
	if boxW < 40 {
		boxW = 40
	}
	innerW := boxW - 4

	var title string
	var lines []string

	switch m.mode {
	case modeList:
		title = "SELECT INSTANCE"
		lines = m.linesList(innerW, primary, dim, accent, selected)
	case modeDeleteConfirm:
		title = "DELETE INSTANCE"
		lines = m.linesDeleteConfirm(primary, dim)
	case modeCreateName:
		title = "NEW INSTANCE"
		lines = append(lines, "")
		lines = append(lines, dim.Render("  Name for the new agent:"))
		lines = append(lines, "")
		lines = append(lines, "  "+accent.Render("Name: ")+m.nameInput.View())
		lines = append(lines, "")
		lines = append(lines, dim.Render("  enter to continue · esc to cancel"))
	case modeCreateDirective:
		title = "NEW INSTANCE"
		lines = append(lines, "")
		lines = append(lines, dim.Render("  What should this agent do?"))
		lines = append(lines, "")
		lines = append(lines, "  "+accent.Render("Directive: ")+m.directiveInput.View())
		lines = append(lines, "")
		lines = append(lines, dim.Render("  enter to create · esc to go back"))
	case modeProjectList:
		title = "SELECT PROJECT"
		lines = m.linesProjectList(primary, dim, accent, selected)
	case modeError:
		title = "ERROR"
		lines = append(lines, "")
		lines = append(lines, primary.Render("  "+m.err))
		lines = append(lines, "")
		lines = append(lines, dim.Render("  press any key to continue"))
	}

	// Render centered box — same recipe as the setup wizard.
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
	// Minimum height so the frame doesn't jitter between modes.
	for len(contentLines) < 14 {
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
	if m.height <= 0 {
		return strings.Join(out, "\n")
	}
	return strings.Join(out[:m.height], "\n")
}

func (m pickerModel) linesList(innerW int, primary, dim, accent, selected lipgloss.Style) []string {
	var lines []string
	lines = append(lines, "")

	// Scope indicator (which project we're filtered to).
	if m.projectsEnabled {
		label := "all projects"
		if m.projectID != "" {
			label = m.projectID
			for _, p := range m.projects {
				if p.id == m.projectID && p.name != "" {
					label = p.name
					break
				}
			}
		}
		lines = append(lines, dim.Render("  project: ")+primary.Render(label))
		lines = append(lines, "")
	}

	if len(m.items) == 0 {
		lines = append(lines, dim.Render("  (no instances yet — press c to create one)"))
		lines = append(lines, "")
	} else {
		// Sort by project then name, but keep a mapping back to the
		// original index so cursor highlighting stays consistent with
		// keyboard navigation order.
		sorted := append([]pickerItem(nil), m.items...)
		sort.SliceStable(sorted, func(i, j int) bool {
			if sorted[i].projectID != sorted[j].projectID {
				return sorted[i].projectID < sorted[j].projectID
			}
			return sorted[i].name < sorted[j].name
		})
		positionOf := map[int64]int{}
		for i, it := range m.items {
			positionOf[it.id] = i
		}
		var currentProject string
		firstProject := true
		for _, it := range sorted {
			if m.projectID == "" && it.projectID != currentProject {
				currentProject = it.projectID
				label := currentProject
				if label == "" {
					label = "(no project)"
				} else if len(label) > 36 {
					label = label[:36] + "…"
				}
				if !firstProject {
					lines = append(lines, "")
				}
				lines = append(lines, dim.Render("  "+label))
				firstProject = false
			}
			pos := positionOf[it.id]
			prefix := "    "
			nameStyle := primary
			if pos == m.cursor {
				prefix = "  " + accent.Render("▶ ")
				nameStyle = selected
			}
			var dot string
			switch it.status {
			case "running":
				dot = lipgloss.NewStyle().Foreground(lipgloss.Color("#4ade80")).Render("●")
			default:
				dot = dim.Render("○")
			}
			name := nameStyle.Render(fmt.Sprintf("%-20s", truncate(it.name, 20)))
			dirText := strings.TrimSpace(it.directive)
			if dirText == "" {
				dirText = "(no directive)"
			}
			lines = append(lines, prefix+dot+" "+name+"  "+dim.Render(truncate(dirText, max(10, innerW-30))))
		}
	}

	lines = append(lines, "")
	hintKeys := "↑↓ move · enter select · c create · d delete"
	if m.projectsEnabled {
		hintKeys += " · p project"
	}
	hintKeys += " · esc quit"
	lines = append(lines, dim.Render("  "+hintKeys))
	return lines
}

func (m pickerModel) linesDeleteConfirm(primary, dim lipgloss.Style) []string {
	var lines []string
	if len(m.items) == 0 {
		return lines
	}
	it := m.items[m.cursor]
	lines = append(lines, "")
	lines = append(lines, primary.Render(fmt.Sprintf("  Delete %q (id=%d)?", it.name, it.id)))
	lines = append(lines, "")
	lines = append(lines, dim.Render("  This cannot be undone."))
	lines = append(lines, "")
	lines = append(lines, dim.Render("  y to confirm · n / esc to cancel"))
	return lines
}

func (m pickerModel) linesProjectList(primary, dim, accent, selected lipgloss.Style) []string {
	var lines []string
	lines = append(lines, "")
	lines = append(lines, dim.Render("  Filter instances by project:"))
	lines = append(lines, "")
	render := func(i int, label string) string {
		if i == m.projectCursor {
			return "  " + accent.Render("▶ ") + selected.Render(label)
		}
		return "    " + primary.Render(label)
	}
	lines = append(lines, render(0, "(all projects)"))
	for i, p := range m.projects {
		label := p.name
		if label == "" {
			label = p.id
		}
		lines = append(lines, render(i+1, label))
	}
	lines = append(lines, "")
	lines = append(lines, dim.Render("  ↑↓ move · enter select · esc back"))
	return lines
}

// truncate cuts a string to n runes with an ellipsis if too long.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

func removeByID(items []pickerItem, id int64) []pickerItem {
	out := items[:0]
	for _, it := range items {
		if it.id != id {
			out = append(out, it)
		}
	}
	return append([]pickerItem(nil), out...)
}

// runInstancePicker fetches instances from the server and shows the
// picker. Returns the selected instance, a sentinel newInst==true if
// the user asked to run the full setup wizard, or cancel==true if
// they quit. The picker may mutate server-side state (create/delete
// instances) before returning.
func runInstancePicker(th theme, client *coreClient, cfg *AptevaConfig) (selected *pickerItem, newInst, cancel bool, err error) {
	items, err := listInstances(client)
	if err != nil {
		return nil, false, false, err
	}

	var projects []pickerProject
	if cfg.Capabilities.Projects {
		projects, _ = listProjects(client) // best-effort; picker still works without
	}

	preselect := cfg.InstanceID
	valid := false
	for _, it := range items {
		if it.id == cfg.InstanceID {
			valid = true
			break
		}
	}
	if !valid {
		preselect = 0
		for _, it := range items {
			if it.status == "running" {
				preselect = it.id
				break
			}
		}
		if preselect == 0 && len(items) > 0 {
			preselect = items[0].id
		}
	}

	m := newPickerModel(th, client, cfg.Capabilities.Projects, cfg.ProjectID, items, projects, preselect)
	p := tea.NewProgram(m, tea.WithAltScreen())
	finalModel, err := p.Run()
	if err != nil {
		return nil, false, false, err
	}
	fm := finalModel.(pickerModel)

	// Persist project scope if it changed.
	if fm.projectID != cfg.ProjectID {
		cfg.ProjectID = fm.projectID
		_ = saveAptevaConfig(*cfg)
	}
	return fm.selected, fm.newInst, fm.cancel, nil
}

// listInstances hits GET /api/instances. Scoped to the caller (user
// derived from the API key); the server returns only instances owned
// by that user so the list is already correctly filtered.
func listInstances(client *coreClient) ([]pickerItem, error) {
	req, _ := http.NewRequest("GET", client.apiBase()+"/instances", nil)
	resp, err := client.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("list instances: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var rows []struct {
		ID        int64  `json:"id"`
		Name      string `json:"name"`
		ProjectID string `json:"project_id"`
		Status    string `json:"status"`
		Directive string `json:"directive"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rows); err != nil {
		return nil, err
	}
	out := make([]pickerItem, 0, len(rows))
	for _, r := range rows {
		out = append(out, pickerItem{
			id:        r.ID,
			name:      r.Name,
			projectID: r.ProjectID,
			status:    r.Status,
			directive: r.Directive,
		})
	}
	return out, nil
}

func listProjects(client *coreClient) ([]pickerProject, error) {
	req, _ := http.NewRequest("GET", client.apiBase()+"/projects", nil)
	resp, err := client.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("list projects: HTTP %d", resp.StatusCode)
	}
	var rows []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rows); err != nil {
		return nil, err
	}
	out := make([]pickerProject, 0, len(rows))
	for _, r := range rows {
		out = append(out, pickerProject{id: r.ID, name: r.Name})
	}
	return out, nil
}

func deleteInstance(client *coreClient, id int64) error {
	req, _ := http.NewRequest("DELETE", fmt.Sprintf("%s/instances/%d", client.apiBase(), id), nil)
	resp, err := client.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

func createInstance(client *coreClient, name, directive, projectID string) (pickerItem, error) {
	body, _ := json.Marshal(map[string]any{
		"name":       name,
		"directive":  directive,
		"mode":       "autonomous",
		"project_id": projectID,
	})
	req, _ := http.NewRequest("POST", client.apiBase()+"/instances", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.do(req)
	if err != nil {
		return pickerItem{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(resp.Body)
		return pickerItem{}, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var r struct {
		ID        int64  `json:"id"`
		Name      string `json:"name"`
		ProjectID string `json:"project_id"`
		Status    string `json:"status"`
		Directive string `json:"directive"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return pickerItem{}, err
	}
	if r.Status == "" {
		r.Status = "running"
	}
	return pickerItem{
		id:        r.ID,
		name:      r.Name,
		projectID: r.ProjectID,
		status:    r.Status,
		directive: r.Directive,
	}, nil
}

// persistInstanceID persists the newly-selected instance id into
// apteva.json so subsequent launches default to it. Best-effort —
// logging a warn on failure rather than blocking the CLI.
func persistInstanceID(cfg *AptevaConfig, id int64) {
	cfg.InstanceID = id
	if err := saveAptevaConfig(*cfg); err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not save instance id to apteva.json: %v\n", err)
	}
}
