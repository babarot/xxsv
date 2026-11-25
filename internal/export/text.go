package export

import (
	"errors"
	"strings"

	"github.com/babarot/xxsv/internal/table"
)

// ErrTooLarge is returned by Text for cells that take more than its limit.
var ErrTooLarge = errors.New("too much text")

// Text writes cells for the clipboard, the way spreadsheets do: tabs between
// columns, line breaks between rows, no column names. The text is as the
// file has it, and a missing cell is empty. A single cell is its bare text.
// Among several, a cell is quoted only when it would otherwise be read as
// more than one: when it holds a tab or a line break, or starts with a quote.
// (CSV quotes more, which would show when JSON is pasted into an editor.)
func Text(t *table.Table, rows []int32, cols []int, limit int) (string, error) {
	var b strings.Builder
	single := len(rows) == 1 && len(cols) == 1
	for i, r := range rows {
		if i > 0 {
			b.WriteByte('\n')
		}
		for j, ci := range cols {
			if j > 0 {
				b.WriteByte('\t')
			}
			c := t.Columns[ci]
			if c.IsMissing(int(r)) {
				continue
			}
			s := c.Raw[r]
			if !single && (strings.ContainsAny(s, "\t\r\n") || strings.HasPrefix(s, `"`)) {
				s = `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
			}
			if b.Len()+len(s) > limit {
				return "", ErrTooLarge
			}
			b.WriteString(s)
		}
		if b.Len() > limit {
			return "", ErrTooLarge
		}
	}
	return b.String(), nil
}
