package deploy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// repositoryRoot walks up from the test's working directory until it finds the
// Dockerfile. Tests run from the package directory, so the depth is known, but
// walking means moving the package does not break the check.
func repositoryRoot(t *testing.T) string {
	t.Helper()

	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}

	for {
		if _, err := os.Stat(filepath.Join(dir, "Dockerfile")); err == nil {
			return dir
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("no Dockerfile found above the test directory")
		}
		dir = parent
	}
}

// copySources returns the sources of every plain COPY instruction in the
// Dockerfile. Build stage copies are skipped: their source is inside another
// stage, not the build context.
func copySources(t *testing.T, path string) []string {
	t.Helper()

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}

	var sources []string
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 || !strings.EqualFold(fields[0], "COPY") {
			continue
		}
		if strings.HasPrefix(fields[1], "--from") {
			continue
		}
		// COPY source... destination. The destination is the last field.
		sources = append(sources, fields[1:len(fields)-1]...)
	}

	return sources
}

// Every file the image copies has to exist in the build context. A typo, a
// renamed script or a path that .dockerignore excludes all fail the image build
// at the COPY line, which is late, slow and unrelated to whatever the change was
// about. This test fails in a second instead.
func TestDockerfileCopySourcesExist(t *testing.T) {
	root := repositoryRoot(t)

	sources := copySources(t, filepath.Join(root, "Dockerfile"))
	if len(sources) == 0 {
		t.Fatal("no COPY sources found, so this test proves nothing")
	}

	for _, source := range sources {
		if _, err := os.Stat(filepath.Join(root, source)); err != nil {
			t.Errorf("Dockerfile copies %q, which does not exist in the build context: %v", source, err)
		}
	}
}

// The build context is the repository root and .dockerignore excludes everything
// but the paths it re-includes. A COPY of a path outside those is not a typo and
// not a missing file: it is a file that exists in the repository and is stripped
// before the builder sees it, so the same build passes locally and fails in CI.
func TestDockerfileCopySourcesAreInTheBuildContext(t *testing.T) {
	root := repositoryRoot(t)

	raw, err := os.ReadFile(filepath.Join(root, ".dockerignore"))
	if err != nil {
		t.Fatalf("read .dockerignore: %v", err)
	}

	included := map[string]bool{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "!") {
			included[strings.TrimPrefix(line, "!")] = true
		}
	}

	for _, source := range copySources(t, filepath.Join(root, "Dockerfile")) {
		top := strings.SplitN(filepath.ToSlash(source), "/", 2)[0]
		if !included[top] {
			t.Errorf("Dockerfile copies %q, but .dockerignore does not re-include %q, so the builder never sees it", source, top)
		}
	}
}
