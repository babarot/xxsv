package table

import (
	"os"
	"testing"
	"time"
)

// TestLoadTiming loads the file in XXSV_BENCH_FILE and reports the time of
// each step. It is skipped unless the variable is set.
func TestLoadTiming(t *testing.T) {
	path := os.Getenv("XXSV_BENCH_FILE")
	if path == "" {
		t.Skip("XXSV_BENCH_FILE not set")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	n := 0
	lf := jsonLines
	if formatFromExt(path) == LTSV {
		lf = ltsvLines
	}
	eachLine(data, lf.trim, func(line []byte) {
		if _, err := lf.parse(line); err == nil {
			n++
		}
	})
	t.Logf("one parse pass: %v (%d records)", time.Since(start), n)

	start = time.Now()
	tb, err := LoadFile(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("LoadFile: %v (%d rows, %d cols)", time.Since(start), tb.Rows, len(tb.Columns))
	start = time.Now()
	st := tb.Stats()
	t.Logf("Stats: %v", time.Since(start))
	var j, folded int
	for _, s := range st {
		if s.Type == JSON {
			j++
		}
	}
	folded = tb.FoldedKeys
	t.Logf("json columns %d, folded keys %d, skipped lines %d", j, folded, tb.SkippedLines)
}
