package deploy

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// startScriptStubs writes a fake migrate and a fake api that each append their
// name to a log, so a test can see what ran and in which order. migrateExit is
// the status the fake migrate exits with.
func startScriptStubs(t *testing.T, migrateExit int) (dir, logPath string) {
	t.Helper()

	dir = t.TempDir()
	logPath = filepath.Join(dir, "calls.log")

	write := func(name, body string) {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
			t.Fatalf("write stub %s: %v", name, err)
		}
	}

	write("migrate-stub", fmt.Sprintf("#!/bin/sh\necho migrate >> \"$CALL_LOG\"\nexit %d\n", migrateExit))
	write("api-stub", "#!/bin/sh\necho api >> \"$CALL_LOG\"\n")

	return dir, logPath
}

// runStartScript runs the container start script. A nil runMigrations means the
// variable is absent from the environment, which is the case that matters.
func runStartScript(t *testing.T, stubs, logPath string, runMigrations *string) (exitCode int, stderr string) {
	t.Helper()

	script := filepath.Join(repositoryRoot(t), "backend", "scripts", "docker-start.sh")

	cmd := exec.Command("sh", script)
	cmd.Dir = filepath.Dir(script)
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"CALL_LOG=" + logPath,
		"MIGRATE_BIN=" + filepath.Join(stubs, "migrate-stub"),
		"API_BIN=" + filepath.Join(stubs, "api-stub"),
	}
	if runMigrations != nil {
		cmd.Env = append(cmd.Env, "RUN_MIGRATIONS="+*runMigrations)
	}

	var stderrBuf strings.Builder
	cmd.Stderr = &stderrBuf

	err := cmd.Run()
	if err == nil {
		return 0, stderrBuf.String()
	}

	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("running the start script failed: %v", err)
	}

	return exitErr.ExitCode(), stderrBuf.String()
}

func calls(t *testing.T, logPath string) []string {
	t.Helper()

	raw, err := os.ReadFile(logPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatalf("read call log: %v", err)
	}

	return strings.Fields(string(raw))
}

// The container must migrate when told nothing at all.
//
// Readiness only proves the database answers, so a container that skips
// migrations reports healthy while serving an old schema. This script once
// defaulted to not migrating, which is exactly that failure: the platform set no
// RUN_MIGRATIONS, the API started, /health/ready answered 200, and the schema was
// whatever happened to be there.
func TestStartScriptMigratesWhenRunMigrationsIsUnset(t *testing.T) {
	stubs, logPath := startScriptStubs(t, 0)

	code, stderr := runStartScript(t, stubs, logPath, nil)
	if code != 0 {
		t.Fatalf("start script exited %d with RUN_MIGRATIONS unset, want 0. stderr: %s", code, stderr)
	}

	if got := strings.Join(calls(t, logPath), ","); got != "migrate,api" {
		t.Fatalf("with RUN_MIGRATIONS unset the script called %q, want \"migrate,api\"", got)
	}
}

func TestStartScriptMigratesWhenExplicitlyOn(t *testing.T) {
	stubs, logPath := startScriptStubs(t, 0)
	on := "on"

	code, stderr := runStartScript(t, stubs, logPath, &on)
	if code != 0 {
		t.Fatalf("start script exited %d with RUN_MIGRATIONS=on, want 0. stderr: %s", code, stderr)
	}

	if got := strings.Join(calls(t, logPath), ","); got != "migrate,api" {
		t.Fatalf("with RUN_MIGRATIONS=on the script called %q, want \"migrate,api\"", got)
	}
}

// The explicit opt out is the only way to skip migrating, and it is what
// docker-compose uses because its migrate service already ran.
func TestStartScriptSkipsMigrationsOnlyWhenExplicitlyOff(t *testing.T) {
	stubs, logPath := startScriptStubs(t, 0)
	off := "off"

	code, stderr := runStartScript(t, stubs, logPath, &off)
	if code != 0 {
		t.Fatalf("start script exited %d with RUN_MIGRATIONS=off, want 0. stderr: %s", code, stderr)
	}

	if got := strings.Join(calls(t, logPath), ","); got != "api" {
		t.Fatalf("with RUN_MIGRATIONS=off the script called %q, want \"api\"", got)
	}
}

// An operator who writes `true`, `1` or a typo was trying to turn migrations on.
// The script must not read that as permission to skip them, and it must not start
// the API as if it had.
func TestStartScriptRefusesAValueItDoesNotUnderstand(t *testing.T) {
	for _, value := range []string{"true", "1", "yes", "ON", "onn"} {
		t.Run(value, func(t *testing.T) {
			stubs, logPath := startScriptStubs(t, 0)
			v := value

			code, stderr := runStartScript(t, stubs, logPath, &v)
			if code == 0 {
				t.Fatalf("start script accepted RUN_MIGRATIONS=%q and exited 0", value)
			}

			if got := calls(t, logPath); len(got) != 0 {
				t.Fatalf("start script called %v with RUN_MIGRATIONS=%q, want nothing to run", got, value)
			}

			if !strings.Contains(stderr, "RUN_MIGRATIONS") {
				t.Fatalf("stderr does not name the variable, so an operator cannot fix it: %q", stderr)
			}
		})
	}
}

// A failed migration has to stop the deploy. If the API started anyway it would
// serve against the schema the migration was meant to fix, which is the state
// this whole file exists to prevent.
func TestStartScriptDoesNotStartTheAPIWhenMigrationFails(t *testing.T) {
	stubs, logPath := startScriptStubs(t, 1)

	code, _ := runStartScript(t, stubs, logPath, nil)
	if code == 0 {
		t.Fatal("start script exited 0 after a failed migration")
	}

	if got := strings.Join(calls(t, logPath), ","); got != "migrate" {
		t.Fatalf("after a failed migration the script called %q, want only \"migrate\"", got)
	}
}
