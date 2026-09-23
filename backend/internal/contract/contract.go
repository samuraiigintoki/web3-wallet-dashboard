package contract

import "time"

type Contract struct {
	ID              int64
	ChainID         int64
	Address         string
	StartBlock      int64
	IndexingEnabled bool
	CreatedAt       time.Time
}

type TrackedContract struct {
	ID         int64
	Address    string
	ChainID    int64
	StartBlock int64
	Label      string
	Enabled    bool
	CreatedAt  time.Time
}

type ListFilter struct {
	Page     int
	PageSize int
	ChainID  int64
	Search   string
	Enabled  *bool
}

type CreateInput struct {
	Address    string
	ChainID    int64
	Label      string
	StartBlock int64
}
