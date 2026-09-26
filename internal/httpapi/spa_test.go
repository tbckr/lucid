package httpapi

import (
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

var testAssets = fstest.MapFS{
	"index.html":          {Data: []byte("<!doctype html><html><div id=root></div></html>")},
	"assets/app-1a2b.js":  {Data: []byte("console.log(1)")},
	"assets/app-1a2b.css": {Data: []byte("body{}")},
	"favicon.svg":         {Data: []byte("<svg/>")},
	".gitkeep":            {Data: nil},
	"assets/sub/x.txt":    {Data: []byte("x")},
}

func TestSPA(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(o *Options) { o.Assets = testAssets })
	tests := []struct {
		name   string
		method string
		path   string
		status int
		body   string
		cache  string
		ctype  string
	}{
		{"root", http.MethodGet, "/", http.StatusOK, "id=root", cacheRevalidate, "text/html"},
		{"index.html", http.MethodGet, "/index.html", http.StatusOK, "id=root", cacheRevalidate, "text/html"},
		{"client route", http.MethodGet, "/calendar/2025/01", http.StatusOK, "id=root", cacheRevalidate, "text/html"},
		{"asset", http.MethodGet, "/assets/app-1a2b.js", http.StatusOK, "console.log", cacheImmutable, "javascript"},
		{"css asset", http.MethodGet, "/assets/app-1a2b.css", http.StatusOK, "body{}", cacheImmutable, "text/css"},
		{"head asset", http.MethodHead, "/assets/app-1a2b.js", http.StatusOK, "", cacheImmutable, "javascript"},
		{"missing asset", http.MethodGet, "/assets/app-old.js", http.StatusNotFound, "", "", ""},
		{"asset directory", http.MethodGet, "/assets/sub/", http.StatusNotFound, "", "", ""},
		{"asset traversal", http.MethodGet, "/assets/../index.html", http.StatusTemporaryRedirect, "", "", ""}, // ServeMux cleans
		{"root file", http.MethodGet, "/favicon.svg", http.StatusOK, "<svg/>", cacheRevalidate, "image/svg"},
		{"dotfile", http.MethodGet, "/.gitkeep", http.StatusOK, "id=root", cacheRevalidate, "text/html"},
		{"post", http.MethodPost, "/", http.StatusMethodNotAllowed, "", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			w := h.do(t, nil, req{method: tt.method, path: tt.path})
			if w.Code != tt.status {
				t.Fatalf("status = %d, want %d", w.Code, tt.status)
			}
			if !strings.Contains(w.Body.String(), tt.body) {
				t.Errorf("body = %q, want %q", w.Body, tt.body)
			}
			if tt.cache != "" && w.Header().Get("Cache-Control") != tt.cache {
				t.Errorf("Cache-Control = %q, want %q", w.Header().Get("Cache-Control"), tt.cache)
			}
			if !strings.Contains(w.Header().Get("Content-Type"), tt.ctype) {
				t.Errorf("Content-Type = %q, want %q", w.Header().Get("Content-Type"), tt.ctype)
			}
			if w.Header().Get("Content-Security-Policy") == "" {
				t.Error("CSP missing")
			}
		})
	}
}

func TestSPAPlaceholder(t *testing.T) {
	t.Parallel()
	for name, assets := range map[string]fs.FS{
		"nil":        nil,
		"no index":   fstest.MapFS{".gitkeep": {}},
		"empty dist": fstest.MapFS{},
	} {
		h := newHarness(t, func(o *Options) { o.Assets = assets })
		w := h.do(t, nil, req{method: http.MethodGet, path: "/some/route"})
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "has not been built") {
			t.Errorf("%s: %d %q", name, w.Code, w.Body)
		}
		w = h.do(t, nil, req{method: http.MethodGet, path: "/assets/x.js"})
		if w.Code != http.StatusNotFound {
			t.Errorf("%s: asset status %d", name, w.Code)
		}
	}
}

// noSeekFS hides io.Seeker so the buffered fallback is exercised.
type noSeekFS struct{ fs.FS }

type noSeekFile struct{ f fs.File }

func (f noSeekFile) Stat() (fs.FileInfo, error) { return f.f.Stat() }
func (f noSeekFile) Read(b []byte) (int, error) { return f.f.Read(b) }
func (f noSeekFile) Close() error               { return f.f.Close() }

func (n noSeekFS) Open(name string) (fs.File, error) {
	f, err := n.FS.Open(name)
	if err != nil {
		return nil, err
	}
	return noSeekFile{f}, nil
}

func TestSPANonSeekableFS(t *testing.T) {
	t.Parallel()
	s := newSPA(noSeekFS{testAssets})

	// Unclean paths reaching the handler directly are cleaned, never escaping the FS.
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", http.NoBody)
	r.URL.Path = "/assets/../../index.html"
	s.ServeHTTP(w, r)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "id=root") {
		t.Errorf("traversal: status %d body %q", w.Code, w.Body)
	}

	w = httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/assets/app-1a2b.js", http.NoBody))
	body, _ := io.ReadAll(w.Body)
	if w.Code != http.StatusOK || string(body) != "console.log(1)" {
		t.Errorf("status %d body %q", w.Code, body)
	}
}
