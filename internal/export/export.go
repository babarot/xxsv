// Package export writes rows of a table.Table as CSV, TSV or JSONL.
package export

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/babarot/xxsv/internal/table"
)

// Format is an output format.
type Format string

const (
	CSV   Format = "csv"
	TSV   Format = "tsv"
	JSONL Format = "jsonl"
)

// ParseFormat reads a format name.
func ParseFormat(s string) (Format, error) {
	switch f := Format(s); f {
	case CSV, TSV, JSONL:
		return f, nil
	}
	return "", fmt.Errorf("unknown export format %q", s)
}

// ContentType is the media type of a format.
func (f Format) ContentType() string {
	switch f {
	case TSV:
		return "text/tab-separated-values; charset=utf-8"
	case JSONL:
		return "application/jsonl; charset=utf-8"
	}
	return "text/csv; charset=utf-8"
}

// Write writes the rows (row numbers of t, in order) in the columns (file
// positions of t, in order).
//
// CSV and TSV start with a row of column names and hold the cells' text as
// the file has it, quoted where needed; a missing cell is empty. JSONL holds
// one object per row, keyed by column name in the given order, with each
// value written as its column's type: integers and numbers as JSON numbers,
// booleans as true or false, other values as strings. A JSON column's cell
// is written as JSON only when its text is an object or an array; JSONL
// strings in such a column lost their quotes when read ("plain" is plain),
// so anything else is written as a string. A missing cell is null, and text
// that is not a value of its column's type is written as a string.
func Write(w io.Writer, t *table.Table, rows []int32, cols []int, f Format) error {
	switch f {
	case CSV, TSV:
		return writeDelimited(w, t, rows, cols, f)
	case JSONL:
		return writeJSONL(w, t, rows, cols)
	}
	return fmt.Errorf("unknown export format %q", f)
}

func writeDelimited(w io.Writer, t *table.Table, rows []int32, cols []int, f Format) error {
	comma := byte(',')
	if f == TSV {
		comma = '\t'
	}
	// With one column, an empty cell is written as "": an empty line would
	// be skipped when the file is read back, losing the row.
	single := len(cols) == 1
	bw := bufio.NewWriterSize(w, 64<<10)
	var buf []byte
	line := func(cell func(i, ci int) string) error {
		buf = buf[:0]
		for i, ci := range cols {
			if i > 0 {
				buf = append(buf, comma)
			}
			buf = appendField(buf, cell(i, ci), comma, single)
		}
		buf = append(buf, '\n')
		_, err := bw.Write(buf)
		return err
	}
	if err := line(func(_, ci int) string { return t.Columns[ci].Name }); err != nil {
		return err
	}
	for _, r := range rows {
		err := line(func(_, ci int) string {
			c := t.Columns[ci]
			if c.IsMissing(int(r)) {
				return ""
			}
			return c.Raw[r]
		})
		if err != nil {
			return err
		}
	}
	return bw.Flush()
}

// appendField appends a CSV or TSV field, quoted as encoding/csv quotes it:
// when it holds the delimiter, a quote or a line break, or starts with a
// space or a tab; and, with quoteEmpty, when it is empty.
func appendField(b []byte, s string, comma byte, quoteEmpty bool) []byte {
	need := (s == "" && quoteEmpty) || (s != "" && (s[0] == ' ' || s[0] == '\t'))
	for i := 0; !need && i < len(s); i++ {
		switch s[i] {
		case comma, '"', '\r', '\n':
			need = true
		}
	}
	if !need {
		return append(b, s...)
	}
	b = append(b, '"')
	for i := 0; i < len(s); i++ {
		if s[i] == '"' {
			b = append(b, '"')
		}
		b = append(b, s[i])
	}
	return append(b, '"')
}

func writeJSONL(w io.Writer, t *table.Table, rows []int32, cols []int) error {
	bw := bufio.NewWriterSize(w, 64<<10)
	keys := make([][]byte, len(cols))
	for i, ci := range cols {
		keys[i] = append(appendString(nil, t.Columns[ci].Name), ':')
	}
	var buf []byte
	for _, r := range rows {
		buf = append(buf[:0], '{')
		for i, ci := range cols {
			if i > 0 {
				buf = append(buf, ',')
			}
			buf = append(buf, keys[i]...)
			buf = appendValue(buf, t.Columns[ci], int(r))
		}
		buf = append(buf, '}', '\n')
		if _, err := bw.Write(buf); err != nil {
			return err
		}
	}
	return bw.Flush()
}

// appendValue appends a cell as a JSON value of its column's type.
func appendValue(b []byte, c *table.Column, r int) []byte {
	if c.IsMissing(r) {
		return append(b, "null"...)
	}
	raw := c.Raw[r]
	if !c.HasValue(r) {
		return appendString(b, raw) // invalid text
	}
	switch c.Type {
	case table.Integer:
		return strconv.AppendInt(b, c.Ints[r], 10)
	case table.Number:
		if x := c.Floats[r]; !math.IsInf(x, 0) && !math.IsNaN(x) {
			return strconv.AppendFloat(b, x, 'g', -1, 64)
		}
	case table.Boolean:
		return strconv.AppendBool(b, strings.EqualFold(strings.TrimSpace(raw), "true"))
	case table.JSON:
		if s := strings.TrimSpace(raw); s != "" && (s[0] == '{' || s[0] == '[') && json.Valid([]byte(s)) {
			return append(b, s...)
		}
	}
	return appendString(b, raw)
}

const hex = "0123456789abcdef"

// appendString appends s as a JSON string. Invalid UTF-8 becomes U+FFFD,
// as encoding/json writes it.
func appendString(b []byte, s string) []byte {
	b = append(b, '"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch {
			case c == '"' || c == '\\':
				b = append(b, '\\', c)
			case c >= 0x20:
				b = append(b, c)
			case c == '\n':
				b = append(b, '\\', 'n')
			case c == '\r':
				b = append(b, '\\', 'r')
			case c == '\t':
				b = append(b, '\\', 't')
			default:
				b = append(b, '\\', 'u', '0', '0', hex[c>>4], hex[c&0xf])
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			b = append(b, `�`...)
		} else {
			b = append(b, s[i:i+size]...)
		}
		i += size
	}
	return append(b, '"')
}
