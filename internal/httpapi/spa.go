package httpapi

import (
	"bytes"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

// placeholderHTML is served when the frontend was not built into the binary.
const placeholderHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Lucid</title></head>
<body><h1>Lucid</h1><p>The web frontend has not been built into this binary.
Build it (web/) and recompile, or use the API at /api/v1.</p></body></html>
`

const (
	cacheImmutable  = "public, max-age=31536000, immutable"
	cacheRevalidate = "no-cache"
)

// spa serves the embedded single page application:
//   - /assets/* are content-hashed and cached forever; missing ones are 404.
//   - other existing files (favicon, robots.txt) are served with no-cache.
//   - every other path gets index.html (client-side routing).
//
// Only regular files are served, so there are no directory listings.
type spa struct {
	fsys  fs.FS
	index []byte
}

func newSPA(fsys fs.FS) *spa {
	s := &spa{fsys: fsys, index: []byte(placeholderHTML)}
	if fsys != nil {
		if b, err := fs.ReadFile(fsys, "index.html"); err == nil {
			s.index = b
		}
	}
	return s
}

func (s *spa) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")

	if strings.HasPrefix(name, "assets/") {
		if !s.serveFile(w, r, name, cacheImmutable) {
			http.NotFound(w, r)
		}
		return
	}
	if name != "" && name != "index.html" && s.serveFile(w, r, name, cacheRevalidate) {
		return
	}
	w.Header().Set("Cache-Control", cacheRevalidate)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(s.index))
}

// serveFile serves a regular, non-hidden file and reports whether it did.
func (s *spa) serveFile(w http.ResponseWriter, r *http.Request, name, cacheControl string) bool {
	if s.fsys == nil || hidden(name) {
		return false
	}
	f, err := s.fsys.Open(name)
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		b, err := io.ReadAll(f)
		if err != nil {
			return false
		}
		rs = bytes.NewReader(b)
	}
	w.Header().Set("Cache-Control", cacheControl)
	http.ServeContent(w, r, name, info.ModTime(), rs)
	return true
}

// hidden reports whether any path segment is a dotfile (e.g. .gitkeep).
func hidden(name string) bool {
	for seg := range strings.SplitSeq(name, "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}
