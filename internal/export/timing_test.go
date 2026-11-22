package export

import (
	"io"
	"os"
	"testing"
	"time"

	"github.com/babarot/xxsv/internal/table"
)

// TestExportTiming measures writing every row of the CSV in XXSV_BENCH_FILE,
// such as the 1M rows of "go run ./scripts/gendata 1000000 data.csv", in
// each format. It is skipped unless the variable is set.
func TestExportTiming(t *testing.T) {
	path := os.Getenv("XXSV_BENCH_FILE")
	if path == "" {
		t.Skip("XXSV_BENCH_FILE not set")
	}
	tb, err := table.LoadFile(path, table.Options{})
	if err != nil {
		t.Fatal(err)
	}
	rows, cols := all(tb)
	for _, f := range []Format{CSV, TSV, JSONL} {
		start := time.Now()
		var n countWriter
		if err := Write(&n, tb, rows, cols, f); err != nil {
			t.Fatal(err)
		}
		t.Logf("%-5s %d rows, %4d MB in %6.0f ms", f, len(rows), n>>20, float64(time.Since(start).Microseconds())/1000)
	}
}

type countWriter int64

func (c *countWriter) Write(p []byte) (int, error) {
	*c += countWriter(len(p))
	return len(p), nil
}

var _ io.Writer = (*countWriter)(nil)
