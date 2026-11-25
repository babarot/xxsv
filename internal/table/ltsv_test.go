package table

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func loadL(t *testing.T, text string, opts Options) *Table {
	t.Helper()
	tb, err := LoadLTSV([]byte(text), opts)
	if err != nil {
		t.Fatal(err)
	}
	return tb
}

func TestLTSVColumns(t *testing.T) {
	tb := loadL(t, "\xef\xbb\xbftime:2024-01-02T10:00:00Z\thost:127.0.0.1\tstatus:200\r\n"+
		"\r\n"+
		"status:404\tua:Mozilla/5.0 (X; Y:Z) \thost:::1\treferer:\n"+
		"no label here\tstatus:500\n"+
		":empty label\n"+
		"日本:語\tstatus:201\t", Options{})
	eq(t, "format", tb.Format, LTSV)
	eq(t, "rows", tb.Rows, 3)
	eq(t, "skipped", tb.SkippedLines, 2)
	eq(t, "names in first-seen order", names(tb), []string{"time", "host", "status", "ua", "referer", "日本"})
	eq(t, "types", types(tb), []string{"datetime", "string", "integer", "string", "string", "string"})
	eq(t, "values are found by label", tb.Columns[2].Ints, []int64{200, 404, 201})
	eq(t, "CR stripped", tb.Columns[2].Raw[0], "200")
	eq(t, "colons and spaces are part of a value", tb.Columns[3].Raw[1], "Mozilla/5.0 (X; Y:Z) ")
	eq(t, "a value may start with a colon", tb.Columns[1].Raw[1], "::1")
	eq(t, "absent label is missing", tb.Columns[3].IsMissing(0), true)
	eq(t, "empty value is missing", tb.Columns[4].IsMissing(1), true)
	eq(t, "any text is a label", tb.Columns[5].Raw[2], "語")
}

func TestLTSVKeepsTextAsWritten(t *testing.T) {
	tb := loadL(t, `a:\x22q\x22 \t\\`+"\tb:-\tc:\"x\"\n", Options{})
	eq(t, "escapes", tb.Columns[0].Raw[0], `\x22q\x22 \t\\`)
	eq(t, "dash", tb.Columns[1].HasValue(0), true)
	eq(t, "quotes", tb.Columns[2].Raw[0], `"x"`)
}

func TestLTSVRepeatedLabelKeepsLast(t *testing.T) {
	tb := loadL(t, "a:1\tb:x\ta:2\n", Options{})
	eq(t, "names", names(tb), []string{"a", "b"})
	eq(t, "value", tb.Columns[0].Ints, []int64{2})
}

func TestLTSVFoldsRareLabels(t *testing.T) {
	var b strings.Builder
	for i := range 50 {
		fmt.Fprintf(&b, "id:%d\tk%03d:say \"hi\"\n", i, i)
	}
	tb := loadL(t, b.String(), Options{MaxColumns: 3})
	eq(t, "names", names(tb), []string{"id", "k000", OtherKeysColumn})
	eq(t, "folded", tb.FoldedKeys, 49)
	eq(t, "type", tb.Columns[2].Type, JSON)
	eq(t, "folded values are JSON strings", tb.Columns[2].Raw[5], `{"k005":"say \"hi\""}`)
}

func TestLTSVEmpty(t *testing.T) {
	tb := loadL(t, "\n \n", Options{})
	eq(t, "rows", tb.Rows, 0)
	eq(t, "columns", len(tb.Columns), 0)
}

func TestLooksLikeLTSV(t *testing.T) {
	long := strings.Repeat("x", 100<<10)
	for text, want := range map[string]bool{
		"a:1\tb:2\n": true,
		"a:1\tb:2":   true,
		"\xef\xbb\xbf\r\na:1\tb:2\r\nb:\ta:x:y\t":       true,
		"time:[10/Oct/2000:13:55:36 -0700]\thost:::1\n": true,
		"a:1\tb:" + long:             true, // cut inside the last field
		"a:1\tb:2\tc:" + long:        true,
		"a:1\tb:2\n" + long:          true, // a later line is cut
		"a:1\tb:2\tlabel" + long:     true, // cut inside a label
		"":                           false,
		"\n\n":                       false,
		"a:1\n":                      false, // one field says too little
		"note: hello\nto: you\n":     false,
		"a\tb\n1\t2\n":               false, // TSV
		"a\tb\na:1\tb:2\n":           false, // TSV with a header
		"a:1\tb:2\nx\ty\n":           false,
		"a:1\tb:2\nx\ty\na:3\tb:4\n": true,  // a broken line
		"x\ty\na:1\tb:2\na:3\tb:4\n": false, // a row of column names

		"12:30\t13:45\n":                        false, // times of day
		"2024-01-02T10:00:00Z\tx:1\n":           false,
		"https://a.example\thttp://b.example\n": false,
		"a:1\ta:2\n":                            false,
		"a:1,b:2\n":                             false,
		"a b:1\tc:2\n":                          false,
	} {
		if got := looksLikeLTSV(bufio.NewReaderSize(strings.NewReader(text), 1<<20)); got != want {
			t.Errorf("%.60q: %v, want %v", text, got, want)
		}
	}
}

func TestLoadFileDetectsLTSV(t *testing.T) {
	dir := t.TempDir()
	const text = "a:1\tb:x\nb:y\ta:2\n"
	for name, want := range map[string]Format{
		"x.ltsv": LTSV, "x.LTSV": LTSV, "access.log": LTSV, "access_log": LTSV, // the content decides
		"x.tsv": TSV, "x.csv": TSV, // the extension decides
	} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
		tb, err := LoadFile(path, Options{})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, name, tb.Format, want)
		if want == LTSV {
			eq(t, name+" rows", tb.Rows, 2)
		}
	}
	// Asking for a delimiter or a header asks for TSV.
	for _, opts := range []Options{{Delimiter: '\t'}, {Header: HeaderNo}, {Header: HeaderYes}} {
		tb, err := LoadFile(filepath.Join(dir, "access.log"), opts)
		if err != nil {
			t.Fatal(err)
		}
		eq(t, fmt.Sprint(opts), tb.Format, TSV)
	}
}
