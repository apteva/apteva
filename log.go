package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	cliLogFile  *os.File
	cliLogMu    sync.Mutex
)

func initCLILog() {
	path := filepath.Join(aptevaDir(), "cli.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return
	}
	// Truncate if too large
	if info, _ := f.Stat(); info != nil && info.Size() > 5*1024*1024 {
		f.Truncate(0)
		f.Seek(0, 0)
	}
	cliLogFile = f
	cliLog("CLI", "--- session start ---")
}

func cliLog(category, msg string) {
	cliLogMu.Lock()
	defer cliLogMu.Unlock()
	ts := time.Now().Format("15:04:05.000")
	line := fmt.Sprintf("%s [%s] %s\n", ts, category, msg)
	if cliLogFile != nil {
		fmt.Fprint(cliLogFile, line)
	}
}
