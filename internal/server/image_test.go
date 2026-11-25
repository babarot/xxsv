package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func pngBytes(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewGray(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestImageAPI(t *testing.T) {
	top := t.TempDir()
	dir := filepath.Join(top, "data")
	img := pngBytes(t)
	write := func(path string, b []byte) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(dir, "img", "a b.png"), img)
	write(filepath.Join(dir, "noext"), img)
	write(filepath.Join(dir, "tiny.png"), []byte("x"))
	write(filepath.Join(dir, "empty.png"), nil)
	write(filepath.Join(dir, "secret.png"), []byte(strings.Repeat("password\n", 100)))
	write(filepath.Join(dir, "x.svg"), []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`))
	write(filepath.Join(dir, "dir.png", "x"), nil)
	write(filepath.Join(top, "out.png"), img)

	cases := []struct {
		value string
		want  int
	}{
		{"img/a b.png", 200},
		{"./img/a b.png", 200},
		{"img/../img/a b.png", 200},
		{" img/a b.png ", 200},
		{"noext", 200}, // the content decides, not the name
		{filepath.Join(dir, "img", "a b.png"), 200},
		{"data:image/png;base64," + base64.StdEncoding.EncodeToString(img), 200},
		{"data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("<html><script>")), 204},
		{"data:image/png;base64,!!", 204},
		{"data:image/png,x", 204},
		{"", 204},
		{".", 204},
		{"missing.png", 204},
		{"tiny.png", 204},
		{"empty.png", 204},
		{"secret.png", 204},
		{"x.svg", 204},
		{"dir.png", 204},
		{"../out.png", 204},
		{"img/../../out.png", 204},
		{filepath.Join(top, "out.png"), 200}, // an absolute path may be anywhere
		{dir + "/../out.png", 200},
		{dir, 204},
		{filepath.Join(dir, "secret.png"), 204},
		{filepath.Join(dir, "x.svg"), 204},
		{"~/a.png", 204},
		{"/" + filepath.Join(dir, "noext"), 204}, // starts with //
		{`\\host\share\a.png`, 204},
		{"/etc/passwd", 204},
		{"https://example.com/a.png", 204},
		{"//example.com/a.png", 204},
		{"file://" + filepath.Join(dir, "noext"), 204},
		{"a\x00.png", 204},
	}
	if err := os.Symlink(filepath.Join("..", "out.png"), filepath.Join(dir, "link-out.png")); err == nil {
		_ = os.Symlink("noext", filepath.Join(dir, "link-in.png"))
		_ = os.Symlink("..", filepath.Join(dir, "up"))
		cases = append(cases, []struct {
			value string
			want  int
		}{{"link-out.png", 204}, {"link-in.png", 200}, {"up/out.png", 204}}...)
	}

	// A named pipe must not make the request wait.
	fifo := filepath.Join(dir, "pipe.png")
	if exec.Command("mkfifo", fifo).Run() == nil {
		cases = append(cases, []struct {
			value string
			want  int
		}{{"pipe.png", 204}, {fifo, 204}}...)
	}

	var lines strings.Builder
	for _, c := range cases {
		v, _ := json.Marshal(c.value)
		fmt.Fprintf(&lines, "{\"k\":1,\"path\":%s}\n", v)
	}
	path := filepath.Join(dir, "t.jsonl")
	writeFile(t, path, lines.String())
	_, base := start(t, path)

	for i, c := range cases {
		resp, err := http.Get(fmt.Sprintf("%s/api/image?gen=1&row=%d&col=1", base, i))
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != c.want {
			t.Errorf("%q: %d, want %d", c.value, resp.StatusCode, c.want)
		}
		if resp.Header.Get("Cross-Origin-Resource-Policy") != "same-origin" {
			t.Errorf("%q: other sites may embed the response", c.value)
		}
		if c.want == 200 && (resp.Header.Get("Content-Type") != "image/png" || !bytes.Equal(body, img)) {
			t.Errorf("%q: %s, %d bytes", c.value, resp.Header.Get("Content-Type"), len(body))
		}
	}
	for q, want := range map[string]int{"gen=2&row=0&col=1": 409, "gen=1&row=999&col=1": 404, "gen=1&row=0&col=9": 404, "gen=1&row=-1&col=1": 404, "gen=1&row=0": 400} {
		if code := getJSON(t, base+"/api/image?"+q, nil); code != want {
			t.Errorf("%s: %d, want %d", q, code, want)
		}
	}
}
