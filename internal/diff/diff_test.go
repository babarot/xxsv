package diff

import (
	"hash/maphash"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"

	"github.com/babarot/xxsv/internal/table"
)

func load(t *testing.T, csv string) *table.Table {
	t.Helper()
	tb, err := table.LoadDelimited(strings.NewReader(csv), table.CSV, table.Options{Delimiter: ',', Header: table.HeaderYes})
	if err != nil {
		t.Fatal(err)
	}
	return tb
}

// marks lists the changes row by row: "+" for an added row, the changed
// column numbers, or "" for an unchanged row.
func marks(ch *Changes, rows int) []string {
	out := make([]string, rows)
	for i := range out {
		cols, added := ch.Row(i)
		switch {
		case added:
			out[i] = "+"
		case len(cols) > 0:
			var b strings.Builder
			for _, c := range cols {
				b.WriteByte(byte('0' + c))
			}
			out[i] = b.String()
		}
	}
	return out
}

func compare(t *testing.T, before, after string) (*Changes, []string) {
	t.Helper()
	seed := maphash.MakeSeed()
	o, n := load(t, before), load(t, after)
	ch, h := Compare(seed, o, Hash(seed, o), n, 1, 0)
	if len(h.Rows) != n.Rows || len(h.Columns) != len(n.Columns) {
		t.Fatalf("hashes cover %d rows, %d columns", len(h.Rows), len(h.Columns))
	}
	if got := o.Rows - ch.RemovedRows + ch.AddedRows; !ch.TooMany && got != n.Rows {
		t.Errorf("%d rows - %d removed + %d added = %d, want %d", o.Rows, ch.RemovedRows, ch.AddedRows, got, n.Rows)
	}
	return ch, marks(ch, n.Rows)
}

func TestCompare(t *testing.T) {
	const base = "id,name,qty\n1,a,10\n2,b,20\n3,c,30\n4,d,40\n"
	tests := []struct {
		name    string
		after   string
		want    []string
		removed int
	}{
		{"same", base, []string{"", "", "", ""}, 0},
		{"append", base + "5,e,50\n6,f,60\n", []string{"", "", "", "", "+", "+"}, 0},
		{"insert in the middle", "id,name,qty\n1,a,10\n2,b,20\nx,y,z\n3,c,30\n4,d,40\n", []string{"", "", "+", "", ""}, 0},
		{"insert at the top", "id,name,qty\n0,z,0\n1,a,10\n2,b,20\n3,c,30\n4,d,40\n", []string{"+", "", "", "", ""}, 0},
		{"remove in the middle", "id,name,qty\n1,a,10\n3,c,30\n4,d,40\n", []string{"", "", ""}, 1},
		{"edit cells", "id,name,qty\n1,a,10\n2,B,20\n3,c,33\n4,d,40\n", []string{"", "1", "2", ""}, 0},
		{"edit and insert", "id,name,qty\n1,A,10\n2,b,20\nn,n,n\n3,c,30\n4,d,40\n", []string{"1", "", "+", "", ""}, 0},
		{"replace two rows with three", "id,name,qty\n1,a,10\n2,B,20\n3,C,30\nx,y,z\n4,d,40\n", []string{"", "1", "1", "+", ""}, 0},
		{"insert above an edited row", "id,name,qty\n1,a,10\nx,y,z\n2,B,20\n3,c,30\n4,d,40\n", []string{"", "+", "1", "", ""}, 0},
		{"insert below an edited row", "id,name,qty\n1,a,10\n2,B,20\nx,y,z\n3,c,30\n4,d,40\n", []string{"", "1", "+", "", ""}, 0},
		{"remove above an edited row", "id,name,qty\n1,a,10\n3,C,30\n4,d,40\n", []string{"", "1", ""}, 1},
		{"replace two rows with one", "id,name,qty\n1,a,10\n2,B,20\n4,d,40\n", []string{"", "1", ""}, 1},
		{"empty after", "id,name,qty\n", []string{}, 4},
		{"reorder columns", "qty,id,name\n10,1,a\n20,2,b\n30,3,c\n40,4,d\n", []string{"", "", "", ""}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ch, got := compare(t, base, tt.after)
			if !slices.Equal(got, tt.want) || ch.RemovedRows != tt.removed {
				t.Errorf("marks %q, removed %d; want %q, removed %d", got, ch.RemovedRows, tt.want, tt.removed)
			}
		})
	}
}

func TestCompareRepeatedRows(t *testing.T) {
	ch, got := compare(t, "v\na\na\na\n", "v\na\na\na\na\n")
	if !slices.Equal(got, []string{"", "", "", "+"}) || ch.AddedRows != 1 {
		t.Errorf("marks %q, added %d", got, ch.AddedRows)
	}
}

func TestCompareEmptyBefore(t *testing.T) {
	ch, got := compare(t, "a,b\n", "a,b\n1,2\n")
	if !slices.Equal(got, []string{"+"}) || ch.AddedRows != 1 {
		t.Errorf("marks %q, added %d", got, ch.AddedRows)
	}
}

func TestCompareColumns(t *testing.T) {
	ch, got := compare(t, "a,b\n1,2\n3,4\n", "a,c\n1,x\n5,y\n")
	if !slices.Equal(ch.AddedColumns, []string{"c"}) || !slices.Equal(ch.RemovedColumns, []string{"b"}) {
		t.Errorf("added %q, removed %q", ch.AddedColumns, ch.RemovedColumns)
	}
	// Only column a is compared: row 0 is the same, row 1 changed in a.
	if !slices.Equal(got, []string{"", "0"}) {
		t.Errorf("marks %q", got)
	}
}

func TestCompareNoCommonColumns(t *testing.T) {
	ch, got := compare(t, "a\n1\n", "b\n1\n")
	if !ch.TooMany || !slices.Equal(got, []string{""}) {
		t.Errorf("tooMany %v, marks %q", ch.TooMany, got)
	}
}

// A column added in one save, then a save that changes nothing, then an
// edit of the added column only: the second compare must reuse hashes over
// all the columns, not the common ones of the first compare, or every row
// would look changed.
func TestCompareAfterAddingAColumn(t *testing.T) {
	seed := maphash.MakeSeed()
	g1 := load(t, "a\n1\n2\n3\n")
	g2 := load(t, "a,b\n1,x\n2,y\n3,z\n")
	g3 := load(t, "a,b\n1,x\n2,y\n3,z\n")
	g4 := load(t, "a,b\n1,x\n2,Y\n3,z\n")

	ch, h := Compare(seed, g1, Hash(seed, g1), g2, 1, 0)
	if !slices.Equal(marks(ch, 3), []string{"", "", ""}) || !slices.Equal(ch.AddedColumns, []string{"b"}) {
		t.Fatalf("g1 -> g2: marks %q, added columns %q", marks(ch, 3), ch.AddedColumns)
	}
	ch, h = Compare(seed, g2, h, g3, 2, 1) // one edit at most: a mismatch everywhere would be too many
	if ch.TooMany || !slices.Equal(marks(ch, 3), []string{"", "", ""}) {
		t.Fatalf("g2 -> g3: tooMany %v, marks %q", ch.TooMany, marks(ch, 3))
	}
	ch, _ = Compare(seed, g3, h, g4, 3, 0)
	if !slices.Equal(marks(ch, 3), []string{"", "1", ""}) {
		t.Fatalf("g3 -> g4: marks %q", marks(ch, 3))
	}
}

func TestCompareTooMany(t *testing.T) {
	var before, after strings.Builder
	before.WriteString("v\n")
	after.WriteString("v\n")
	for i := range 100 {
		before.WriteString(strings.Repeat("a", i+1) + "\n")
		after.WriteString(strings.Repeat("a", 100-i) + "\n") // reversed
	}
	seed := maphash.MakeSeed()
	o, n := load(t, before.String()), load(t, after.String())
	ch, _ := Compare(seed, o, nil, n, 1, 20)
	if !ch.TooMany || ch.AddedRows != 0 || ch.ChangedRows != 0 {
		t.Errorf("tooMany %v, added %d, changed %d", ch.TooMany, ch.AddedRows, ch.ChangedRows)
	}
	if cols, added := ch.Row(5); cols != nil || added {
		t.Errorf("row 5 marked: %v %v", cols, added)
	}
}

// A long append is not subject to the edit limit: after the common head,
// one side is empty and Myers' algorithm does not run.
func TestCompareLongAppend(t *testing.T) {
	var b strings.Builder
	b.WriteString("v\n1\n")
	for i := range 5000 {
		b.WriteString(strings.Repeat("x", i%7+1) + "\n")
	}
	seed := maphash.MakeSeed()
	o, n := load(t, "v\n1\n"), load(t, b.String())
	ch, _ := Compare(seed, o, nil, n, 1, 10)
	if ch.TooMany || ch.AddedRows != 5000 || len(ch.added) != 1 {
		t.Errorf("tooMany %v, added %d in %d ranges", ch.TooMany, ch.AddedRows, len(ch.added))
	}
}

// TestMyersIsShortest checks Myers' runs on random sequences: they must
// match, be in order, and leave exactly the edits of a shortest script,
// which a dynamic programming LCS gives.
func TestMyersIsShortest(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for iter := range 2000 {
		a := randSeq(r)
		b := randSeq(r)
		snakes, ok := myers(a, b, len(a)+len(b))
		if len(a) == 0 || len(b) == 0 {
			continue
		}
		if !ok {
			t.Fatalf("%d: no script within n+m", iter)
		}
		matched, x, y := 0, 0, 0
		for _, s := range snakes {
			if s.x < x || s.y < y || s.n <= 0 {
				t.Fatalf("%d: runs out of order: %v", iter, snakes)
			}
			for i := range s.n {
				if a[s.x+i] != b[s.y+i] {
					t.Fatalf("%d: run %v does not match", iter, s)
				}
			}
			matched += s.n
			x, y = s.x+s.n, s.y+s.n
		}
		if want := lcs(a, b); matched != want {
			t.Fatalf("%d: matched %d, LCS is %d (a=%v b=%v)", iter, matched, want, a, b)
		}
	}
}

func randSeq(r *rand.Rand) []uint64 {
	s := make([]uint64, r.IntN(12))
	for i := range s {
		s[i] = uint64(r.IntN(4))
	}
	return s
}

func lcs(a, b []uint64) int {
	dp := make([][]int, len(a)+1)
	for i := range dp {
		dp[i] = make([]int, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else {
				dp[i][j] = max(dp[i+1][j], dp[i][j+1])
			}
		}
	}
	return dp[0][0]
}
