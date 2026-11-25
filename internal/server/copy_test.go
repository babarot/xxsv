package server

import (
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

func TestCopyAPI(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.jsonl")
	long := strings.Repeat("x", 2000)
	writeFile(t, path, `{"n":3,"s":"a\tb","j":{"k":"v"}}
{"n":1,"s":"\"q\" r","j":{"k":1}}
{"n":2,"s":"`+long+`","j":null}
`)
	_, base := start(t, path)
	post := func(body string) (int, string) {
		t.Helper()
		resp, err := http.Post(base+"/api/copy", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	for _, c := range []struct{ name, rest, want string }{
		{"one cell is bare", `"r0":0,"r1":0,"c0":1,"c1":1`, "a\tb"},
		{"a long cell is whole", `"r0":2,"r1":2,"c0":1,"c1":1`, long},
		{"a missing cell is empty", `"r0":2,"r1":2,"c0":2,"c1":2`, ""},
		{"a range", `"r0":0,"r1":1,"c0":0,"c1":2`, "3\t\"a\tb\"\t{\"k\":\"v\"}\n1\t\"\"\"q\"\" r\"\t{\"k\":1}"},
		{"a column", `"r0":0,"r1":2,"c0":0,"c1":0`, "3\n1\n2"},
		{"the view's order and columns", `"sorts":[{"column":"n"}],"columns":["j","n"],"r0":0,"r1":2,"c0":0,"c1":1`, "{\"k\":1}\t1\n\t2\n{\"k\":\"v\"}\t3"},
	} {
		if code, got := post(`{"generation":1,` + c.rest + `}`); code != 200 || got != c.want {
			t.Errorf("%s: %d %q, want %q", c.name, code, got, c.want)
		}
	}
	for body, want := range map[string]int{
		`{"generation":2,"r0":0,"r1":0,"c0":0,"c1":0}`:                            409,
		`{"generation":1,"r0":0,"r1":3,"c0":0,"c1":0}`:                            400,
		`{"generation":1,"r0":-1,"r1":0,"c0":0,"c1":0}`:                           400,
		`{"generation":1,"r0":0,"r1":0,"c0":2,"c1":1}`:                            400,
		`{"generation":1,"columns":["nope"],"r0":0,"r1":0,"c0":0,"c1":0}`:         400,
		`{"generation":1,"search":"no match at all","r0":0,"r1":0,"c0":0,"c1":0}`: 400,
		`{"generation":1,"unknown":1}`:                                            400,
	} {
		if code, _ := post(body); code != want {
			t.Errorf("%s: %d, want %d", body, code, want)
		}
	}
}

func TestCopyLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.csv")
	cell := strings.Repeat("x", 1<<20)
	var b strings.Builder
	b.WriteString("s\n")
	for range 17 {
		fmt.Fprintln(&b, cell)
	}
	writeFile(t, path, b.String())
	_, base := start(t, path)
	for r1, want := range map[int]int{14: 200, 16: 413} {
		resp, err := http.Post(base+"/api/copy", "application/json", strings.NewReader(fmt.Sprintf(`{"generation":1,"r0":0,"r1":%d,"c0":0,"c1":0}`, r1)))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("rows 0-%d: %d, want %d", r1, resp.StatusCode, want)
		}
	}
}
