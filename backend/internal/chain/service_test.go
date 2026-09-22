package chain

import (
	"context"
	"testing"
)

func TestIsSupported_MissingChain(t *testing.T) {
	repo := NewInMemoryRepository()
	svc := NewService(repo)

	supported, err := svc.IsSupported(context.Background(), 999)
	if err != nil {
		t.Fatalf("expected nil error for missing chain, got %v", err)
	}
	if supported {
		t.Fatal("expected false for missing chain")
	}
}

func TestIsSupported_DisabledChain(t *testing.T) {
	repo := NewInMemoryRepository()
	repo.Seed(Chain{ChainID: 1, Name: "Test", Symbol: "T", Enabled: false})
	svc := NewService(repo)

	supported, err := svc.IsSupported(context.Background(), 1)
	if err != nil {
		t.Fatalf("expected nil error for disabled chain, got %v", err)
	}
	if supported {
		t.Fatal("expected false for disabled chain")
	}
}

func TestIsSupported_EnabledChain(t *testing.T) {
	repo := NewInMemoryRepository()
	repo.Seed(Chain{ChainID: 1, Name: "Test", Symbol: "T", Enabled: true})
	svc := NewService(repo)

	supported, err := svc.IsSupported(context.Background(), 1)
	if err != nil {
		t.Fatalf("expected nil error for enabled chain, got %v", err)
	}
	if !supported {
		t.Fatal("expected true for enabled chain")
	}
}

func TestList_OnlyEnabled(t *testing.T) {
	repo := NewInMemoryRepository()
	repo.Seed(
		Chain{ChainID: 1, Name: "Enabled", Symbol: "E", Enabled: true},
		Chain{ChainID: 2, Name: "Disabled", Symbol: "D", Enabled: false},
	)
	svc := NewService(repo)

	chains, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chains) != 1 {
		t.Fatalf("expected 1 enabled chain, got %d", len(chains))
	}
	if chains[0].ChainID != 1 {
		t.Fatalf("expected chain 1, got %d", chains[0].ChainID)
	}
}
