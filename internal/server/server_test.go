package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// start serves path on a free loopback port and returns its base URL.
func start(t *testing.T, path string) (*Server, string) {
	t.Helper()
	s, err := New(path, Options{PollInterval: 20 * time.Millisecond, MinReloadInterval: 50 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx, l) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	})
	return s, "http://" + l.Addr().String()
}

func writeFile(t *testing.T, path, text string) {
	t.Helper()
	// write and rename, as many editors do
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatal(err)
	}
}

func getJSON(t *testing.T, url string, v any) int {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if v != nil {
		if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode
}

func postRows(t *testing.T, base, body string) (int, RowsResponse) {
	t.Helper()
	resp, err := http.Post(base+"/api/rows", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var r RowsResponse
	if resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode, r
}

func TestAPI(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "data.csv")
	writeFile(t, path, "id,name\n1,alice\n2,bob\n3,carol\n")
	_, base := start(t, path)

	var m Meta
	if code := getJSON(t, base+"/api/meta", &m); code != 200 {
		t.Fatalf("meta: %d", code)
	}
	if m.Generation != 1 || m.Rows != 3 || len(m.Columns) != 2 || m.Columns[0].Type.String() != "integer" || m.File != "data.csv" || m.Delimiter != "," {
		t.Errorf("meta: %+v", m)
	}

	var st struct {
		Generation uint64
		Stats      []map[string]any
	}
	getJSON(t, base+"/api/stats", &st)
	if len(st.Stats) != 2 || st.Stats[0]["max"] != float64(3) {
		t.Errorf("stats: %+v", st)
	}

	code, r := postRows(t, base, `{"sorts":[{"column":"id","desc":true}],"limit":2}`)
	if code != 200 || r.Total != 3 || len(r.Rows) != 2 || r.Rows[0][1] != "carol" || r.Generation != 1 {
		t.Errorf("rows: %d %+v", code, r)
	}
	if code, _ := postRows(t, base, `{"sorts":[{"column":"nope"}]}`); code != 400 {
		t.Errorf("bad sort column: %d", code)
	}
	if code, _ := postRows(t, base, `{"bogus":1}`); code != 400 {
		t.Errorf("unknown field: %d", code)
	}

	agg, err := http.Post(base+"/api/aggregate", "application/json", strings.NewReader(`{"sorts":[{"column":"id","desc":true}],"r0":0,"r1":1,"c0":0,"c1":1}`))
	if err != nil {
		t.Fatal(err)
	}
	var a struct {
		Generation   uint64
		Count        int
		NumericCount int
		Sum          float64
	}
	if err := json.NewDecoder(agg.Body).Decode(&a); err != nil {
		t.Fatal(err)
	}
	agg.Body.Close()
	if agg.StatusCode != 200 || a.Count != 4 || a.NumericCount != 2 || a.Sum != 5 || a.Generation != 1 {
		t.Errorf("aggregate: %d %+v", agg.StatusCode, a)
	}

	var cell struct {
		Value string
		Null  bool
	}
	if code := getJSON(t, base+"/api/cell?gen=1&row=1&col=1", &cell); code != 200 || cell.Value != "bob" {
		t.Errorf("cell: %d %+v", code, cell)
	}
	if code := getJSON(t, base+"/api/cell?gen=7&row=1&col=1", nil); code != http.StatusConflict {
		t.Errorf("old generation: %d", code)
	}
	if code := getJSON(t, base+"/api/cell?gen=1&row=9&col=1", nil); code != http.StatusNotFound {
		t.Errorf("no such row: %d", code)
	}
	if code := getJSON(t, base+"/api/cell?gen=x", nil); code != http.StatusBadRequest {
		t.Errorf("bad params: %d", code)
	}
}

func TestHostCheck(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.csv")
	writeFile(t, path, "a\n1\n")
	_, base := start(t, path)
	port := strings.TrimPrefix(base, "http://127.0.0.1:")
	for host, want := range map[string]int{
		"127.0.0.1:" + port:      200,
		"localhost:" + port:      200,
		"evil.example:" + port:   403,
		"127.0.0.1":              403,
		"localhost.evil:" + port: 403,
	} {
		req, _ := http.NewRequest("GET", base+"/api/meta", nil)
		req.Host = host
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("Host %q: got %d, want %d", host, resp.StatusCode, want)
		}
	}
}

// events reads server sent events from /api/events.
func events(t *testing.T, base string) <-chan string {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, "GET", base+"/api/events", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	ch := make(chan string, 16)
	go func() {
		defer resp.Body.Close()
		defer close(ch)
		sc := bufio.NewScanner(resp.Body)
		var name string
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				ch <- name + " " + strings.TrimPrefix(line, "data: ")
			}
		}
	}()
	return ch
}

func next(t *testing.T, ch <-chan string) string {
	t.Helper()
	select {
	case e := <-ch:
		return e
	case <-time.After(5 * time.Second):
		t.Fatal("no event")
		return ""
	}
}

func TestReloadAndErrors(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "data.jsonl")
	writeFile(t, path, `{"a":1}`+"\n")
	s, base := start(t, path)
	ch := events(t, base)
	if e := next(t, ch); e != `hello {"generation":1}` {
		t.Fatalf("first event: %s", e)
	}

	writeFile(t, path, `{"a":1}`+"\n"+`{"a":2}`+"\n")
	if e := next(t, ch); e != `reload {"generation":2}` {
		t.Fatalf("after save: %s", e)
	}
	var m Meta
	m = Meta{} // fields left out of the JSON (omitempty) must not keep old values
	getJSON(t, base+"/api/meta", &m)
	if m.Rows != 2 || m.Generation != 2 || m.Error != "" {
		t.Errorf("meta after reload: %+v", m)
	}

	// A file that disappears keeps the last table and reports an error.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if e := next(t, ch); !strings.HasPrefix(e, "error ") {
		t.Fatalf("after remove: %s", e)
	}
	m = Meta{} // fields left out of the JSON (omitempty) must not keep old values
	getJSON(t, base+"/api/meta", &m)
	if m.Rows != 2 || m.Error == "" {
		t.Errorf("meta after remove: %+v", m)
	}

	// Coming back clears the error.
	writeFile(t, path, `{"a":1}`+"\n"+`{"a":2}`+"\n"+`{"a":3}`+"\n")
	if e := next(t, ch); e != `reload {"generation":3}` {
		t.Fatalf("after restore: %s", e)
	}
	m = Meta{} // fields left out of the JSON (omitempty) must not keep old values
	getJSON(t, base+"/api/meta", &m)
	if m.Rows != 3 || m.Error != "" {
		t.Errorf("meta after restore: %+v", m)
	}
	_ = s
}

func TestFrequentAppendsAreThrottled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log.jsonl")
	writeFile(t, path, `{"i":0}`+"\n")
	s, err := New(path, Options{PollInterval: 10 * time.Millisecond, MinReloadInterval: 300 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.watch(ctx)

	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(700 * time.Millisecond)
	for i := 1; time.Now().Before(deadline); i++ {
		fmt.Fprintf(f, `{"i":%d}`+"\n", i)
		time.Sleep(25 * time.Millisecond) // two polls, so each append settles
	}
	f.Close()
	gen := s.cur.Load().gen
	// About 25 appends in 700ms; with 300ms between reloads, at most 3.
	if gen < 2 || gen > 4 {
		t.Errorf("generation %d: reloads were not throttled to about one per 300ms", gen)
	}
}

func TestUI(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.csv")
	writeFile(t, path, "a\n1\n")
	_, base := start(t, path)
	resp, err := http.Get(base + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || !strings.Contains(string(body), "app.js") {
		t.Errorf("index: %d", resp.StatusCode)
	}
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'self'") {
		t.Errorf("CSP: %q", csp)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("Cache-Control: %q", cc)
	}
	js, err := http.Get(base + "/app.js")
	if err != nil {
		t.Fatal(err)
	}
	js.Body.Close()
	if js.StatusCode != 200 {
		t.Errorf("app.js: %d", js.StatusCode)
	}
}

// TestChanges reloads by hand and checks the changes in /api/meta and the
// marks in /api/rows, also in a sorted view where the row order differs
// from the file.
func TestChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.csv")
	writeFile(t, path, "id,name\n1,a\n2,b\n3,c\n4,d\n")
	s, err := New(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	var m Meta
	getJSON(t, srv.URL+"/api/meta", &m)
	if m.Changes != nil {
		t.Fatalf("first load has changes: %+v", m.Changes)
	}
	_, r := postRows(t, srv.URL, `{}`)
	if r.Changed != nil || r.Added != nil {
		t.Fatalf("first load marks rows: %v %v", r.Changed, r.Added)
	}

	// Remove row 1, edit row 3's name and append a row.
	writeFile(t, path, "id,name\n2,b\n3,C\n4,d\n9,x\n")
	if err := s.reload(); err != nil {
		t.Fatal(err)
	}
	getJSON(t, srv.URL+"/api/meta", &m)
	c := m.Changes
	if c == nil || c.From != 1 || c.ChangedRows != 1 || c.ChangedCells != 1 || c.AddedRows != 1 || c.RemovedRows != 1 || c.TooMany {
		t.Fatalf("changes: %+v", c)
	}
	_, r = postRows(t, srv.URL, `{}`)
	if fmt.Sprint(r.Changed) != "[[1 1]]" || fmt.Sprint(r.Added) != "[3]" {
		t.Errorf("file order: changed %v, added %v", r.Changed, r.Added)
	}
	// Sorted by id descending: 9 (added), 4, 3 (changed), 2.
	_, r = postRows(t, srv.URL, `{"sorts":[{"column":"id","desc":true}]}`)
	if fmt.Sprint(r.RowIDs) != "[3 2 1 0]" || fmt.Sprint(r.Changed) != "[[2 1]]" || fmt.Sprint(r.Added) != "[0]" {
		t.Errorf("sorted: rows %v, changed %v, added %v", r.RowIDs, r.Changed, r.Added)
	}

	// With the columns reordered and name hidden, no change shows; with
	// name first, the change is at position 0.
	_, r = postRows(t, srv.URL, `{"columns":["id"]}`)
	if r.Changed != nil || fmt.Sprint(r.Added) != "[3]" {
		t.Errorf("name hidden: changed %v, added %v", r.Changed, r.Added)
	}
	_, r = postRows(t, srv.URL, `{"columns":["name","id"]}`)
	if fmt.Sprint(r.Changed) != "[[1 0]]" {
		t.Errorf("name first: changed %v", r.Changed)
	}

	// A save without changes clears the marks.
	writeFile(t, path, "id,name\n2,b\n3,C\n4,d\n9,x\n")
	if err := s.reload(); err != nil {
		t.Fatal(err)
	}
	getJSON(t, srv.URL+"/api/meta", &m)
	if c := m.Changes; c == nil || c.From != 2 || c.ChangedRows+c.AddedRows+c.RemovedRows != 0 {
		t.Errorf("unchanged save: %+v", c)
	}
	_, r = postRows(t, srv.URL, `{}`)
	if r.Changed != nil || r.Added != nil {
		t.Errorf("unchanged save marks rows: %v %v", r.Changed, r.Added)
	}
}

func TestRowsMarkInvalidCells(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.csv")
	var b strings.Builder
	b.WriteString("n,s\n")
	for i := 0; i < 30; i++ {
		fmt.Fprintf(&b, "%d,x\n", i)
	}
	b.WriteString("oops,y\n,z\n")
	writeFile(t, path, b.String())
	s, err := New(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	_, r := postRows(t, srv.URL, `{"offset":29,"limit":5}`)
	if fmt.Sprint(r.Invalid) != "[[1 0]]" {
		t.Errorf("invalid: %v", r.Invalid)
	}
	_, r = postRows(t, srv.URL, `{"offset":29,"limit":5,"columns":["s","n"]}`)
	if fmt.Sprint(r.Invalid) != "[[1 1]]" {
		t.Errorf("invalid with n second: %v", r.Invalid)
	}
	if code, _ := postRows(t, srv.URL, `{"columns":["nope"]}`); code != 400 {
		t.Errorf("unknown column: %d, want 400", code)
	}
	var cell struct{ Null bool }
	getJSON(t, srv.URL+"/api/cell?gen=1&row=30&col=0", &cell)
	if cell.Null {
		t.Error("invalid text reported as missing")
	}
	getJSON(t, srv.URL+"/api/cell?gen=1&row=31&col=0", &cell)
	if !cell.Null {
		t.Error("empty cell not reported as missing")
	}
}
