package table

import (
	"fmt"
	"strings"
	"testing"
)

func loadJ(t *testing.T, text string, opts Options) *Table {
	t.Helper()
	tb, err := LoadJSONL([]byte(text), opts)
	if err != nil {
		t.Fatal(err)
	}
	return tb
}

func TestJSONLColumns(t *testing.T) {
	tb := loadJ(t, `{"type":"user","n":1,"msg":{"role":"user","content":[1,2]}}
{"type":"assistant","extra":true,"n":2}

not json
[1,2,3]
{"type":"summary","n":null,"msg":"plain"}
`, Options{})
	eq(t, "rows", tb.Rows, 3)
	eq(t, "skipped", tb.SkippedLines, 2)
	eq(t, "names in first-seen order", names(tb), []string{"type", "n", "msg", "extra"})
	eq(t, "types", types(tb), []string{"string", "integer", "json", "boolean"})
	msg := tb.Columns[2]
	eq(t, "nested kept as compact JSON", msg.Raw[0], `{"role":"user","content":[1,2]}`)
	eq(t, "absent key is missing", msg.IsMissing(1), true)
	eq(t, "string in a json column is shown unquoted", msg.Raw[2], "plain")
	n := tb.Columns[1]
	eq(t, "JSON null is missing", n.IsMissing(2), true)
	eq(t, "absent key is missing", tb.Columns[3].IsMissing(0), true)
}

func TestJSONLTypesFromStrings(t *testing.T) {
	tb := loadJ(t, `{"day":"2024-01-02","big":9223372036854775808,"f":1.5}
{"day":"2024-02-03","big":1,"f":2}
`, Options{})
	eq(t, "types", types(tb), []string{"date", "string", "number"})
	eq(t, "big kept exactly", tb.Columns[1].Raw[0], "9223372036854775808")
}

func TestJSONLRepeatedKeyKeepsLast(t *testing.T) {
	tb := loadJ(t, `{"a":1,"a":2}`+"\n", Options{})
	eq(t, "value", tb.Columns[0].Ints, []int64{2})
}

func TestJSONLTrailingDataIsSkipped(t *testing.T) {
	tb := loadJ(t, `{"a":1} {"a":2}`+"\n"+`{"a":3}`+"\n", Options{})
	eq(t, "rows", tb.Rows, 1)
	eq(t, "skipped", tb.SkippedLines, 1)
}

func TestJSONLLongLine(t *testing.T) {
	long := strings.Repeat("x", 2<<20) // 2 MB, past bufio.Scanner's 64 KB default
	tb := loadJ(t, fmt.Sprintf(`{"a":%q}`+"\n"+`{"a":"y"}`+"\r\n", long), Options{})
	eq(t, "rows", tb.Rows, 2)
	eq(t, "length", len(tb.Columns[0].Raw[0]), len(long))
	eq(t, "CR stripped", tb.Columns[0].Raw[1], "y")
}

func TestJSONLFoldsRareKeys(t *testing.T) {
	// Every row shares "id" and has one key of its own.
	var b strings.Builder
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&b, `{"id":%d,"k%03d":1}`+"\n", i, i)
	}
	t.Run("empty-cell limit", func(t *testing.T) {
		// id costs 0 empty cells, each kNNN costs 99.
		tb := loadJ(t, b.String(), Options{MaxEmptyCells: 250})
		eq(t, "names", names(tb), []string{"id", "k000", "k001", OtherKeysColumn})
		eq(t, "folded", tb.FoldedKeys, 98)
		other := tb.Columns[3]
		eq(t, "type", other.Type, JSON)
		eq(t, "row 0 has nothing folded", other.IsMissing(0), true)
		eq(t, "row 5 folded", other.Raw[5], `{"k005":1}`)
	})
	t.Run("column limit leaves room for the other-keys column", func(t *testing.T) {
		tb := loadJ(t, b.String(), Options{MaxColumns: 3})
		eq(t, "names", names(tb), []string{"id", "k000", OtherKeysColumn})
		eq(t, "folded", tb.FoldedKeys, 99)
	})
	t.Run("defaults fold nothing here", func(t *testing.T) {
		tb := loadJ(t, b.String(), Options{})
		eq(t, "columns", len(tb.Columns), 101)
		eq(t, "folded", tb.FoldedKeys, 0)
	})
}

func TestJSONLTypeSampleBoundary(t *testing.T) {
	var b strings.Builder
	for i := 0; i < typeSample+3; i++ {
		fmt.Fprintf(&b, `{"n":%d}`+"\n", i)
	}
	tb := loadJ(t, b.String(), Options{})
	eq(t, "rows", tb.Rows, typeSample+3)
	eq(t, "last value", tb.Columns[0].Ints[typeSample+2], int64(typeSample+2))
}

func TestJSONLNestedAfterTheSample(t *testing.T) {
	var b strings.Builder
	for i := 0; i < typeSample; i++ {
		b.WriteString(`{"m":1}` + "\n")
	}
	b.WriteString(`{"m":{"x":1}}` + "\n" + `{}` + "\n" + `{"m":""}` + "\n")
	tb := loadJ(t, b.String(), Options{})
	m := tb.Columns[0]
	eq(t, "type", m.Type, JSON)
	eq(t, "earlier value kept", m.Raw[0], "1")
	eq(t, "earlier value not missing", m.IsMissing(0), false)
	eq(t, "nested value", m.Raw[typeSample], `{"x":1}`)
	eq(t, "nested not missing", m.IsMissing(typeSample), false)
	eq(t, "absent is missing", m.IsMissing(typeSample+1), true)
	eq(t, "empty string is missing", m.IsMissing(typeSample+2), true)
}

func TestJSONLStringsAndInvalidNumbers(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 50; i++ {
		fmt.Fprintf(&b, `{"country":"JP","n":%d}`+"\n", i)
	}
	b.WriteString(`{"country":"NA","n":1.5}` + "\n")
	b.WriteString(`{"country":null,"n":null}` + "\n")
	tb := loadJ(t, b.String(), Options{})
	country, n := tb.Columns[0], tb.Columns[1]
	eq(t, "types", []Type{country.Type, n.Type}, []Type{String, Integer})
	eq(t, "the string NA is a value", country.HasValue(50), true)
	eq(t, "JSON null is missing", country.IsMissing(51), true)
	eq(t, "1.5 in an integer column is invalid", n.IsInvalid(50), true)
	eq(t, "JSON null number is missing", n.IsMissing(51), true)
}
