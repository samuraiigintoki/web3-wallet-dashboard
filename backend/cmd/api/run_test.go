package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestServe(t *testing.T) {
	tests := []struct {
		name string
		run  func(*testing.T)
	}{
		{name: "drain_holds", run: testServeDrainHolds},
		{name: "grace_expires", run: testServeGraceExpires},
		{name: "idle_server", run: testServeIdleServer},
		{name: "closed_listener_error_not_swallowed", run: testServeClosedListenerError},
	}

	for _, test := range tests {
		t.Run(test.name, test.run)
	}
}

func testServeDrainHolds(t *testing.T) {
	handlerStarted := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(handlerStarted)
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	})
	server := startTestServer(t, handler, 2*time.Second)
	defer server.cleanup()

	type response struct {
		status int
		err    error
	}
	responseReady := make(chan response, 1)
	client := &http.Client{Timeout: 2 * time.Second}
	started := time.Now()
	go func() {
		resp, err := client.Get("http://" + server.addr)
		if err != nil {
			responseReady <- response{err: err}
			return
		}
		defer resp.Body.Close()
		responseReady <- response{status: resp.StatusCode}
	}()

	select {
	case <-handlerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not start")
	}

	cancelTimer := time.AfterFunc(50*time.Millisecond, server.cancel)
	defer cancelTimer.Stop()

	if err := <-server.result; err != nil {
		t.Fatalf("serve returned error during clean drain: %v", err)
	}
	if elapsed := time.Since(started); elapsed < 300*time.Millisecond {
		t.Fatalf("serve returned before the in-flight request completed: %s", elapsed)
	}

	select {
	case got := <-responseReady:
		if got.err != nil {
			t.Fatalf("client request failed during drain: %v", got.err)
		}
		if got.status != http.StatusOK {
			t.Fatalf("status = %d, want %d", got.status, http.StatusOK)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("client did not receive the drained response")
	}
}

func testServeGraceExpires(t *testing.T) {
	handlerStarted := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(handlerStarted)
		time.Sleep(5 * time.Second)
		w.WriteHeader(http.StatusOK)
	})
	server := startTestServer(t, handler, 100*time.Millisecond)
	defer server.cleanup()

	clientDone := make(chan struct{}, 1)
	go func() {
		resp, err := http.Get("http://" + server.addr)
		if err == nil {
			resp.Body.Close()
		}
		clientDone <- struct{}{}
	}()

	select {
	case <-handlerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not start")
	}

	started := time.Now()
	server.cancel()
	err := <-server.result
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("serve returned nil after the grace period expired")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("serve error = %v, want errors.Is(context.DeadlineExceeded)", err)
	}
	if elapsed >= 2*time.Second {
		t.Fatalf("forced close took %s, want under 2s", elapsed)
	}

	select {
	case <-clientDone:
	case <-time.After(2 * time.Second):
		t.Fatal("client did not observe the forced close")
	}
}

func testServeIdleServer(t *testing.T) {
	server := startTestServer(t, http.NotFoundHandler(), 2*time.Second)
	defer server.cleanup()

	started := time.Now()
	server.cancel()
	if err := <-server.result; err != nil {
		t.Fatalf("serve returned error for idle shutdown: %v", err)
	}
	if elapsed := time.Since(started); elapsed >= time.Second {
		t.Fatalf("idle shutdown took %s, want under 1s", elapsed)
	}
}

func testServeClosedListenerError(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen on an ephemeral test port: %v", err)
	}
	addr := ln.Addr().String()
	if addr == "" {
		t.Fatal("listener returned an empty address")
	}
	if err := ln.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}

	err = serve(context.Background(), ln, &http.Server{Handler: http.NotFoundHandler()}, time.Second)
	if err == nil {
		t.Fatal("serve returned nil for a closed listener")
	}
	if errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("serve swallowed the real listener error as ErrServerClosed: %v", err)
	}
}

type testServer struct {
	listener net.Listener
	server   *http.Server
	addr     string
	cancel   context.CancelFunc
	result   chan error
}

func startTestServer(t *testing.T, handler http.Handler, grace time.Duration) *testServer {
	t.Helper()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen on an ephemeral test port: %v", err)
	}
	addr := ln.Addr().String()
	ctx, cancel := context.WithCancel(context.Background())
	srv := &http.Server{Handler: handler}
	result := make(chan error, 1)
	go func() {
		result <- serve(ctx, ln, srv, grace)
	}()

	return &testServer{
		listener: ln,
		server:   srv,
		addr:     addr,
		cancel:   cancel,
		result:   result,
	}
}

func (s *testServer) cleanup() {
	s.cancel()
	_ = s.server.Close()
	_ = s.listener.Close()
}
