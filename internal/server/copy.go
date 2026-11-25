package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/babarot/xxsv/internal/export"
	"github.com/babarot/xxsv/internal/query"
)

// copyLimit bounds the text of one copy. The page holds all of it, and so do
// the clipboard and whatever it is pasted into; an export has no limit.
const copyLimit = 16 << 20

// CopyRequest is the body of POST /api/copy: a range of cells as in
// /api/aggregate, and the generation it was selected in.
type CopyRequest struct {
	Generation uint64 `json:"generation"`
	AggregateRequest
}

// handleCopy returns the text of a range of cells for the clipboard. The
// page holds only the rows near the view, and long cells cut.
func (s *Server) handleCopy(w http.ResponseWriter, r *http.Request) {
	var req CopyRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad request body: "+err.Error())
		return
	}
	snap := s.cur.Load()
	// Another generation may have other rows at these positions.
	if req.Generation != snap.gen {
		writeError(w, http.StatusConflict, fmt.Sprintf("generation %d is gone; the file was reloaded (now %d)", req.Generation, snap.gen))
		return
	}
	rows, cols, err := snap.engine.Rows(query.Query{Search: req.Search, Regex: req.Regex, Filters: req.Filters, Sorts: req.Sorts, Columns: req.Columns})
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, query.ErrBadQuery) {
			status = http.StatusBadRequest
		}
		writeError(w, status, err.Error())
		return
	}
	if req.R0 < 0 || req.R0 > req.R1 || req.R1 >= len(rows) || req.C0 < 0 || req.C0 > req.C1 || req.C1 >= len(cols) {
		writeError(w, http.StatusBadRequest, "no such cells")
		return
	}
	text, err := export.Text(snap.table, rows[req.R0:req.R1+1], cols[req.C0:req.C1+1], copyLimit)
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "too much to copy; use Export")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, text)
}
