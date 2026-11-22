// Package server serves one file as a table over HTTP: a JSON API, server
// sent events when the file changes, and the embedded UI.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/maphash"
	"io/fs"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/babarot/xxsv/internal/diff"
	"github.com/babarot/xxsv/internal/query"
	"github.com/babarot/xxsv/internal/server/ui"
	"github.com/babarot/xxsv/internal/table"
)

// Options configure a Server.
type Options struct {
	Load table.Options
	// PollInterval is how often the file is checked for changes;
	// 0 means 300ms.
	PollInterval time.Duration
	// MinReloadInterval is the shortest time between two reloads, for files
	// that are appended to all the time; 0 means 1s.
	MinReloadInterval time.Duration
	// UI is served at /. Nil serves the embedded UI.
	UI fs.FS
	// Version is shown in the UI's about panel.
	Version string
}

// snapshot is one load of the file. It never changes once published.
type snapshot struct {
	gen    uint64
	table  *table.Table
	engine *query.Engine
	// stats returns the column statistics. They are computed in the
	// background from the moment the snapshot is made, so that the server
	// starts listening (and the browser starts loading the page) without
	// waiting for them; /api/stats waits for them instead.
	stats    func() []table.Stats
	loadedAt time.Time
	// file is the file's state just before it was read, so a change made
	// while reading is seen as a change by the watcher.
	file fileState
	// hashes are the row hashes over all columns, for the next comparison.
	// Nil until a reload needs them.
	hashes *diff.Hashes
	// changes are what changed since the previous generation; nil for the
	// first load.
	changes *diff.Changes
}

// Server serves one file.
type Server struct {
	path string
	opts Options

	cur    atomic.Pointer[snapshot]
	events *broker

	errMu   sync.Mutex
	loadErr string // the last load error; "" after a successful load

	// allowedHosts are the Host header values accepted, set by Serve.
	allowedHosts map[string]bool

	// seed hashes the rows of every generation, so their hashes compare.
	seed maphash.Seed

	exports exports
}

// New loads the file once and returns a Server for it. The first load must
// succeed; later failures keep the last good table.
func New(path string, opts Options) (*Server, error) {
	if opts.PollInterval <= 0 {
		opts.PollInterval = 300 * time.Millisecond
	}
	if opts.MinReloadInterval <= 0 {
		opts.MinReloadInterval = time.Second
	}
	s := &Server{path: path, opts: opts, events: newBroker(), seed: maphash.MakeSeed()}
	if err := s.reload(); err != nil {
		return nil, err
	}
	return s, nil
}

// reload reads the file and publishes a new snapshot.
func (s *Server) reload() error {
	st := stat(s.path)
	t, err := table.LoadFile(s.path, s.opts.Load)
	if err != nil {
		s.errMu.Lock()
		s.loadErr = err.Error()
		s.errMu.Unlock()
		return err
	}
	snap := &snapshot{
		gen:      1,
		table:    t,
		engine:   query.New(t),
		stats:    background(t.Stats),
		loadedAt: time.Now(),
		file:     st,
	}
	// Compare with the previous generation while its table is still here.
	// The first load is not compared, so its hashes are made at the first
	// reload instead of delaying the start.
	if old := s.cur.Load(); old != nil {
		snap.gen = old.gen + 1
		snap.changes, snap.hashes = diff.Compare(s.seed, old.table, old.hashes, t, old.gen, 0)
	}
	s.cur.Store(snap)
	s.errMu.Lock()
	s.loadErr = ""
	s.errMu.Unlock()
	return nil
}

// background starts f in a goroutine and returns a function that waits for
// its result.
func background[T any](f func() T) func() T {
	done := make(chan struct{})
	var v T
	go func() {
		defer close(done)
		v = f()
	}()
	return func() T {
		<-done
		return v
	}
}

func (s *Server) lastError() string {
	s.errMu.Lock()
	defer s.errMu.Unlock()
	return s.loadErr
}

// Serve accepts connections on l until ctx is done. l must listen on a
// loopback address; only Host headers naming that address are answered.
func (s *Server) Serve(ctx context.Context, l net.Listener) error {
	port := strconv.Itoa(l.Addr().(*net.TCPAddr).Port)
	s.allowedHosts = map[string]bool{
		"127.0.0.1:" + port: true,
		"localhost:" + port: true,
	}
	srv := &http.Server{
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	go s.watch(ctx)
	go func() {
		<-ctx.Done()
		s.events.close()
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	if err := srv.Serve(l); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// Handler returns the HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/meta", s.handleMeta)
	mux.HandleFunc("GET /api/stats", s.handleStats)
	mux.HandleFunc("POST /api/rows", s.handleRows)
	mux.HandleFunc("GET /api/cell", s.handleCell)
	mux.HandleFunc("POST /api/export", s.handleExportStart)
	mux.HandleFunc("GET /api/export/{token}", s.handleExportDownload)
	mux.HandleFunc("POST /api/aggregate", s.handleAggregate)
	mux.HandleFunc("GET /api/events", s.handleEvents)
	files := s.opts.UI
	if files == nil {
		files = ui.FS
	}
	mux.Handle("GET /", withCSP(http.FileServerFS(files)))
	return s.checkHost(mux)
}

// withCSP limits the page to its own scripts, styles and API, so a cell
// value can never load or run anything even if it reached the DOM as HTML.
func withCSP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy",
			"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// Embedded files have no modification time, so the responses carry
		// no validator, and browsers would reuse a cached app.js or
		// style.css from an older xxsv. They are small and local: fetch them
		// every time.
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}

// checkHost rejects requests whose Host header is not the loopback address
// the server listens on. A web page that points its own domain at
// 127.0.0.1 (DNS rebinding) is then same-origin with the server in the
// browser, but its requests carry its own domain in Host.
func (s *Server) checkHost(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.allowedHosts != nil && !s.allowedHosts[r.Host] {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Column describes a column in /api/meta.
type Column struct {
	Name string     `json:"name"`
	Type table.Type `json:"type"`
}

// Meta is the body of /api/meta.
type Meta struct {
	Version         string       `json:"version"`
	Generation      uint64       `json:"generation"`
	File            string       `json:"file"`
	Format          table.Format `json:"format"`
	Delimiter       string       `json:"delimiter,omitempty"`
	HeaderGenerated bool         `json:"headerGenerated"`
	Columns         []Column     `json:"columns"`
	Rows            int          `json:"rows"`
	RaggedRows      int          `json:"raggedRows"`
	SkippedLines    int          `json:"skippedLines"`
	FoldedKeys      int          `json:"foldedKeys"`
	LoadedAt        time.Time    `json:"loadedAt"`
	// Changes are what changed since the previous generation; absent for
	// the first load.
	Changes *diff.Changes `json:"changes,omitempty"`
	// Error is the last load error. The table is then the last one that
	// loaded.
	Error string `json:"error,omitempty"`
}

func (s *Server) meta() Meta {
	snap := s.cur.Load()
	t := snap.table
	m := Meta{
		Version:         s.opts.Version,
		Generation:      snap.gen,
		File:            filepath.Base(s.path),
		Format:          t.Format,
		HeaderGenerated: t.HeaderGenerated,
		Columns:         make([]Column, len(t.Columns)),
		Rows:            t.Rows,
		RaggedRows:      t.RaggedRows,
		SkippedLines:    t.SkippedLines,
		FoldedKeys:      t.FoldedKeys,
		LoadedAt:        snap.loadedAt,
		Changes:         snap.changes,
		Error:           s.lastError(),
	}
	if t.Delimiter != 0 {
		m.Delimiter = string(t.Delimiter)
	}
	for i, c := range t.Columns {
		m.Columns[i] = Column{c.Name, c.Type}
	}
	return m
}

func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.meta())
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	snap := s.cur.Load()
	writeJSON(w, http.StatusOK, struct {
		Generation uint64        `json:"generation"`
		Stats      []table.Stats `json:"stats"`
	}{snap.gen, snap.stats()})
}

// RowsResponse is the body of POST /api/rows.
type RowsResponse struct {
	Generation uint64 `json:"generation"`
	*query.Result
	// Changed lists the cells changed since the previous generation, as
	// [row index in Rows, column in Rows]; Added lists the rows added, as
	// row indexes in Rows.
	Changed [][2]int `json:"changed,omitempty"`
	Added   []int    `json:"added,omitempty"`
	// Invalid lists the cells whose text is not a value of their column's
	// type, as [row index in Rows, column in Rows].
	Invalid [][2]int `json:"invalid,omitempty"`
}

func (s *Server) handleRows(w http.ResponseWriter, r *http.Request) {
	var q query.Query
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&q); err != nil {
		writeError(w, http.StatusBadRequest, "bad request body: "+err.Error())
		return
	}
	snap := s.cur.Load()
	res, err := snap.engine.Run(q)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, query.ErrBadQuery) {
			status = http.StatusBadRequest
		}
		writeError(w, status, err.Error())
		return
	}
	resp := RowsResponse{Generation: snap.gen, Result: res}
	// pos maps a file column to its position in Rows, or -1 when hidden.
	pos := make([]int, len(snap.table.Columns))
	for i := range pos {
		pos[i] = -1
	}
	for ci, fi := range res.Cols {
		pos[fi] = ci
	}
	for ci, fi := range res.Cols {
		c := snap.table.Columns[fi]
		for i, id := range res.RowIDs {
			if c.IsInvalid(id) {
				resp.Invalid = append(resp.Invalid, [2]int{i, ci})
			}
		}
	}
	if snap.changes != nil {
		for i, id := range res.RowIDs {
			cols, added := snap.changes.Row(id)
			if added {
				resp.Added = append(resp.Added, i)
			}
			for _, c := range cols {
				if p := pos[c]; p >= 0 {
					resp.Changed = append(resp.Changed, [2]int{i, p})
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// AggregateRequest is the body of POST /api/aggregate: the same search,
// filters and sort keys as /api/rows, and the range of cells in that order.
type AggregateRequest struct {
	Search  string         `json:"search,omitempty"`
	Filters []query.Filter `json:"filters,omitempty"`
	Sorts   []query.Sort   `json:"sorts,omitempty"`
	Columns []string       `json:"columns,omitempty"`
	query.Range
}

func (s *Server) handleAggregate(w http.ResponseWriter, r *http.Request) {
	var req AggregateRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad request body: "+err.Error())
		return
	}
	snap := s.cur.Load()
	agg, err := snap.engine.Aggregate(query.Query{Search: req.Search, Filters: req.Filters, Sorts: req.Sorts, Columns: req.Columns}, req.Range)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, query.ErrBadQuery) {
			status = http.StatusBadRequest
		}
		writeError(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Generation uint64 `json:"generation"`
		*query.Aggregate
	}{snap.gen, agg})
}

// handleCell returns one cell in full. Row numbers change from one load to
// the next, so the request names the generation it saw the row in.
func (s *Server) handleCell(w http.ResponseWriter, r *http.Request) {
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
	c := t.Columns[col]
	writeJSON(w, http.StatusOK, struct {
		Generation uint64 `json:"generation"`
		Value      string `json:"value"`
		Null       bool   `json:"null"`
	}{snap.gen, c.Raw[row], c.IsMissing(row)})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, struct {
		Error string `json:"error"`
	}{msg})
}
