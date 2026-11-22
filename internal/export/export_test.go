package export

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/babarot/xxsv/internal/table"
)

func load(t *testing.T, format table.Format, text string) *table.Table {
	t.Helper()
	var tb *table.Table
	var err error
	if format == table.JSONL {
		tb, err = table.LoadJSONL([]byte(text), table.Options{})
	} else {
		tb, err = table.LoadDelimited(strings.NewReader(text), format, table.Options{})
	}
	if err != nil {
		t.Fatal(err)
	}
	return tb
}

func all(tb *table.Table) ([]int32, []int) {
	rows := make([]int32, tb.Rows)
	for i := range rows {
		rows[i] = int32(i)
	}
	cols := make([]int, len(tb.Columns))
	for i := range cols {
		cols[i] = i
	}
	return rows, cols
}

func write(t *testing.T, tb *table.Table, rows []int32, cols []int, f Format) string {
	t.Helper()
	var b bytes.Buffer
	if err := Write(&b, tb, rows, cols, f); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

// cells returns a table's names and cells as text, missing cells as "".
func cells(tb *table.Table) [][]string {
	out := [][]string{{}}
	for _, c := range tb.Columns {
		out[0] = append(out[0], c.Name)
	}
	for r := 0; r < tb.Rows; r++ {
		row := []string{}
		for _, c := range tb.Columns {
			if c.IsMissing(r) {
				row = append(row, "")
			} else {
				row = append(row, c.Raw[r])
			}
		}
		out = append(out, row)
	}
	return out
}

const tricky = "id,name,note\n1,\"a, b\",\"say \"\"hi\"\"\"\n2,tab\there,\"two\nlines\"\n3,,x\n"

func TestDelimitedReadsBackTheSame(t *testing.T) {
	src := load(t, table.CSV, tricky)
	rows, cols := all(src)
	for _, f := range []Format{CSV, TSV} {
		out := write(t, src, rows, cols, f)
		format := table.CSV
		if f == TSV {
			format = table.TSV
		}
		back := load(t, format, out)
		if got, want := cells(back), cells(src); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: read back %q, want %q\n%s", f, got, want, out)
		}
	}
}

func TestOneColumnKeepsEmptyCells(t *testing.T) {
	src := load(t, table.CSV, "a,b\nx,1\n,2\ny,3\n")
	rows, _ := all(src)
	for _, f := range []Format{CSV, TSV} {
		out := write(t, src, rows, []int{0}, f)
		if out != "a\nx\n\"\"\ny\n" {
			t.Errorf("%s: %q", f, out)
		}
		format := table.CSV
		if f == TSV {
			format = table.TSV
		}
		back := load(t, format, out)
		if back.Rows != 3 || !back.Columns[0].IsMissing(1) {
			t.Errorf("%s: read back %d rows, missing %v", f, back.Rows, back.Columns[0].IsMissing(1))
		}
	}
}

func TestRowsAndColumnsInOrder(t *testing.T) {
	src := load(t, table.CSV, "a,b,c\n1,x,10\n2,y,20\n3,z,30\n")
	got := write(t, src, []int32{2, 0}, []int{2, 0}, CSV)
	if want := "c,a\n30,3\n10,1\n"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestJSONLValues(t *testing.T) {
	// 120 rows, so that one invalid cell leaves the number and boolean
	// columns typed: row 0 is a big integer, row 1 has missing cells, row
	// 2 invalid ones.
	var b strings.Builder
	b.WriteString("i,n,b,d,s\n")
	b.WriteString("9007199254740993,1.5,TRUE,2024-01-02,\"q\"\"\\\n\"\n")
	b.WriteString("2,2,false,,\n")
	b.WriteString(",x,maybe,2024-01-03,ü\n")
	for i := 3; i < 120; i++ {
		b.WriteString("7,0.25,true,2024-02-01,s\n")
	}
	src := load(t, table.CSV, b.String())
	rows, cols := all(src)
	lines := strings.Split(strings.TrimSuffix(write(t, src, rows[:3], cols, JSONL), "\n"), "\n")
	want := []string{
		`{"i":9007199254740993,"n":1.5,"b":true,"d":"2024-01-02","s":"q\"\\\n"}`,
		`{"i":2,"n":2,"b":false,"d":null,"s":null}`,
		`{"i":null,"n":"x","b":"maybe","d":"2024-01-03","s":"ü"}`,
	}
	if !reflect.DeepEqual(lines, want) {
		t.Errorf("got\n%s\nwant\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}
	for _, l := range lines {
		if !json.Valid([]byte(l)) {
			t.Errorf("not valid JSON: %s", l)
		}
	}
}

func TestJSONLNestedValues(t *testing.T) {
	// m is a JSON column holding an object, an array, a string and a number.
	src := load(t, table.JSONL, `{"m":{"a":[1,2]}}
{"m":[true]}
{"m":"plain"}
{"m":7}
{}
`)
	rows, cols := all(src)
	got := write(t, src, rows, cols, JSONL)
	want := `{"m":{"a":[1,2]}}
{"m":[true]}
{"m":"plain"}
{"m":"7"}
{"m":null}
`
	if src.Columns[0].Type != table.JSON {
		t.Fatalf("m is %s, want json", src.Columns[0].Type)
	}
	if got != want {
		t.Errorf("got\n%swant\n%s", got, want)
	}
}

func TestAppendString(t *testing.T) {
	for _, s := range []string{"", "plain", "\x00\x1f\x7f", "\"\\/", "日本語", " ", "a\xffb"} {
		got := appendString(nil, s)
		var back string
		if err := json.Unmarshal(got, &back); err != nil {
			t.Errorf("%q: %s is not JSON: %v", s, got, err)
			continue
		}
		want, _ := json.Marshal(s)
		var w string
		_ = json.Unmarshal(want, &w)
		if back != w {
			t.Errorf("%q: read back %q, want %q", s, back, w)
		}
	}
}

func TestParseFormat(t *testing.T) {
	for _, s := range []string{"csv", "tsv", "jsonl"} {
		if _, err := ParseFormat(s); err != nil {
			t.Errorf("%s: %v", s, err)
		}
	}
	if _, err := ParseFormat("xlsx"); err == nil {
		t.Error("xlsx: no error")
	}
}
