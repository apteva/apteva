package main

import "github.com/apteva/apteva/internal/cli"

// Version is injected by release builds with -ldflags "-X main.Version=...".
var Version = "dev"

func main() {
	cli.Run(Version)
}
