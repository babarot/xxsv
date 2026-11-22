package table

import (
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

func load(t *testing.T, format Format, text string, opts Options) *Table {
	t.Helper()
	tb, err := LoadDelimited(strings.NewReader(text), format, opts)
	if err != nil {
		t.Fatal(err)
	}
	return tb
}

func names(tb *Table) []string {
	var out []string
	for _, c := range tb.Columns {
		out = append(out, c.Name)
	}
	return out
}

func types(tb *Table) []string {
	var out []string
	for _, c := range tb.Columns {
		out = append(out, c.Type.String())
	}
	return out
}

func eq[T any](t *testing.T, label string, got, want T) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: got %v, want %v", label, got, want)
	}
}

func TestTypesAndValues(t *testing.T) {
	tb := load(t, CSV, "id,price,day,at,ok,name,maybe\n"+
		"1,1.50,2024-01-02,2024-01-02T10:00:00Z,true,alice,3\n"+
		"2,2,2024-02-03,2024-02-03 11:30,FALSE,bob,NA\n", Options{})
	eq(t, "types", types(tb), []string{"integer", "number", "date", "datetime", "boolean", "string", "integer"})
	eq(t, "rows", tb.Rows, 2)
	price := tb.Columns[1]
	eq(t, "price raw keeps the original text", price.Raw, []string{"1.50", "2"})
	eq(t, "price values", price.Floats, []float64{1.5, 2})
	at := tb.Columns[3]
	eq(t, "datetime with a zone", at.Ints[0], int64(1704189600000))
	eq(t, "datetime without a zone is UTC", at.Ints[1], int64(1706959800000))
	maybe := tb.Columns[6]
	eq(t, "NA is missing", maybe.IsMissing(1), true)
	eq(t, "missing keeps its text", maybe.Raw[1], "NA")
}

func TestDelimiterDetection(t *testing.T) {
	tests := []struct {
		name, text string
		want       rune
	}{
		{"comma", "a,b,c\n1,2,3\n", ','},
		{"tab", "a\tb\tc\n1\t2\t3\n", '\t'},
		{"tab with commas in values", "name\tnote\nx\ta, b, c\ny\td, e\n", '\t'},
		{"comma inside quotes is ignored", "a,b\n\"x\ty\",2\n", ','},
		{"single line without newline", "a\tb\tc", '\t'},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tb := load(t, CSV, tt.text, Options{})
			eq(t, "delimiter", tb.Delimiter, tt.want)
		})
	}
	t.Run("tsv extension forces tab", func(t *testing.T) {
		tb := load(t, TSV, "a,b\tc\n1,2\t3\n", Options{})
		eq(t, "names", names(tb), []string{"a,b", "c"})
	})
	t.Run("explicit delimiter", func(t *testing.T) {
		tb := load(t, CSV, "a;b\n1;2\n", Options{Delimiter: ';'})
		eq(t, "names", names(tb), []string{"a", "b"})
	})
}

func TestHeaderDetection(t *testing.T) {
	headerless := "330\t3148365\tremux\tremux\n331\t3148365\tremux\tremux\n"
	t.Run("bare number in the first row means no header", func(t *testing.T) {
		tb := load(t, TSV, headerless, Options{})
		eq(t, "generated", tb.HeaderGenerated, true)
		eq(t, "names", names(tb), []string{"col1", "col2", "col3", "col4"})
		eq(t, "rows", tb.Rows, 2)
		eq(t, "first row kept as data", tb.Columns[0].Ints[0], int64(330))
	})
	t.Run("--header overrides", func(t *testing.T) {
		tb := load(t, TSV, headerless, Options{Header: HeaderYes})
		eq(t, "names", names(tb), []string{"330", "3148365", "remux", "remux_2"})
		eq(t, "rows", tb.Rows, 1)
	})
	t.Run("-n overrides", func(t *testing.T) {
		tb := load(t, CSV, "name,age\nalice,30\n", Options{Header: HeaderNo})
		eq(t, "names", names(tb), []string{"col1", "col2"})
		eq(t, "rows", tb.Rows, 2)
	})
	t.Run("empty and duplicate names", func(t *testing.T) {
		tb := load(t, CSV, "a,,a,a\n1,2,3,4\n", Options{Header: HeaderYes})
		eq(t, "names", names(tb), []string{"a", "col2", "a_2", "a_3"})
	})
}

func TestLineEndingsAndBOM(t *testing.T) {
	tb := load(t, TSV, "\uFEFFname\tage\r\nalice\t30\r\nbob\t41\r\n", Options{})
	eq(t, "names", names(tb), []string{"name", "age"})
	eq(t, "no CR left", tb.Columns[1].Raw, []string{"30", "41"})
	eq(t, "type", tb.Columns[1].Type, Integer)

	tb = load(t, TSV, "1\tx\r\n2\ty\r\n", Options{})
	eq(t, "headerless CRLF", tb.Columns[1].Raw, []string{"x", "y"})
}

func TestRaggedRows(t *testing.T) {
	tb := load(t, CSV, "a,b,c\n1,2\n1,2,3,4\n1,2,3\n", Options{})
	eq(t, "rows", tb.Rows, 3)
	eq(t, "ragged", tb.RaggedRows, 2)
	eq(t, "short row padded with missing", tb.Columns[2].IsMissing(0), true)
	eq(t, "extra field dropped", len(tb.Columns), 3)
}

func TestIntegerOverflowBecomesString(t *testing.T) {
	text := "id\n1\n2\n9223372036854775808\n"
	tb := load(t, CSV, text, Options{})
	c := tb.Columns[0]
	eq(t, "type", c.Type, String)
	eq(t, "raw", c.Raw, []string{"1", "2", "9223372036854775808"})
	eq(t, "no typed array", c.Ints == nil, true)
	eq(t, "no nulls", c.IsMissing(2), false)

	// Large integers within int64 stay exact.
	tb = load(t, CSV, "id\n9007199254740992\n9007199254740993\n", Options{})
	eq(t, "exact", tb.Columns[0].Ints, []int64{9007199254740992, 9007199254740993})
}

func TestOverflowAfterTheSample(t *testing.T) {
	var b strings.Builder
	b.WriteString("id\n")
	for i := 0; i < typeSample+10; i++ {
		b.WriteString("1\n")
	}
	b.WriteString("99999999999999999999\n")
	tb := load(t, CSV, b.String(), Options{})
	eq(t, "type", tb.Columns[0].Type, String)
	eq(t, "rows", tb.Rows, typeSample+11)
}

func TestUnconvertibleValueIsInvalid(t *testing.T) {
	var b strings.Builder
	b.WriteString("n\n")
	for i := 0; i < 99; i++ {
		b.WriteString("1\n")
	}
	b.WriteString("oops\n")
	tb := load(t, CSV, b.String(), Options{})
	c := tb.Columns[0]
	eq(t, "type", c.Type, Integer)
	eq(t, "invalid", c.IsInvalid(99), true)
	eq(t, "not missing", c.IsMissing(99), false)
	eq(t, "no value", c.HasValue(99), false)
	eq(t, "raw kept", c.Raw[99], "oops")
	s := c.Stats()
	eq(t, "counts", [3]int{s.Count, s.Nulls, s.Invalid}, [3]int{99, 0, 1})
}

func TestEmptyInput(t *testing.T) {
	tb := load(t, CSV, "", Options{})
	eq(t, "rows", tb.Rows, 0)
	tb = load(t, CSV, "a,b\n", Options{})
	eq(t, "header only", names(tb), []string{"a", "b"})
	eq(t, "types", types(tb), []string{"string", "string"})
}

func TestLoadFileDetectsFormat(t *testing.T) {
	dir := t.TempDir()
	write := func(name, text string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	tests := []struct {
		file, text string
		want       Format
	}{
		{"a.csv", "a,b\n1,2\n", CSV},
		{"a.tsv", "a\tb\n1\t2\n", TSV},
		{"a.txt", "a\tb\n1\t2\n", TSV},
		{"a.jsonl", "{\"a\":1}\n", JSONL},
		{"a.ndjson", "{\"a\":1}\n", JSONL},
		{"noext", "{\"a\":1}\n{\"a\":2}\n", JSONL},
		{"a.log", "\uFEFF  {\"a\":1}\n", JSONL},
	}
	for _, tt := range tests {
		tb, err := LoadFile(write(tt.file, tt.text), Options{})
		if err != nil {
			t.Fatalf("%s: %v", tt.file, err)
		}
		eq(t, tt.file, tb.Format, tt.want)
	}
}

func TestJSONColumnInDelimited(t *testing.T) {
	tsv := "id\tmeta\tnote\n" +
		"1\t{\"a\":1,\"b\":[1,2]}\thello\n" +
		"2\t[1, 2, 3]\t[not json\n" +
		"3\t\t{\"x\":1}\n" +
		"4\tnull\tplain\n"
	tb := load(t, TSV, tsv, Options{})
	eq(t, "types", types(tb), []string{"integer", "json", "string"})
	meta := tb.Columns[1]
	eq(t, "raw kept as written", meta.Raw[1], "[1, 2, 3]")
	eq(t, "empty is missing", meta.IsMissing(2), true)
	eq(t, "null marker is missing", meta.IsMissing(3), true)

	// JSON in CSV needs quoting; the reader unquotes it.
	tb = load(t, CSV, "id,meta\n1,\"{\"\"a\"\":1}\"\n2,\"[1,2]\"\n", Options{})
	eq(t, "csv types", types(tb), []string{"integer", "json"})
	eq(t, "csv raw", tb.Columns[1].Raw[0], `{"a":1}`)

	// Plain JSON scalars do not make a column JSON.
	tb = load(t, CSV, "a,b\n1,\"\"\"x\"\"\"\n2,\"\"\"y\"\"\"\n", Options{})
	eq(t, "scalars", types(tb), []string{"integer", "string"})

	// Below the 95% threshold the column stays string.
	var b strings.Builder
	b.WriteString("v\n")
	for i := 0; i < 90; i++ {
		b.WriteString("\"{\"\"a\"\":1}\"\n")
	}
	for i := 0; i < 10; i++ {
		b.WriteString("text\n")
	}
	tb = load(t, CSV, b.String(), Options{})
	eq(t, "mixed", types(tb), []string{"string"})
}

func TestLeadingZerosAreNotNumbers(t *testing.T) {
	var b strings.Builder
	b.WriteString("zip,code,ok\n")
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&b, "%05d,%d,0.5\n", i*97, i)
	}
	b.WriteString("01234,007,0\n")
	tb := load(t, CSV, b.String(), Options{})
	eq(t, "types", types(tb), []string{"string", "integer", "number"})
	code := tb.Columns[1]
	eq(t, "007 in an integer column is invalid", code.IsInvalid(100), true)
	eq(t, "0 is a number", tb.Columns[2].HasValue(100), true)
}

func TestNullMarkersOnlyInTypedColumns(t *testing.T) {
	tb := load(t, CSV, "country,n,b\nJP,1,true\nNA,na,NULL\nUS, ,false\nnull,3,true\n", Options{})
	eq(t, "types", types(tb), []string{"string", "integer", "boolean"})
	country := tb.Columns[0]
	eq(t, "NA is a value in a string column", country.HasValue(1), true)
	eq(t, "null is a value in a string column", country.HasValue(3), true)
	eq(t, "na is missing in an integer column", tb.Columns[1].IsMissing(1), true)
	eq(t, "blank is missing", tb.Columns[1].IsMissing(2), true)
	eq(t, "NULL is missing in a boolean column", tb.Columns[2].IsMissing(1), true)
}

func TestDatesAndDatetimesMixed(t *testing.T) {
	var b strings.Builder
	b.WriteString("at\n")
	for i := 0; i < 100; i++ {
		if i%2 == 0 {
			fmt.Fprintf(&b, "2024-01-%02d\n", i%28+1)
		} else {
			fmt.Fprintf(&b, "2024-01-%02d 10:00:00\n", i%28+1)
		}
	}
	tb := load(t, CSV, b.String(), Options{})
	c := tb.Columns[0]
	eq(t, "datetime", c.Type, Datetime)
	eq(t, "a bare date is midnight", c.Ints[0], int64(1704067200000))
	eq(t, "no invalid", c.Stats().Invalid, 0)
}

// isIntText, isNumText and hasZone must agree with the patterns they stand
// in for, on hand-picked and random texts.
func TestTextChecksMatchPatterns(t *testing.T) {
	zoneRE := regexp.MustCompile(`(Z|[+-]\d{2}:?\d{2})$`)
	texts := []string{"", "0", "-0", "+0", "007", "-01", "10", "1.", ".5", ".", "0.5", "00.5", "1e5", "1e", "1e+", "1E-3",
		"+.5e2", "-", "+", "1.2.3", "e5", "0e3", "01e3", "5x", " 5", "Z", "10:00Z", "10:00+09:00", "10:00+0900", "10:00+9:00", "+09:0"}
	r := rand.New(rand.NewPCG(3, 4))
	const alphabet = "0123456789+-.eEZ:x"
	for range 200000 {
		b := make([]byte, r.IntN(8))
		for i := range b {
			b[i] = alphabet[r.IntN(len(alphabet))]
		}
		texts = append(texts, string(b))
	}
	for _, s := range texts {
		if isIntText(s) != intRE.MatchString(s) {
			t.Fatalf("isIntText(%q) = %v", s, isIntText(s))
		}
		if isNumText(s) != numRE.MatchString(s) {
			t.Fatalf("isNumText(%q) = %v", s, isNumText(s))
		}
		if hasZone(s) != zoneRE.MatchString(s) {
			t.Fatalf("hasZone(%q) = %v", s, hasZone(s))
		}
	}
}

func TestHeaderDetectionWithLeadingZeros(t *testing.T) {
	tb := load(t, CSV, "00097,alice\n01234,bob\n", Options{})
	eq(t, "a first row of codes is data", tb.HeaderGenerated, true)
	eq(t, "rows", tb.Rows, 2)
}
