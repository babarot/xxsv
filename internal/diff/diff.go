// Package diff finds what changed between two loads of a file: the cells
// that changed, the rows that were added and the number of rows removed.
//
// Rows are matched as a sequence, the way git diff matches lines: a row
// inserted or removed in the middle does not make every row below it look
// changed. Each row is reduced to a 64-bit hash of its cells, the common
// head and tail are cut off, and Myers' algorithm runs on what is left.
// Where removed and added rows sit together, they are paired in order and
// compared cell by cell.
package diff

import (
	"hash/maphash"
	"slices"
	"sort"

	"github.com/babarot/xxsv/internal/table"
)

// DefaultMaxEdits is the default limit on the number of rows added and
// removed in the part of the file Myers' algorithm runs on.
const DefaultMaxEdits = 2000

// Hashes are the row hashes of one table, made from the columns named in
// Columns, in that order.
type Hashes struct {
	Columns []string
	Rows    []uint64
}

// Changes is what changed from one load of a file to the next. Rows and
// columns are positions in the new table.
type Changes struct {
	// From is the generation the new table was compared with.
	From           uint64   `json:"from"`
	ChangedRows    int      `json:"changedRows"`
	ChangedCells   int      `json:"changedCells"`
	AddedRows      int      `json:"addedRows"`
	RemovedRows    int      `json:"removedRows"`
	AddedColumns   []string `json:"addedColumns"`
	RemovedColumns []string `json:"removedColumns"`
	// TooMany is set when the rows changed too much to be matched (the
	// file was sorted, for example). Nothing is marked then, and the row
	// counts are zero.
	TooMany bool `json:"tooMany"`

	cells map[int32][]int32 // row -> changed columns, ascending
	added [][2]int32        // added rows as [start, end), ascending
}

// Row returns the changed columns of a row of the new table, and whether
// the row was added.
func (c *Changes) Row(row int) (cols []int32, added bool) {
	if c == nil {
		return nil, false
	}
	r := int32(row)
	i := sort.Search(len(c.added), func(i int) bool { return c.added[i][1] > r })
	if i < len(c.added) && c.added[i][0] <= r {
		return nil, true
	}
	return c.cells[r], false
}

// Hash returns the hashes of every row of t over all its columns.
func Hash(seed maphash.Seed, t *table.Table) *Hashes {
	names := make([]string, len(t.Columns))
	for i, c := range t.Columns {
		names[i] = c.Name
	}
	return &Hashes{Columns: names, Rows: hashRows(seed, t, allColumns(t))}
}

// Compare compares newT with oldT. oldH are oldT's hashes from an earlier
// Compare or Hash, made with the same seed; they are used when they cover
// the columns compared, and made again otherwise. It returns the changes
// and newT's hashes over all its columns, for the next Compare. maxEdits
// <= 0 means DefaultMaxEdits.
func Compare(seed maphash.Seed, oldT *table.Table, oldH *Hashes, newT *table.Table, from uint64, maxEdits int) (*Changes, *Hashes) {
	if maxEdits <= 0 {
		maxEdits = DefaultMaxEdits
	}
	ch := &Changes{From: from, AddedColumns: []string{}, RemovedColumns: []string{}}

	// Match the columns by name. Names are unique within a table.
	oldIdx := make(map[string]int, len(oldT.Columns))
	for i, c := range oldT.Columns {
		oldIdx[c.Name] = i
	}
	var pairs [][2]int // [old column, new column], in the new table's order
	var names []string
	seen := make(map[string]bool, len(newT.Columns))
	for j, c := range newT.Columns {
		seen[c.Name] = true
		if i, ok := oldIdx[c.Name]; ok {
			pairs = append(pairs, [2]int{i, j})
			names = append(names, c.Name)
		} else {
			ch.AddedColumns = append(ch.AddedColumns, c.Name)
		}
	}
	for _, c := range oldT.Columns {
		if !seen[c.Name] {
			ch.RemovedColumns = append(ch.RemovedColumns, c.Name)
		}
	}

	// The new table's hashes over all its columns are kept for the next
	// Compare. When columns were added, the rows are compared over the
	// common columns only, which needs a second set of hashes.
	newFull := Hash(seed, newT)
	var a, b []uint64
	if oldH != nil && slices.Equal(oldH.Columns, names) && len(oldH.Rows) == oldT.Rows {
		a = oldH.Rows
	} else {
		a = hashRows(seed, oldT, column(pairs, 0))
	}
	if slices.Equal(newFull.Columns, names) {
		b = newFull.Rows
	} else {
		b = hashRows(seed, newT, column(pairs, 1))
	}

	if len(pairs) == 0 {
		// No column in common: rows cannot be matched.
		ch.TooMany = oldT.Rows > 0 && newT.Rows > 0
		if !ch.TooMany {
			ch.addRange(0, newT.Rows)
			ch.RemovedRows = oldT.Rows
		}
		return ch, newFull
	}

	// Cut off the common head and tail.
	head := 0
	for head < len(a) && head < len(b) && a[head] == b[head] {
		head++
	}
	tail := 0
	for tail < len(a)-head && tail < len(b)-head && a[len(a)-1-tail] == b[len(b)-1-tail] {
		tail++
	}
	am, bm := a[head:len(a)-tail], b[head:len(b)-tail]

	var snakes []snake
	if len(am) > 0 && len(bm) > 0 {
		var ok bool
		snakes, ok = myers(am, bm, maxEdits)
		if !ok {
			ch.TooMany = true
			return ch, newFull
		}
	}

	// Walk the hunks between the matched runs.
	x, y := 0, 0
	for _, s := range append(snakes, snake{len(am), len(bm), 0}) {
		ch.hunk(oldT, newT, pairs, head+x, head+s.x, head+y, head+s.y)
		x, y = s.x+s.n, s.y+s.n
	}
	return ch, newFull
}

// hunk records the rows between two matched runs: old rows [o0, o1) were
// replaced by new rows [n0, n1). Rows are paired in order and compared
// cell by cell; the rest are added or removed. When one side has more
// rows, the pairs are aligned to the top or to the bottom of the hunk,
// whichever changes fewer cells, so a row inserted just above an edited
// row is not taken for the edited one.
func (ch *Changes) hunk(oldT, newT *table.Table, pairs [][2]int, o0, o1, n0, n1 int) {
	p := min(o1-o0, n1-n0)
	diffCells := func(or, nr int) int {
		k := 0
		for _, pc := range pairs {
			if oldT.Columns[pc[0]].Raw[or] != newT.Columns[pc[1]].Raw[nr] {
				k++
			}
		}
		return k
	}
	// Skip rows at the top of the longer side: 0 aligns to the top,
	// the difference in length aligns to the bottom.
	oSkip, nSkip := 0, 0
	if extra := (o1 - o0) + (n1 - n0) - 2*p; extra > 0 && p > 0 {
		top, bottom := 0, 0
		bo, bn := o1-o0-p, n1-n0-p
		for i := range p {
			top += diffCells(o0+i, n0+i)
			bottom += diffCells(o0+bo+i, n0+bn+i)
		}
		if bottom < top {
			oSkip, nSkip = bo, bn
		}
	}
	ch.addRange(n0, n0+nSkip)
	for i := range p {
		or, nr := o0+oSkip+i, n0+nSkip+i
		var cols []int32
		for _, pc := range pairs {
			if oldT.Columns[pc[0]].Raw[or] != newT.Columns[pc[1]].Raw[nr] {
				cols = append(cols, int32(pc[1]))
			}
		}
		if len(cols) > 0 {
			if ch.cells == nil {
				ch.cells = map[int32][]int32{}
			}
			ch.cells[int32(nr)] = cols
			ch.ChangedRows++
			ch.ChangedCells += len(cols)
		}
	}
	ch.addRange(n0+nSkip+p, n1)
	ch.RemovedRows += (o1 - o0) - p
}

func (ch *Changes) addRange(start, end int) {
	if start >= end {
		return
	}
	ch.AddedRows += end - start
	if n := len(ch.added); n > 0 && ch.added[n-1][1] == int32(start) {
		ch.added[n-1][1] = int32(end)
		return
	}
	ch.added = append(ch.added, [2]int32{int32(start), int32(end)})
}

func allColumns(t *table.Table) []int {
	cols := make([]int, len(t.Columns))
	for i := range cols {
		cols[i] = i
	}
	return cols
}

func column(pairs [][2]int, k int) []int {
	out := make([]int, len(pairs))
	for i, p := range pairs {
		out[i] = p[k]
	}
	return out
}

// hashRows hashes every row of t over the given columns, in that order.
// Each cell is hashed on its own and the cell hashes are combined in
// order, so "a","bc" and "ab","c" hash differently. It goes column by
// column, which reads each column's cells in order.
func hashRows(seed maphash.Seed, t *table.Table, cols []int) []uint64 {
	rows := make([]uint64, t.Rows)
	for _, ci := range cols {
		raw := t.Columns[ci].Raw
		for i := range rows {
			rows[i] = rows[i]*0x9E3779B97F4A7C15 + maphash.String(seed, raw[i])
		}
	}
	return rows
}

// snake is a run of n matching rows starting at a[x] and b[y].
type snake struct{ x, y, n int }

// myers returns the runs of matching rows of a shortest edit script from a
// to b, in order, or false when the script needs more than maxEdits rows
// added and removed. It keeps the furthest point of every diagonal for
// each step, about maxEdits² int32s at most.
func myers(a, b []uint64, maxEdits int) ([]snake, bool) {
	n, m := len(a), len(b)
	limit := min(maxEdits, n+m)
	off := limit + 1
	v := make([]int32, 2*limit+3)
	var trace [][]int32 // trace[d][k+d+1] is v[k] before step d
	for d := 0; d <= limit; d++ {
		trace = append(trace, slices.Clone(v[off-d-1:off+d+2]))
		for k := -d; k <= d; k += 2 {
			var x int
			if k == -d || (k != d && v[off+k-1] < v[off+k+1]) {
				x = int(v[off+k+1])
			} else {
				x = int(v[off+k-1]) + 1
			}
			y := x - k
			for x < n && y < m && a[x] == b[y] {
				x++
				y++
			}
			v[off+k] = int32(x)
			if x >= n && y >= m {
				return backtrack(trace, n, m), true
			}
		}
	}
	return nil, false
}

func backtrack(trace [][]int32, x, y int) []snake {
	var out []snake
	for d := len(trace) - 1; d >= 0; d-- {
		v := trace[d]
		at := func(k int) int { return int(v[k+d+1]) }
		k := x - y
		var pk int
		if k == -d || (k != d && at(k-1) < at(k+1)) {
			pk = k + 1
		} else {
			pk = k - 1
		}
		px := at(pk)
		py := px - pk
		// The diagonal run that ends at (x, y) starts after the move from
		// (px, py): one row down or right of it.
		sx, sy := px, py
		if d > 0 {
			if pk == k+1 {
				sy++ // inserted b[py]
			} else {
				sx++ // removed a[px]
			}
		} else {
			sx, sy = 0, 0
		}
		if run := x - sx; run > 0 {
			out = append(out, snake{sx, sy, run})
		}
		x, y = px, py
	}
	slices.Reverse(out)
	return out
}
