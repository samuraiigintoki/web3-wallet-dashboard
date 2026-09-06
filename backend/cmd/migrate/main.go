package main

import (
	"database/sql"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/migrations"
	"log"
	"os"
)

func main() {
	direction := "up"

	if len(os.Args) > 1 {
		direction = os.Args[1]

		if direction != "up" && direction != "down" {
			log.Fatal("Usage: migrate [up|down]")
		}
	}

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("Error: DATABASE_URL environment variable is not set")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		log.Fatalf("error opening database connection: %v", err)
	}
	defer db.Close()

	if err = db.Ping(); err != nil {
		log.Fatalf("database unreachable: %v", err)
	}

	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations(
				version TEXT PRIMARY KEY,
				applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);`)
	if err != nil {
		log.Fatalf("error bootstraping schema_migraions table: %v", err)
	}

	switch direction {
	case "up":
		log.Println("running 'up' migrations...")
		runningUpMigrations(db)
	case "down":
		log.Println("running 'down' migrations...")
		runningDownMigrations(db)
	}

}

func runningUpMigrations(db *sql.DB) {
	version := "0001_create_wallets"

	var alreadyApplied bool
	query := "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1)"

	err := db.QueryRow(query, version).Scan(&alreadyApplied)
	if err != nil {
		log.Fatalf("failed checking migration status: %v", err)
	}

	if alreadyApplied {
		log.Printf("Migration %s is already applied, nothing to do.", version)
		return
	}

	content, err := migrations.FS.ReadFile("0001_create_wallets.up.sql")
	if err != nil {
		log.Fatalf("error reading migration file : %v", err)
	}

	tx, err := db.Begin()
	if err != nil {
		log.Fatalf("failed to start transaction: %v", err)
	}

	_, err = tx.Exec(string(content))
	if err != nil {
		defer tx.Rollback()
		log.Fatalf("failed executing migrations %s: %v", version, err)
	}

	_, err = tx.Exec("INSERT INTO schema_migrations (version) VALUES ($1)", version)
	if err != nil {
		defer tx.Rollback()
		log.Fatalf("failed recording migrations %s: %v", version, err)
	}

	err = tx.Commit()
	if err != nil {
		log.Fatalf("error applying migrations: %v", err)
	}
	log.Printf("successfully applied migraitons: %s", version)
}

func runningDownMigrations(db *sql.DB) {

	version := "0001_create_wallets"

	var alreadyApplied bool
	query := "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1)"

	err := db.QueryRow(query, version).Scan(&alreadyApplied)
	if err != nil {
		log.Fatalf("failed checking migration status : %v", err)
	}

	if !alreadyApplied {
		log.Fatalf("migration %s is not applied, nothing to roll back", version)
		return
	}

	content, err := migrations.FS.ReadFile("0001_create_wallets.down.sql")
	if err != nil {
		log.Fatalf("error reading migration file : %v", err)
	}

	tx, err := db.Begin()
	if err != nil {
		log.Fatalf("failed to start transaction : %v", err)
	}

	_, err = tx.Exec(string(content))
	if err != nil {
		tx.Rollback()
		log.Fatalf("error executing migrations :%v", err)
	}

	_, err = tx.Exec("DELETE FROM schema_migrations WHERE version = $1", version)
	if err != nil {
		tx.Rollback()
		log.Fatalf("error migrating transaction: %v", err)
	}

	err = tx.Commit()
	if err != nil {
		log.Fatalf("error applying migrations: %v", err)
	}
	log.Printf("successfully rolled back migration: %s", version)
}
