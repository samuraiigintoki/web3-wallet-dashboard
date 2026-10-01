package main

import (
	"context"
	"database/sql"
)

type databaseReadiness struct {
	db *sql.DB
}

func (r databaseReadiness) Check(ctx context.Context) error {
	return r.db.PingContext(ctx)
}
