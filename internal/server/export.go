package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/babarot/xxsv/internal/export"
	"github.com/babarot/xxsv/internal/query"
)

// An export is asked for in two steps: POST /api/export checks the query and
// returns a short token, and GET /api/export/{token} writes the file, so the
// browser downloads it as it comes instead of holding it in memory. The
// query is not put in the GET URL, since a filter on a long cell value can
// make it longer than a URL may be.

// exportTTL is how long a token waits for its download.
const exportTTL = 60 * time.Second

type pendingExport struct {
	format  export.Format
	query   query.Query
	expires time.Time
}

// exports holds the tokens not yet downloaded. A token is used once.
type exports struct {
	mu      sync.Mutex
	pending map[string]pendingExport
}

func (x *exports) add(p pendingExport, now time.Time) string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	token := hex.EncodeToString(b[:])
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.pending == nil {
		x.pending = map[string]pendingExport{}
	}
	for t, e := range x.pending {
		if now.After(e.expires) {
			delete(x.pending, t)
		}
	}
	x.pending[token] = p
	return token
}

// take removes a token and returns its export, if it has not expired.
func (x *exports) take(token string, now time.Time) (pendingExport, bool) {
	x.mu.Lock()
	defer x.mu.Unlock()
	p, ok := x.pending[token]
	delete(x.pending, token)
	return p, ok && !now.After(p.expires)
}

// ExportRequest is the body of POST /api/export: a format, and the search,
// filters, sort keys and columns of the view.
type ExportRequest struct {
	Format string      `json:"format"`
	Query  query.Query `json:"query"`
}

func (s *Server) handleExportStart(w http.ResponseWriter, r *http.Request) {
	var req ExportRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad request body: "+err.Error())
		return
	}
	f, err := export.ParseFormat(req.Format)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Run the query now: a bad one fails here, not in the download, and the
	// download reuses the cached order.
	if _, _, err := s.cur.Load().engine.Rows(req.Query); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, query.ErrBadQuery) {
			status = http.StatusBadRequest
		}
		writeError(w, status, err.Error())
		return
	}
	token := s.exports.add(pendingExport{format: f, query: req.Query, expires: time.Now().Add(exportTTL)}, time.Now())
	writeJSON(w, http.StatusOK, struct {
		Token string `json:"token"`
	}{token})
}

// handleExportDownload writes the export of the generation loaded when the
// download starts.
func (s *Server) handleExportDownload(w http.ResponseWriter, r *http.Request) {
	p, ok := s.exports.take(r.PathValue("token"), time.Now())
	if !ok {
		writeError(w, http.StatusNotFound, "no such export; it was downloaded already or expired")
		return
	}
	snap := s.cur.Load()
	rows, cols, err := snap.engine.Rows(p.query)
	if err != nil {
		// The file was reloaded and the query no longer fits (a column is gone).
		writeError(w, http.StatusConflict, fmt.Sprintf("the file changed: %v", err))
		return
	}
	w.Header().Set("Content-Type", p.format.ContentType())
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": exportName(s.path, p.format)}))
	w.Header().Set("Cache-Control", "no-store")
	// Once the body has started, an error can only cut it short.
	_ = export.Write(w, snap.table, rows, cols, p.format)
}

// exportName is the download's file name: the source's name without its
// extension, "-view", and the format's extension.
func exportName(path string, f export.Format) string {
	base := filepath.Base(path)
	return strings.TrimSuffix(base, filepath.Ext(base)) + "-view." + string(f)
}
