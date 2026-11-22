package query

import (
	"fmt"
	"strings"
	"testing"
)

func TestValues(t *testing.T) {
	var b strings.Builder
	b.WriteString("ok,name\n")
	// 120 rows, so one "pending" leaves ok a boolean column.
	for i := 0; i < 117; i++ {
		fmt.Fprintf(&b, "%s,n%d\n", []string{"true", "TRUE", " false"}[i%3], i%2)
	}
	b.WriteString("pending,x\n,y\n,y\n")
	e := engine(t, b.String())
	if e.t.Columns[0].Type.String() != "boolean" {
		t.Fatalf("ok is %s", e.t.Columns[0].Type)
	}
	v, err := e.Values(ValuesQuery{Column: "ok"})
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, it := range v.Items {
		got = append(got, fmt.Sprintf("%q:%d:%v", it.Value, it.Count, it.Missing))
	}
	// true and TRUE are one value; " false" counts as false; pending is
	// its own item, and the missing cells one more.
	eq(t, "items", got, []string{`"true":78:false`, `"false":39:false`, `"":2:true`, `"pending":1:false`})
	eq(t, "distinct", v.Distinct, 4)
	eq(t, "rows", v.Rows, 120)

	// A filter on each item keeps as many rows as it counts.
	for _, it := range v.Items {
		f := Filter{Column: "ok", Op: OpEquals, Value: it.Value}
		if it.Missing {
			f = Filter{Column: "ok", Op: OpNull}
		}
		res, err := e.Run(Query{Filters: []Filter{f}, Limit: 1})
		if err != nil {
			t.Fatal(err)
		}
		if res.Total != it.Count {
			t.Errorf("filter on %q keeps %d rows, the list counts %d", it.Value, res.Total, it.Count)
		}
	}

	// Over the rows a query matches; a search on the values; paging.
	v, _ = e.Values(ValuesQuery{Query: Query{Filters: []Filter{{Column: "name", Op: OpEquals, Value: "n1"}}}, Column: "ok"})
	eq(t, "filtered rows", v.Rows, 58)
	// The column's own filter is left out: every value of ok still shows.
	v, _ = e.Values(ValuesQuery{Query: Query{Filters: []Filter{{Column: "ok", Op: OpEquals, Value: "true"}}}, Column: "ok"})
	eq(t, "own filter left out", v.Distinct, 4)
	eq(t, "own filter left out: rows", v.Rows, 120)
	v, _ = e.Values(ValuesQuery{Column: "name", Search: "N"})
	eq(t, "search ignores ASCII case", v.Total, 2)
	v, _ = e.Values(ValuesQuery{Column: "name", Offset: 1, Limit: 2})
	eq(t, "page", len(v.Items), 2)
	eq(t, "total before paging", v.Total, 4)
	if _, err := e.Values(ValuesQuery{Column: "nope"}); err == nil {
		t.Error("unknown column: no error")
	}
}

func TestValuesCutLongValues(t *testing.T) {
	long := strings.Repeat("a", DefaultMaxCellBytes+10)
	e := engine(t, "s\n"+long+"\nb\n"+long+"\n")
	v, _ := e.Values(ValuesQuery{Column: "s"})
	it := v.Items[0]
	eq(t, "cut", it.Cut, true)
	eq(t, "cut length", len(it.Value), DefaultMaxCellBytes)
	eq(t, "first row holding it", it.RowID, 0)
}
