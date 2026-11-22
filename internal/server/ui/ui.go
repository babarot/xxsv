// Package ui embeds the built web UI (web/ in the repository, built with
// `npm run build` into dist/, which is committed).
package ui

import (
	"embed"
	"io/fs"
)

//go:embed dist
var files embed.FS

// FS holds index.html, app.js and style.css.
var FS, _ = fs.Sub(files, "dist")
