package wallet

import "context"

type ChainValidator interface {
	IsSupported(ctx context.Context, chainID int64) (bool, error)
}
