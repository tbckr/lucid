// Package web embeds the compiled frontend (Vite dist/ output) into the binary.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Dist returns the compiled frontend rooted at dist/. If the frontend has not
// been built, it only contains .gitkeep and the server serves a placeholder.
func Dist() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // unreachable: "dist" is a valid embedded path
	}
	return sub
}
