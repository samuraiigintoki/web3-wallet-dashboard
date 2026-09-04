package wallet

import (
	"errors"
	"strings"
	"testing"
)

func TestService_Create_SequentialAndDuplicate(t *testing.T) {
	repo := NewInMemoryWalletRepo()
	svc := NewService(repo)

	wallet1, err := svc.Create("0x0000000000000000000000000000000000000001", 1, "first")
	gotID := wallet1.ID
	if err != nil {
		t.Fatalf("unexpected error creating wallet: %v", err)
	}

	if gotID != "w1" {
		t.Errorf("expected wallet ID: %q, got: %q", "w1", gotID)
	}

	wallet2, err := svc.Create("0x0000000000000000000000000000000000000002", 1, "second")
	gotSecondID := wallet2.ID

	if err != nil {
		t.Fatalf("unexpected error creating wallet: %v", err)
	}

	if gotSecondID != "w2" {
		t.Errorf("expected wallet ID: %q, got: %q", "w2", gotSecondID)
	}

	_, err = svc.Create("0x0000000000000000000000000000000000000001", 1, "duplicate")
	if !errors.Is(err, ErrWalletDuplicate) {
		t.Errorf("expected ErrWalletDuplicate, got: %v", err)
	}
}

func TestService_Create_Validation(t *testing.T) {
	tests := []struct {
		name          string
		address       string
		chainID       int
		label         string
		expectedField string // e.g. "address", "chainId", "label"
	}{
		{name: "empty address", address: "", chainID: 1, label: "Main", expectedField: "address"},
		{name: "missing 0x", address: "1111000000000000000000000000000000000001", chainID: 1, label: "Main", expectedField: "address"},
		{name: "wrong address length", address: "0x123", chainID: 1, label: "Main", expectedField: "address"},
		{name: "invalid chain id", address: "0x0000000000000000000000000000000000000001", chainID: 0, label: "Main", expectedField: "chainId"},
		{name: "empty label", address: "0x0000000000000000000000000000000000000001", chainID: 1, label: "", expectedField: "label"},
		{name: "label exceeding 50 runes", address: "0x0000000000000000000000000000000000000001", chainID: 1, label: strings.Repeat("a", 51), expectedField: "label"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := NewInMemoryWalletRepo()
			svc := NewService(repo)

			_, err := svc.Create(tt.address, tt.chainID, tt.label)

			var vErr *ValidationError
			if !errors.As(err, &vErr) {
				t.Fatalf("expected ValidationError, got:%v", err)
			}

			if vErr.Field != tt.expectedField {
				t.Errorf("expected Field:%q, got %q", tt.expectedField, vErr.Field)
			}
		})
	}
}
