package wallet

type Wallet struct {
	ID      int64  `json:"id"`
	Address string `json:"address"`
	ChainID int64  `json:"chainId"`
	Label   string `json:"label"`
}
