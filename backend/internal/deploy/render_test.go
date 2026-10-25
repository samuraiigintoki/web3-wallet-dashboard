package deploy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// service is the part of one render.yaml service this test cares about.
type service struct {
	kind     string
	name     string
	runtime  string
	fields   map[string]string
	envValue map[string]string
}

// readRenderYAML reads the services in render.yaml.
//
// This is not a YAML parser and does not try to be one. It understands exactly
// the shape render.yaml uses: a service per `- type:` line at two spaces, its
// fields at four, and an env var per `- key:` at six with its value at eight.
// A departure from that shape fails the test rather than being skipped, so the
// assumptions cannot rot silently. A real parser would be a new dependency, and
// this is the only file it would serve.
func readRenderYAML(t *testing.T, path string) []service {
	t.Helper()

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}

	var services []service
	var current *service
	var envKey string
	inEnvVars := false

	for _, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}

		indent := len(line) - len(strings.TrimLeft(line, " "))
		field, value, hasValue := strings.Cut(trimmed, ":")
		value = strings.TrimSpace(value)
		if !hasValue {
			continue
		}

		switch {
		case indent == 2 && strings.HasPrefix(trimmed, "- "):
			services = append(services, service{fields: map[string]string{}, envValue: map[string]string{}})
			current = &services[len(services)-1]
			key, val, _ := strings.Cut(strings.TrimPrefix(trimmed, "- "), ":")
			current.fields[strings.TrimSpace(key)] = strings.TrimSpace(val)
			current.kind = strings.TrimSpace(val)
		case current == nil:
			continue
		case indent == 4 && !strings.HasPrefix(trimmed, "- "):
			// Every field at this level closes whatever list came before it.
			inEnvVars = field == "envVars"
			envKey = ""
			if !inEnvVars {
				current.fields[field] = strings.Trim(value, `"`)
			}
		case inEnvVars && indent == 6 && strings.HasPrefix(trimmed, "- key:"):
			envKey = strings.TrimSpace(strings.TrimPrefix(trimmed, "- key:"))
		case inEnvVars && indent == 8 && envKey != "":
			if field == "value" {
				current.envValue[envKey] = strings.Trim(value, `"`)
			}
		}
	}

	for i := range services {
		services[i].name = services[i].fields["name"]
		services[i].runtime = services[i].fields["runtime"]
		if services[i].name == "" || services[i].runtime == "" {
			t.Fatalf("service %d in %s has no name or runtime: %+v", i, path, services[i].fields)
		}
	}

	if len(services) == 0 {
		t.Fatalf("no services found in %s, so this test proves nothing", path)
	}

	return services
}

// Render validates a Blueprint against a published schema with
// additionalProperties false on each service kind. The static site kind accepts
// no plan and no region: both were in this file once and would have been refused
// when the Blueprint was created, which is after review and after CI.
func TestStaticSiteDeclaresNoComputePlan(t *testing.T) {
	services := readRenderYAML(t, filepath.Join(repositoryRoot(t), "render.yaml"))

	found := false
	for _, s := range services {
		if s.runtime != "static" {
			continue
		}
		found = true
		for _, field := range []string{"plan", "region"} {
			if value, ok := s.fields[field]; ok {
				t.Errorf("static site %q sets %s: %q, which Render's schema rejects for a static site", s.name, field, value)
			}
		}
	}

	if !found {
		t.Fatal("render.yaml declares no static service, so this test proves nothing")
	}
}

// The dashboard and the API name each other in two places that cannot be checked
// against each other by any compiler: the bundle's API base and the API's CORS
// allowlist. Renaming a service silently breaks both, and the symptom is every
// request in a deployed browser being blocked.
func TestFrontendAndAPINameEachOther(t *testing.T) {
	services := readRenderYAML(t, filepath.Join(repositoryRoot(t), "render.yaml"))

	var static, docker *service
	for i := range services {
		switch services[i].runtime {
		case "static":
			static = &services[i]
		case "docker":
			docker = &services[i]
		}
	}

	if static == nil || docker == nil {
		t.Fatalf("render.yaml needs one static site and one docker service, found static=%v docker=%v", static != nil, docker != nil)
	}

	wantAPIBase := "https://" + docker.name + ".onrender.com/api/v1"
	if got := static.envValue["VITE_API_BASE_URL"]; got != wantAPIBase {
		t.Errorf("the dashboard builds against %q, want %q, which is the API service's own hostname", got, wantAPIBase)
	}

	wantOrigin := "https://" + static.name + ".onrender.com"
	if got := docker.envValue["CORS_ALLOWED_ORIGINS"]; got != wantOrigin {
		t.Errorf("the API allows %q, want %q, which is the dashboard's own origin", got, wantOrigin)
	}
}
