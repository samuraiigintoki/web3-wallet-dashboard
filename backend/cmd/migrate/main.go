package main

import (
	"database/sql"
	"errors"
	"fmt"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/migrations"
	"io/fs"
	"log"
	"os"
	"sort"
	"strings"
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
		log.Fatal("DATABASE_URL environment variable is required")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		log.Fatalf("failed initializing database pool: %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		log.Fatalf("database unreachable: %v", err)
	}

	if err := bootstrap(db); err != nil {
		log.Fatalf("bootstrap failed: %v", err)
	}

	switch direction {
	case "up":
		if err := runUp(db); err != nil {
			log.Fatalf("migrate up failed: %v", err)
		}
	case "down":
		if err := runDown(db); err != nil {
			log.Fatalf("migrate down failed: %v", err)
		}
	}
}

func bootstrap(db *sql.DB) error {
	query := `
	CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);`
	_, err := db.Exec(query)
	return err
}

func runUp(db *sql.DB) error {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		return fmt.Errorf("failed reading migrations directory: %w", err)
	}

	var upFiles []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".up.sql") {
			upFiles = append(upFiles, entry.Name())
		}
	}

	sort.Strings(upFiles)

	for _, filename := range upFiles {
		version := strings.TrimSuffix(filename, ".up.sql")

		var alreadyApplied bool
		err := db.QueryRow("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1);", version).Scan(&alreadyApplied)
		if err != nil {
			return fmt.Errorf("failed checking status for %s: %w", version, err)
		}

		if alreadyApplied {
			log.Printf("migration %s already applied, skipping", version)
			continue
		}

		content, err := migrations.FS.ReadFile(filename)
		if err != nil {
			return fmt.Errorf("failed reading %s: %w", filename, err)
		}

		tx, err := db.Begin()
		if err != nil {
			return fmt.Errorf("failed beginning transaction: %w", err)
		}
		defer tx.Rollback()

		if _, err := tx.Exec(string(content)); err != nil {
			return fmt.Errorf("failed executing %s: %w", filename, err)
		}

		if _, err := tx.Exec("INSERT INTO schema_migrations (version) VALUES ($1)", version); err != nil {
			return fmt.Errorf("failed recording %s: %w", filename, err)
		}

		if err := tx.Commit(); err != nil {
			return fmt.Errorf("failed committing transaction for %s: %w", filename, err)
		}

		log.Printf("applied migration: %s", version)
	}

	return nil
}

func runDown(db *sql.DB) error {
	var version string
	err := db.QueryRow("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1;").Scan(&version)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			log.Println("no applied migrations to roll back")
			return nil
		}
		return fmt.Errorf("failed fetching latest migration: %w", err)
	}

	downFilename := version + ".down.sql"
	content, err := migrations.FS.ReadFile(downFilename)
	if err != nil {
		return fmt.Errorf("failed reading %s: %w", downFilename, err)
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(string(content)); err != nil {
		return fmt.Errorf("failed executing %s: %w", downFilename, err)
	}

	if _, err := tx.Exec("DELETE FROM schema_migrations WHERE version = $1", version); err != nil {
		return fmt.Errorf("failed removing %s from schema_migrations: %w", version, err)
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	log.Printf("rolled back migration: %s", version)
	return nil
}
