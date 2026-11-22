package query

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/babarot/xxsv/internal/table"
)

const sample = `id,name,score,day,ok,note
1,alice,3.5,2024-01-02,true,Hello World
2,bob,,2024-03-04,false,
3,Carol,1.25,2023-12-31,TRUE,héllo
4,dave,3.5,,false,world peace
5,eve,10,2024-02-29,,
`

func engine(t *testing.T, text string) *Engine {
	t.Helper()
	tb, err := table.LoadDelimited(strings.NewReader(text), table.CSV, table.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return New(tb)
}

func ids(t *testing.T, e *Engine, q Query) []int {
	t.Helper()
	res, err := e.Run(q)
	if err != nil {
		t.Fatal(err)
	}
	return res.RowIDs
}

func eq[T any](t *testing.T, label string, got, want T) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: got %v, want %v", label, got, want)
	}
}

func TestSearch(t *testing.T) {
	e := engine(t, sample)
	eq(t, "ASCII case-insensitive", ids(t, e, Query{Search: "WORLD"}), []int{0, 3})
	eq(t, "across columns", ids(t, e, Query{Search: "carol"}), []int{2})
	eq(t, "non-ASCII must match exactly", ids(t, e, Query{Search: "HÉLLO"}), []int{})
	eq(t, "non-ASCII exact", ids(t, e, Query{Search: "héllo"}), []int{2})
	eq(t, "numbers as written", ids(t, e, Query{Search: "1.25"}), []int{2})
	eq(t, "no match", ids(t, e, Query{Search: "zzz"}), []int{})
}

func TestRegex(t *testing.T) {
	e := engine(t, sample)
	eq(t, "search: any cell matches", ids(t, e, Query{Search: `^[a-c]`, Regex: true}), []int{0, 1})
	eq(t, "search is case-sensitive", ids(t, e, Query{Search: `^Carol$`, Regex: true}), []int{2})
	eq(t, "(?i) ignores case", ids(t, e, Query{Search: `(?i)^carol$`, Regex: true}), []int{2})
	eq(t, "the same text without Regex is plain", ids(t, e, Query{Search: `^[a-c]`}), []int{})
	eq(t, "filter on one column", ids(t, e, Query{Filters: []Filter{{Column: "note", Op: OpRegex, Value: `l+o\b`}}}), []int{0, 2})
	// The cache tells a regular expression from the same plain text.
	eq(t, "regex W is case-sensitive", ids(t, e, Query{Search: "W", Regex: true}), []int{0})
	eq(t, "plain W after it is not", ids(t, e, Query{Search: "W"}), []int{0, 3})
	_, err := e.Run(Query{Search: "a(", Regex: true})
	if err == nil || !strings.Contains(err.Error(), "missing closing )") {
		t.Errorf("bad regex: %v", err)
	}
}

func TestFilters(t *testing.T) {
	e := engine(t, sample)
	tests := []struct {
		name string
		f    Filter
		want []int
	}{
		{"contains", Filter{Column: "name", Op: OpContains, Value: "A"}, []int{0, 2, 3}},
		{"equals", Filter{Column: "name", Op: OpEquals, Value: "bob"}, []int{1}},
		{"boolean equals ignores case", Filter{Column: "ok", Op: OpEquals, Value: "true"}, []int{0, 2}},
		{"number range", Filter{Column: "score", Op: OpRange, Min: "2", Max: "3.5"}, []int{0, 3}},
		{"open range", Filter{Column: "score", Op: OpRange, Min: "3.5"}, []int{0, 3, 4}},
		{"integer range", Filter{Column: "id", Op: OpRange, Max: "2"}, []int{0, 1}},
		{"date range", Filter{Column: "day", Op: OpRange, Min: "2024-01-01", Max: "2024-02-29"}, []int{0, 4}},
		{"null", Filter{Column: "score", Op: OpNull}, []int{1}},
		{"notnull", Filter{Column: "ok", Op: OpNotNull}, []int{0, 1, 2, 3}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			eq(t, "rows", ids(t, e, Query{Filters: []Filter{tt.f}}), tt.want)
		})
	}
	t.Run("filters and search combine", func(t *testing.T) {
		got := ids(t, e, Query{Search: "o", Filters: []Filter{{Column: "ok", Op: OpEquals, Value: "false"}}})
		eq(t, "rows", got, []int{1, 3})
	})
}

func TestBadQueries(t *testing.T) {
	e := engine(t, sample)
	if err := e.Check(Query{Search: "a.c", Regex: true, Filters: []Filter{{Column: "score", Op: OpRange, Min: "1"}}, Sorts: []Sort{{Column: "id"}}, Columns: []string{"name"}}); err != nil {
		t.Errorf("good query: %v", err)
	}
	for _, q := range []Query{
		{Filters: []Filter{{Column: "nope", Op: OpNull}}},
		{Filters: []Filter{{Column: "name", Op: OpRange, Min: "a"}}},
		{Filters: []Filter{{Column: "score", Op: OpRange, Min: "x"}}},
		{Filters: []Filter{{Column: "name", Op: OpRegex, Value: "("}}},
		{Search: "a(", Regex: true},
		{Filters: []Filter{{Column: "name", Op: "glob"}}},
		{Sorts: []Sort{{Column: "nope"}}},
		{Offset: -1},
	} {
		if _, err := e.Run(q); !errors.Is(err, ErrBadQuery) {
			t.Errorf("%+v: got %v, want ErrBadQuery", q, err)
		}
		if q.Offset >= 0 {
			if err := e.Check(q); !errors.Is(err, ErrBadQuery) {
				t.Errorf("check %+v: got %v, want ErrBadQuery", q, err)
			}
		}
	}
}

func TestSort(t *testing.T) {
	e := engine(t, sample)
	eq(t, "number asc, missing last, ties stable", ids(t, e, Query{Sorts: []Sort{{Column: "score"}}}), []int{2, 0, 3, 4, 1})
	eq(t, "number desc, missing still last", ids(t, e, Query{Sorts: []Sort{{Column: "score", Desc: true}}}), []int{4, 0, 3, 2, 1})
	eq(t, "string asc is byte order", ids(t, e, Query{Sorts: []Sort{{Column: "name"}}}), []int{2, 0, 1, 3, 4})
	eq(t, "date asc", ids(t, e, Query{Sorts: []Sort{{Column: "day"}}}), []int{2, 0, 4, 1, 3})
	eq(t, "boolean false first", ids(t, e, Query{Sorts: []Sort{{Column: "ok"}}}), []int{1, 3, 0, 2, 4})
	eq(t, "sort after filter", ids(t, e, Query{
		Filters: []Filter{{Column: "score", Op: OpNotNull}},
		Sorts:   []Sort{{Column: "id", Desc: true}},
	}), []int{4, 3, 2, 0})
}

func TestSortKeys(t *testing.T) {
	e := engine(t, sample)
	eq(t, "score asc, then name desc", ids(t, e, Query{Sorts: []Sort{{Column: "score"}, {Column: "name", Desc: true}}}), []int{2, 3, 0, 4, 1})
	eq(t, "ok asc, then score desc", ids(t, e, Query{Sorts: []Sort{{Column: "ok"}, {Column: "score", Desc: true}}}), []int{3, 1, 0, 2, 4})
	// Two missing cells are equal on the first key, so the second orders them.
	m := engine(t, "a,b\n,2\nx,1\n,1\n")
	eq(t, "missing first key, ordered by the second", ids(t, m, Query{Sorts: []Sort{{Column: "a"}, {Column: "b"}}}), []int{1, 2, 0})
	eq(t, "equal on every key: file order", ids(t, m, Query{Sorts: []Sort{{Column: "a"}}}), []int{1, 0, 2})
	six := make([]Sort, MaxSortKeys+1)
	for i := range six {
		six[i] = Sort{Column: "id"}
	}
	if _, err := e.Run(Query{Sorts: six}); !errors.Is(err, ErrBadQuery) {
		t.Errorf("%d sort keys: got %v, want ErrBadQuery", len(six), err)
	}
}

func TestPaging(t *testing.T) {
	e := engine(t, sample)
	res, err := e.Run(Query{Sorts: []Sort{{Column: "id", Desc: true}}, Offset: 1, Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "total", res.Total, 5)
	eq(t, "ids", res.RowIDs, []int{3, 2})
	eq(t, "cells", res.Rows[0], []string{"4", "dave", "3.5", "", "false", "world peace"})
	res, _ = e.Run(Query{Offset: 10})
	eq(t, "past the end", res.Total, 5)
	eq(t, "past the end rows", len(res.Rows), 0)
}

func TestCut(t *testing.T) {
	e := engine(t, "a,b\nあいうえお,x\n")
	res, err := e.Run(Query{MaxCellBytes: 7})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "cut at a character boundary", res.Rows[0][0], "あい")
	eq(t, "cut cells", res.Cut, [][2]int{{0, 0}})
}

func TestCacheReuse(t *testing.T) {
	e := engine(t, sample)
	q := Query{Search: "o", Sorts: []Sort{{Column: "name"}}}
	first, _ := e.match(q)
	q.Offset, q.Limit = 1, 1
	second, _ := e.match(q)
	if &first[0] != &second[0] {
		t.Error("paging should reuse the cached order")
	}
	for i := range cacheSize + 1 {
		_, _ = e.match(Query{Search: strings.Repeat("x", i+1)})
	}
	eq(t, "cache bounded", len(e.cache), cacheSize)
}

func TestContainsFold(t *testing.T) {
	for _, tt := range []struct {
		s, needle string
		want      bool
	}{
		{"Hello", "hello", true},
		{"xxHELLo", "ello", true},
		{"hell", "hello", false},
		{"", "a", false},
		{"abc", "", true},
		{"日本語のテキスト", "テキ", true},
		{strings.Repeat("a", 1000) + "b", "ab", true},
	} {
		if got := containsFold(tt.s, tt.needle); got != tt.want {
			t.Errorf("containsFold(%q, %q) = %v", tt.s, tt.needle, got)
		}
	}
}

func TestColumns(t *testing.T) {
	e := engine(t, sample)
	res, err := e.Run(Query{Columns: []string{"name", "id"}, Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "rows in the asked order", res.Rows, [][]string{{"alice", "1"}, {"bob", "2"}})
	eq(t, "file positions", res.Cols, []int{1, 0})
	all, _ := e.Run(Query{Limit: 1})
	eq(t, "no columns: every column", all.Cols, []int{0, 1, 2, 3, 4, 5})
	// A hidden column still filters and sorts.
	eq(t, "sort by a hidden column", ids(t, e, Query{Columns: []string{"name"}, Sorts: []Sort{{Column: "score", Desc: true}}}), []int{4, 0, 3, 2, 1})
	// Cut cells are reported at their position in the returned columns.
	long := engine(t, "a,b\nx,"+strings.Repeat("y", 50)+"\n")
	cut, _ := e.Run(Query{})
	eq(t, "no cut", len(cut.Cut), 0)
	cut, _ = long.Run(Query{Columns: []string{"b", "a"}, MaxCellBytes: 10})
	eq(t, "cut at its returned position", cut.Cut, [][2]int{{0, 0}})
	for _, cols := range [][]string{{"nope"}, {"id", "id"}} {
		if _, err := e.Run(Query{Columns: cols}); !errors.Is(err, ErrBadQuery) {
			t.Errorf("columns %v: got %v, want ErrBadQuery", cols, err)
		}
	}
	// An aggregate's columns are positions in the query's columns: score,
	// then id.
	a, err := e.Aggregate(Query{Columns: []string{"score", "id"}}, Range{R0: 0, R1: 4, C0: 1, C1: 1})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "aggregate over the second returned column (id)", *a.Sum, 15.0)
}

func TestAggregate(t *testing.T) {
	e := engine(t, sample)
	// sample: id 1..5; score 3.5, missing, 1.25, 3.5, 10; name strings
	a, err := e.Aggregate(Query{}, Range{R0: 0, R1: 4, C0: 0, C1: 0})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "count", a.Count, 5)
	eq(t, "sum", *a.Sum, 15.0)
	eq(t, "avg", *a.Avg, 3.0)
	eq(t, "min", *a.Min, 1.0)
	eq(t, "max", *a.Max, 5.0)

	// a missing score is not counted; strings count but are not numeric
	a, _ = e.Aggregate(Query{}, Range{R0: 0, R1: 4, C0: 1, C1: 2})
	eq(t, "count", a.Count, 9)
	eq(t, "numeric", a.NumericCount, 4)
	eq(t, "sum", *a.Sum, 18.25)

	// only text: no numeric stats
	a, _ = e.Aggregate(Query{}, Range{R0: 0, R1: 1, C0: 1, C1: 1})
	eq(t, "no sum", a.Sum == nil, true)

	// follows the query's order and filter; reversed and out-of-range bounds are fine
	a, _ = e.Aggregate(Query{Sorts: []Sort{{Column: "id", Desc: true}}}, Range{R0: 1, R1: 0, C0: 0, C1: 0})
	eq(t, "sorted first two ids", *a.Sum, 9.0)
	a, _ = e.Aggregate(Query{Filters: []Filter{{Column: "ok", Op: OpEquals, Value: "false"}}}, Range{R0: 0, R1: 99, C0: 0, C1: 0})
	eq(t, "filtered", *a.Sum, 6.0)
	a, _ = e.Aggregate(Query{Search: "zzz"}, Range{R0: 0, R1: 9, C0: 0, C1: 0})
	eq(t, "empty", a.Count, 0)

	if _, err := e.Aggregate(Query{Sorts: []Sort{{Column: "nope"}}}, Range{}); !errors.Is(err, ErrBadQuery) {
		t.Errorf("bad sort: %v", err)
	}
}

func TestAggregateOverflow(t *testing.T) {
	e := engine(t, "n\n1e308\n1e308\n")
	a, err := e.Aggregate(Query{}, Range{R0: 0, R1: 1, C0: 0, C1: 0})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := json.Marshal(a); err != nil {
		t.Fatalf("aggregate must encode: %v", err)
	}
	eq(t, "sum left out", a.Sum == nil, true)
	eq(t, "avg", *a.Avg, 1e308)
	eq(t, "max", *a.Max, 1e308)
}

// A number column with values, invalid text and missing cells: the filters
// tell them apart, the sort puts invalid then missing cells last, and the
// aggregate counts invalid text but sums only values.
func TestInvalidAndMissing(t *testing.T) {
	var b strings.Builder
	b.WriteString("n\n")
	for i := 0; i < 40; i++ {
		fmt.Fprintf(&b, "%d\n", 40-i)
	}
	b.WriteString("pending\nnull\nNA\n") // rows 40, 41, 42
	e := engine(t, b.String())
	eq(t, "invalid", ids(t, e, Query{Filters: []Filter{{Column: "n", Op: OpInvalid}}}), []int{40})
	eq(t, "missing", ids(t, e, Query{Filters: []Filter{{Column: "n", Op: OpNull}}}), []int{41, 42})
	eq(t, "not missing", len(ids(t, e, Query{Filters: []Filter{{Column: "n", Op: OpNotNull}}})), 41)
	for _, desc := range []bool{false, true} {
		got := ids(t, e, Query{Sorts: []Sort{{Column: "n", Desc: desc}}})
		eq(t, "invalid then missing last", got[40:], []int{40, 41, 42})
	}
	agg, err := e.Aggregate(Query{}, Range{R0: 38, R1: 42, C0: 0, C1: 0})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "count: values and invalid text", agg.Count, 3)
	eq(t, "numeric: values only", agg.NumericCount, 2)
	eq(t, "sum", *agg.Sum, 3.0) // 2 + 1
}
