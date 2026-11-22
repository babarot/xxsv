package query

import (
	"os"
	"syscall"
	"testing"
	"time"

	"github.com/babarot/xxsv/internal/table"
)

func cpuTime() time.Duration {
	var ru syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
}

// TestQueryTiming measures queries on the CSV in XXSV_BENCH_FILE, such as
// the 1M rows of "go run ./scripts/gendata 1000000 data.csv". It is
// skipped unless the variable is set.
func TestQueryTiming(t *testing.T) {
	path := os.Getenv("XXSV_BENCH_FILE")
	if path == "" {
		t.Skip("XXSV_BENCH_FILE not set")
	}
	tb, err := table.LoadFile(path, table.Options{})
	if err != nil {
		t.Fatal(err)
	}
	e := New(tb)
	run := func(label string, q Query) {
		start, cpu := time.Now(), cpuTime()
		res, err := e.Run(q)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("%-40s wall %7.1f ms  cpu %7.1f ms  total %d", label,
			float64(time.Since(start).Microseconds())/1000, float64((cpuTime()-cpu).Microseconds())/1000, res.Total)
	}
	run("sort qty (integer)", Query{Sort: &Sort{Column: "qty"}})
	run("sort price desc (number)", Query{Sort: &Sort{Column: "price", Desc: true}})
	run("sort name (string)", Query{Sort: &Sort{Column: "name"}})
	run("sort day (date)", Query{Sort: &Sort{Column: "day"}})
	run("search \"zulu yankee\"", Query{Search: "zulu yankee"})
	run("search \"no-such-text\"", Query{Search: "no-such-text"})
	run("search \"2021-03\"", Query{Search: "2021-03"})
	run("filter range + contains", Query{Filters: []Filter{
		{Column: "price", Op: OpRange, Min: "100", Max: "200"},
		{Column: "category", Op: OpContains, Value: "cat1"},
	}})
	run("search + sort name", Query{Search: "alpha", Sort: &Sort{Column: "name"}})
	run("page from cache (offset 500000)", Query{Search: "alpha", Sort: &Sort{Column: "name"}, Offset: 500000, Limit: 200})
	for _, r := range []struct {
		label string
		q     Query
		rg    Range
	}{
		{"aggregate whole price column", Query{}, Range{R0: 0, R1: 1 << 30, C0: 2, C1: 2}},
		{"aggregate all 10 columns", Query{}, Range{R0: 0, R1: 1 << 30, C0: 0, C1: 9}},
		{"aggregate sorted, cached order", Query{Sort: &Sort{Column: "price"}}, Range{R0: 0, R1: 1 << 30, C0: 1, C1: 2}},
	} {
		_, _ = e.Aggregate(r.q, Range{}) // warm the order cache, as scrolling would
		start, cpu := time.Now(), cpuTime()
		a, err := e.Aggregate(r.q, r.rg)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("%-40s wall %7.1f ms  cpu %7.1f ms  count %d", r.label,
			float64(time.Since(start).Microseconds())/1000, float64((cpuTime()-cpu).Microseconds())/1000, a.Count)
	}
}
