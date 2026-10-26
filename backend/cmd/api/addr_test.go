package main

import "testing"

// A managed host routes to the port it injects. Ignoring PORT means the process
// binds somewhere no request arrives, and the only symptom is a health check
// that never turns green.
func TestListenAddrHonoursThePlatformPort(t *testing.T) {
	got, err := listenAddr("", "10000")
	if err != nil {
		t.Fatalf("listenAddr(\"\", \"10000\") returned %v, want no error", err)
	}
	if got != ":10000" {
		t.Fatalf("listenAddr(\"\", \"10000\") = %q, want %q", got, ":10000")
	}
}

// ADDR is the local and docker-compose switch and must keep winning, otherwise
// every existing runbook that sets it changes behaviour.
func TestListenAddrPrefersAddrWhenBothAreSet(t *testing.T) {
	got, err := listenAddr("127.0.0.1:8081", "10000")
	if err != nil {
		t.Fatalf("listenAddr returned %v, want no error", err)
	}
	if got != "127.0.0.1:8081" {
		t.Fatalf("listenAddr = %q, want %q", got, "127.0.0.1:8081")
	}
}

func TestListenAddrFallsBackToTheBuiltInDefault(t *testing.T) {
	got, err := listenAddr("", "")
	if err != nil {
		t.Fatalf("listenAddr returned %v, want no error", err)
	}
	if got != defaultAddr {
		t.Fatalf("listenAddr = %q, want %q", got, defaultAddr)
	}
}

// A bad PORT has to fail the start. Listening on ":0" or on a truncated port
// would leave a deploy that reports healthy nowhere.
func TestListenAddrRejectsAMalformedPlatformPort(t *testing.T) {
	for _, port := range []string{"http", "0", "-1", "65536", "8080 ", "0.5"} {
		t.Run(port, func(t *testing.T) {
			got, err := listenAddr("", port)
			if err == nil {
				t.Fatalf("listenAddr(\"\", %q) = %q, want an error", port, got)
			}
			if got != "" {
				t.Fatalf("listenAddr returned %q with an error, want an empty address", got)
			}
		})
	}
}
