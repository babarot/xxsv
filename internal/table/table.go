// Package table loads a CSV, TSV or JSONL file into an in-memory columnar
// table and computes per-column statistics.
//
// Every cell keeps its original text (Raw). Integer, number, date and
// datetime columns also keep a typed value for sorting, range filters and
// statistics. String, boolean and JSON columns use the raw text as their
// value and keep no second array.
package table

import "fmt"

// Type is the inferred type of a column.
type Type int

const (
	String Type = iota
	Integer
	Number
	Boolean
	Date
	Datetime
	JSON // nested JSON value (object or array), JSONL only
)

var typeNames = [...]string{"string", "integer", "number", "boolean", "date", "datetime", "json"}

func (t Type) String() string {
	if int(t) < len(typeNames) {
		return typeNames[t]
	}
	return fmt.Sprintf("Type(%d)", int(t))
}

// MarshalText makes a Type encode as its name in JSON.
func (t Type) MarshalText() ([]byte, error) { return []byte(t.String()), nil }

// UnmarshalText reads a Type from its name.
func (t *Type) UnmarshalText(b []byte) error {
	for i, n := range typeNames {
		if n == string(b) {
			*t = Type(i)
			return nil
		}
	}
	return fmt.Errorf("unknown column type %q", b)
}

// Format is the file format a table was read from.
type Format string

const (
	CSV   Format = "csv"
	TSV   Format = "tsv"
	JSONL Format = "jsonl"
)

// Column holds one column of a table.
type Column struct {
	Name string
	Type Type

	// Raw is the original text of every cell. It is "" for a missing JSONL
	// key. For String, Boolean and JSON columns it is also the value.
	Raw []string
	// Ints holds Integer values, and Date and Datetime values as Unix
	// milliseconds (UTC). Nil for other types.
	Ints []int64
	// Floats holds Number values. Nil for other types.
	Floats []float64

	// A cell is a value of the column's type, missing, or invalid: it has
	// text that is not a value of the type ("pending" in a number column).
	nulls   []uint64 // bitmap: 1 = no value (missing or invalid)
	invalid []uint64 // bitmap: 1 = invalid

	// zoned and naive count the Datetime cells with and without a time
	// zone, for showing their times as UTC or as written.
	zoned, naive int
}

// HasValue reports whether row i of the column holds a value of the
// column's type.
func (c *Column) HasValue(i int) bool { return c.nulls[i>>6]&(1<<(uint(i)&63)) == 0 }

// IsMissing reports whether row i of the column is missing: empty, absent
// in JSONL, a JSON null, or, in Integer, Number, Date, Datetime and Boolean
// columns, a null marker (null, na, nan).
func (c *Column) IsMissing(i int) bool { return !c.HasValue(i) && !c.IsInvalid(i) }

// IsInvalid reports whether row i of the column has text that is not a
// value of the column's type, such as "pending" in a Number column.
func (c *Column) IsInvalid(i int) bool { return c.invalid[i>>6]&(1<<(uint(i)&63)) != 0 }

// UTC reports whether a Datetime column's times are shown as UTC: when any
// of them carries a time zone. Times without one are read as UTC either
// way; a column with none shows them as written.
func (c *Column) UTC() bool { return c.zoned > 0 }

func (c *Column) setNull(i int)    { c.nulls[i>>6] |= 1 << (uint(i) & 63) }
func (c *Column) setInvalid(i int) { c.setNull(i); c.invalid[i>>6] |= 1 << (uint(i) & 63) }

func newColumn(name string, rows int) *Column {
	return &Column{Name: name, Raw: make([]string, 0, rows)}
}

// Table is a loaded file.
type Table struct {
	Format    Format
	Delimiter rune // CSV/TSV only
	// HeaderGenerated is true when the first row was read as data and the
	// columns were named col1, col2, ... (CSV/TSV only).
	HeaderGenerated bool
	Columns         []*Column
	Rows            int

	// RaggedRows counts CSV/TSV rows whose number of fields differed from
	// the header: short rows were padded with missing cells, extra fields
	// were dropped.
	RaggedRows int
	// SkippedLines counts JSONL lines that were not a JSON object.
	SkippedLines int
	// FoldedKeys counts JSONL keys that did not get a column of their own
	// because of the column and empty-cell limits. They are kept per row in
	// the OtherKeysColumn column.
	FoldedKeys int
}

// OtherKeysColumn is the name of the JSONL column that holds the keys left
// over by the column and empty-cell limits.
const OtherKeysColumn = "(other keys)"

// HeaderMode says how to treat the first row of a CSV/TSV file.
type HeaderMode int

const (
	HeaderAuto HeaderMode = iota // header unless a cell of the first row is a bare number
	HeaderYes
	HeaderNo
)

// Options control loading. The zero value detects everything.
type Options struct {
	Format    Format // "" detects from the extension and content
	Delimiter rune   // 0 detects; CSV/TSV only
	Header    HeaderMode

	// MaxColumns and MaxEmptyCells limit JSONL columns; 0 means the
	// defaults (DefaultMaxColumns, DefaultMaxEmptyCells).
	MaxColumns    int
	MaxEmptyCells int
}

// Limits for JSONL. Lines with different keys can make a small file a table
// of many sparse columns; past the limits the rarest keys are folded into
// OtherKeysColumn. Only empty cells need a bound, since the rest grows with
// the file: an empty cell costs 16 to 24 bytes, so 20M of them stay under
// about 480 MB. 1000 columns is about as many as a table can be read with.
const (
	DefaultMaxColumns    = 1000
	DefaultMaxEmptyCells = 20_000_000
)

// typeSample is the number of rows used to infer column types.
const typeSample = 5000
