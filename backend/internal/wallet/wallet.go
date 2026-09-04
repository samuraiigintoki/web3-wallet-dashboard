package wallet

type Wallet struct {
	ID      string `json:"id"`
	Address string `json:"address"`
	ChainID int    `json:"chainId"`
	Label   string `json:"label"`
}
