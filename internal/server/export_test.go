package server

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func startExport(t *testing.T, base, body string) (int, string) {
	t.Helper()
	resp, err := http.Post(base+"/api/export", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var v struct{ Token string }
	_ = json.NewDecoder(resp.Body).Decode(&v)
	return resp.StatusCode, v.Token
}

func download(t *testing.T, base, token string) (*http.Response, string) {
	t.Helper()
	resp, err := http.Get(base + "/api/export/" + token)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func TestExport(t *testing.T) {
	path := filepath.Join(t.TempDir(), "orders.csv")
	writeFile(t, path, "id,name,qty\n1,alice,3\n2,bob,\n3,carol,5\n")
	_, base := start(t, path)

	code, token := startExport(t, base, `{"format":"csv","query":{"filters":[{"column":"qty","op":"notnull"}],"sorts":[{"column":"id","desc":true}],"columns":["name","qty"]}}`)
	if code != 200 || len(token) != 32 {
		t.Fatalf("start: %d %q", code, token)
	}
	resp, body := download(t, base, token)
	if resp.StatusCode != 200 || body != "name,qty\ncarol,5\nalice,3\n" {
		t.Errorf("download: %d %q", resp.StatusCode, body)
	}
	if got := resp.Header.Get("Content-Disposition"); got != `attachment; filename=orders-view.csv` {
		t.Errorf("Content-Disposition: %q", got)
	}
	if got := resp.Header.Get("Content-Type"); !strings.HasPrefix(got, "text/csv") {
		t.Errorf("Content-Type: %q", got)
	}
	// A token is used once.
	if resp, _ := download(t, base, token); resp.StatusCode != 404 {
		t.Errorf("second download: %d, want 404", resp.StatusCode)
	}

	_, token = startExport(t, base, `{"format":"jsonl","query":{}}`)
	if _, body := download(t, base, token); body != "{\"id\":1,\"name\":\"alice\",\"qty\":3}\n{\"id\":2,\"name\":\"bob\",\"qty\":null}\n{\"id\":3,\"name\":\"carol\",\"qty\":5}\n" {
		t.Errorf("jsonl: %q", body)
	}

	for _, bad := range []string{`{"format":"xlsx","query":{}}`, `{"format":"csv","query":{"columns":["nope"]}}`, `{"format":"csv","query":{"sorts":[{"column":"nope"}]}}`} {
		if code, _ := startExport(t, base, bad); code != 400 {
			t.Errorf("%s: %d, want 400", bad, code)
		}
	}
}

func TestExportTokensExpire(t *testing.T) {
	var x exports
	now := time.Now()
	token := x.add(pendingExport{expires: now.Add(exportTTL)}, now)
	if _, ok := x.take(token, now.Add(exportTTL+time.Second)); ok {
		t.Error("an expired token was taken")
	}
	old := x.add(pendingExport{expires: now.Add(-time.Second)}, now)
	x.add(pendingExport{expires: now.Add(exportTTL)}, now) // drops expired ones
	if _, ok := x.pending[old]; ok {
		t.Error("an expired token was kept")
	}
}
