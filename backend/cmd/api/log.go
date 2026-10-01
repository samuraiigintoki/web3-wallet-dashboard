package main

import (
	"fmt"
	"io"
	"log/slog"
	"strings"
)

func newLogger(output io.Writer, configuredLevel string) (*slog.Logger, error) {
	level, err := parseLogLevel(configuredLevel)
	if err != nil {
		return nil, err
	}

	handler := slog.NewJSONHandler(output, &slog.HandlerOptions{Level: level})
	return slog.New(handler), nil
}

func parseLogLevel(configuredLevel string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(configuredLevel)) {
	case "", "info":
		return slog.LevelInfo, nil
	case "debug":
		return slog.LevelDebug, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("invalid LOG_LEVEL %q: expected debug, info, warn, or error", configuredLevel)
	}
}
