package server

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// imageTypes are the image types served, as http.DetectContentType names
// them. SVG is not one: opened as a page, it can run scripts.
var imageTypes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
	"image/webp": true,
	"image/bmp":  true,
}

var errNotImage = errors.New("not an image")

// handleImage serves the image of a cell: the file it names by its path, or
// the one its data: URL holds. The
// request names the cell, never a path, and openImage decides what may be
// read.
func (s *Server) handleImage(w http.ResponseWriter, r *http.Request) {
	// A page of another site can point an <img> here; the browser then
	// refuses it the response, errors included.
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")

	snap := s.cur.Load()
	qs := r.URL.Query()
	gen, err1 := strconv.ParseUint(qs.Get("gen"), 10, 64)
	row, err2 := strconv.Atoi(qs.Get("row"))
	col, err3 := strconv.Atoi(qs.Get("col"))
	if err := errors.Join(err1, err2, err3); err != nil {
		writeError(w, http.StatusBadRequest, "gen, row and col must be numbers")
		return
	}
	if gen != snap.gen {
		writeError(w, http.StatusConflict, fmt.Sprintf("generation %d is gone; the file was reloaded (now %d)", gen, snap.gen))
		return
	}
	t := snap.table
	if row < 0 || row >= t.Rows || col < 0 || col >= len(t.Columns) {
		writeError(w, http.StatusNotFound, "no such cell")
		return
	}
	// A cell that names no image is an empty answer rather than a 404: file
	// names without their files are ordinary in a table, and browsers log
	// every 404 to the console.
	value := strings.TrimSpace(t.Columns[col].Raw[row])
	if b, ctype, ok := dataImage(value); ok {
		w.Header().Set("Content-Type", ctype)
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(b))
		return
	}
	f, info, ctype, err := openImage(s.path, value)
	if err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "", info.ModTime(), f)
}

// dataImage decodes a base64 data: URL of an image. The content decides the
// type, not the URL.
func dataImage(value string) ([]byte, string, bool) {
	if len(value) < 5 || !strings.EqualFold(value[:5], "data:") {
		return nil, "", false
	}
	_, text, ok := strings.Cut(value, ";base64,")
	if !ok {
		return nil, "", false
	}
	b, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		return nil, "", false
	}
	ctype := http.DetectContentType(b)
	return b, ctype, imageTypes[ctype]
}

// openImage opens the image file that value, a cell of the table at
// tablePath, names by its path, if its content is one of imageTypes. An
// absolute path may be anywhere. A relative one starts at the table's
// directory and stays in it, through .. or a symbolic link either.
func openImage(tablePath, value string) (_ *os.File, _ fs.FileInfo, ctype string, err error) {
	f, info, err := openRegular(tablePath, value)
	if err != nil {
		return nil, nil, "", err
	}
	defer func() {
		if err != nil {
			f.Close()
		}
	}()
	head := make([]byte, 512)
	n, err := io.ReadFull(f, head)
	if err != nil && err != io.ErrUnexpectedEOF {
		return nil, nil, "", err
	}
	if ctype = http.DetectContentType(head[:n]); !imageTypes[ctype] {
		return nil, nil, "", errNotImage
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return nil, nil, "", err
	}
	return f, info, ctype, nil
}

// openRegular opens the regular file value names. It looks before it opens,
// since opening a named pipe would wait for a writer.
func openRegular(tablePath, value string) (*os.File, fs.FileInfo, error) {
	// On Windows, merely looking at \\host\share\a.png connects to the host
	// and offers it the user's credentials.
	if len(value) >= 2 && strings.Trim(value[:2], `/\`) == "" {
		return nil, nil, errNotImage
	}
	stat, open := os.Stat, os.Open
	if !filepath.IsAbs(value) {
		if !filepath.IsLocal(value) {
			return nil, nil, errNotImage
		}
		root, err := os.OpenRoot(filepath.Dir(tablePath))
		if err != nil {
			return nil, nil, err
		}
		defer root.Close()
		stat, open = root.Stat, root.Open
	}
	info, err := stat(value)
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, errNotImage
	}
	f, err := open(value)
	return f, info, err
}
