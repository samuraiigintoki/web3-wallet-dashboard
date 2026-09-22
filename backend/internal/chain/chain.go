package chain

import "time"

type Chain struct {
	ChainID   int64     `json:"chainId"`
	Name      string    `json:"name"`
	Symbol    string    `json:"symbol"`
	IsTestnet bool      `json:"isTestnet"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"createdAt"`
}
