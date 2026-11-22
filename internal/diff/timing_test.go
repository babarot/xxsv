package diff

import (
	"hash/maphash"
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

// edited returns a copy of t whose rows are rebuilt by f from the row
// numbers of t; a negative number makes a new row.
func edited(t *table.Table, rows []int, change func(row, col int) bool) *table.Table {
	out := *t
	out.Columns = make([]*table.Column, len(t.Columns))
	for ci, c := range t.Columns {
		nc := *c
		nc.Raw = make([]string, len(rows))
		for i, r := range rows {
			switch {
			case r < 0:
				nc.Raw[i] = "new"
			case change(r, ci):
				nc.Raw[i] = c.Raw[r] + "!"
			default:
				nc.Raw[i] = c.Raw[r]
			}
		}
		out.Columns[ci] = &nc
	}
	out.Rows = len(rows)
	return &out
}

// TestCompareTiming measures Compare on the CSV in XXSV_BENCH_FILE, such as
// the 1M rows of "go run ./scripts/gendata 1000000 data.csv". It is
// skipped unless the variable is set.
func TestCompareTiming(t *testing.T) {
	path := os.Getenv("XXSV_BENCH_FILE")
	if path == "" {
		t.Skip("XXSV_BENCH_FILE not set")
	}
	base, err := table.LoadFile(path, table.Options{})
	if err != nil {
		t.Fatal(err)
	}
	n := base.Rows
	seed := maphash.MakeSeed()

	c0, w0 := cpuTime(), time.Now()
	h := Hash(seed, base)
	t.Logf("hash %d rows x %d columns: cpu %v, wall %v", n, len(base.Columns), cpuTime()-c0, time.Since(w0))

	ids := func(f func(add func(int))) []int {
		rows := make([]int, 0, n+1000)
		f(func(r int) { rows = append(rows, r) })
		return rows
	}
	every := func(k int) func(add func(int)) {
		return func(add func(int)) {
			for r := range n {
				add(r)
				if r%(n/k) == n/k/2 {
					add(-1)
				}
			}
		}
	}
	all := ids(func(add func(int)) {
		for r := range n {
			add(r)
		}
	})
	cases := []struct {
		name string
		tb   *table.Table
		max  int
	}{
		{"same", edited(base, all, func(int, int) bool { return false }), 0},
		{"edit 5 scattered rows", edited(base, all, func(r, c int) bool { return c == 1 && r%(n/5) == 7 }), 0},
		{"edit 500 scattered rows", edited(base, all, func(r, c int) bool { return c == 1 && r%(n/500) == 7 }), 0},
		{"edit 900 scattered rows", edited(base, all, func(r, c int) bool { return c == 1 && r%(n/900) == 7 }), 0},
		{"insert 10 scattered rows", edited(base, ids(every(10)), func(int, int) bool { return false }), 0},
		{"insert 1000 scattered rows", edited(base, ids(every(1000)), func(int, int) bool { return false }), 0},
		{"append 1000 rows", edited(base, append(append([]int{}, all...), make([]int, 1000)...), func(int, int) bool { return false }), 0},
		{"edit 1100 scattered rows (too many)", edited(base, all, func(r, c int) bool { return c == 1 && r%(n/1100) == 7 }), 0},
	}
	for _, tc := range cases {
		c0, w0 := cpuTime(), time.Now()
		ch, _ := Compare(seed, base, h, tc.tb, 1, tc.max)
		t.Logf("%-36s cpu %8v wall %8v  changed %d rows, %d cells, added %d, removed %d, tooMany %v",
			tc.name, (cpuTime() - c0).Round(time.Millisecond), time.Since(w0).Round(time.Millisecond),
			ch.ChangedRows, ch.ChangedCells, ch.AddedRows, ch.RemovedRows, ch.TooMany)
	}
}
