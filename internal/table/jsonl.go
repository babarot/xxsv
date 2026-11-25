package table

import (
	"bytes"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"unicode/utf8"
	"unsafe"
)

// field is one top-level key of a JSONL object, or one label of an LTSV
// line, in the order it appeared. val is the text of the value as the file
// has it (JSON text in JSONL), a slice of the input.
type field struct {
	key string
	val []byte
}

// parseObject reads one line as a JSON object and returns its top-level
// fields in order. A repeated key keeps its last value, as JavaScript does.
// It fails for anything that is not exactly one JSON object.
//
// encoding/json's Decoder reads about 40 MB/s, too slow for a 200 MB
// session file read twice, so the line is checked with json.Valid and then
// split by hand: only the top level needs to be understood.
func parseObject(line []byte) ([]field, error) {
	if !json.Valid(line) {
		return nil, errors.New("invalid JSON")
	}
	return splitObject(line)
}

// splitObject splits a line already known to be valid JSON.
func splitObject(b []byte) ([]field, error) {
	i := skipSpace(b, 0)
	if i >= len(b) || b[i] != '{' {
		return nil, errors.New("not a JSON object")
	}
	i = skipSpace(b, i+1)
	var fields []field
	if b[i] == '}' {
		return fields, nil
	}
	for {
		end := stringEnd(b, i)
		key := b[i:end]
		i = skipSpace(b, end)
		i = skipSpace(b, i+1) // ':'
		vend := valueEnd(b, i)
		f := field{key: unquote(key), val: b[i:vend]}
		if j := slices.IndexFunc(fields, func(x field) bool { return x.key == f.key }); j >= 0 {
			fields[j].val = f.val
		} else {
			fields = append(fields, f)
		}
		i = skipSpace(b, vend)
		if b[i] == '}' {
			return fields, nil
		}
		i = skipSpace(b, i+1) // ','
	}
}

func skipSpace(b []byte, i int) int {
	for i < len(b) && (b[i] == ' ' || b[i] == '\t' || b[i] == '\r' || b[i] == '\n') {
		i++
	}
	return i
}

// stringEnd returns the index just past the string that starts at b[i].
func stringEnd(b []byte, i int) int {
	for j := i + 1; j < len(b); j++ {
		switch b[j] {
		case '\\':
			j++
		case '"':
			return j + 1
		}
	}
	return len(b)
}

// valueEnd returns the index just past the value that starts at b[i].
func valueEnd(b []byte, i int) int {
	switch b[i] {
	case '"':
		return stringEnd(b, i)
	case '{', '[':
		depth := 0
		for j := i; j < len(b); j++ {
			switch b[j] {
			case '"':
				j = stringEnd(b, j) - 1
			case '{', '[':
				depth++
			case '}', ']':
				depth--
				if depth == 0 {
					return j + 1
				}
			}
		}
		return len(b)
	}
	j := i
	for j < len(b) && b[j] != ',' && b[j] != '}' && b[j] != ']' && b[j] != ' ' && b[j] != '\t' && b[j] != '\r' && b[j] != '\n' {
		j++
	}
	return j
}

// unquote returns the content of a JSON string. Without escapes it is a
// view of the input with no copy; the input is never modified, and the
// table keeps it alive for as long as it uses the strings.
func unquote(q []byte) string {
	body := q[1 : len(q)-1]
	if bytes.IndexByte(body, '\\') < 0 && utf8.Valid(body) {
		return view(body)
	}
	var s string
	if err := json.Unmarshal(q, &s); err != nil {
		return string(body)
	}
	return s
}

func view(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	return unsafe.String(&b[0], len(b))
}

// eachLine calls fn for every line of data that trim leaves something of,
// without a length limit: a Claude Code session can have lines of more than
// 1 MB.
func eachLine(data []byte, trim func([]byte) []byte, fn func(line []byte)) {
	for len(data) > 0 {
		var line []byte
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			line, data = data[:i], data[i+1:]
		} else {
			line, data = data, nil
		}
		line = trim(line)
		if len(line) > 0 {
			fn(line)
		}
	}
}

// cell is one decoded JSONL or LTSV value.
type cell struct {
	raw  string
	null bool
	kind byte // 's' string, 'n' number, 'b' bool, 'j' nested, 0 null or absent
}

func decodeCell(v []byte) cell {
	if len(v) == 0 {
		return cell{null: true}
	}
	switch v[0] {
	case '"':
		return cell{raw: unquote(v), kind: 's'}
	case 't', 'f':
		return cell{raw: view(v), kind: 'b'}
	case 'n':
		return cell{null: true}
	case '{', '[':
		return cell{raw: compact(v), kind: 'j'}
	}
	return cell{raw: view(v), kind: 'n'}
}

// compact removes insignificant whitespace from a nested value. Most JSONL
// is written compact already; then the value is used as it is.
func compact(v []byte) string {
	inString := false
	for i := 0; i < len(v); i++ {
		switch c := v[i]; {
		case inString && c == '\\':
			i++
		case c == '"':
			inString = !inString
		case !inString && (c == ' ' || c == '\t' || c == '\r' || c == '\n'):
			var buf bytes.Buffer
			if err := json.Compact(&buf, v); err != nil {
				return string(v)
			}
			return buf.String()
		}
	}
	return view(v)
}

func (c *counter) addCell(x cell) {
	switch x.kind {
	case 's':
		c.addText(x.raw)
	case 'n':
		c.n++
		c.nums++
		if isIntText(x.raw) {
			c.ints++
		}
	case 'b':
		c.n++
		c.bools++
	case 'j':
		c.n++
		c.nested++
	}
}

type keyInfo struct {
	order, count, lastRow int
}

// lineFormat is a format of one record per line, where each record names its
// own fields.
type lineFormat struct {
	format Format
	trim   func(line []byte) []byte           // nothing is left of a blank line
	parse  func(line []byte) ([]field, error) // fails for a line to skip
	split  func(line []byte) ([]field, error) // parse, for a line known to parse
	decode func(val []byte) cell
	encode func(val []byte) string // as JSON, for OtherKeysColumn
}

var jsonLines = lineFormat{
	format: JSONL,
	trim:   bytes.TrimSpace,
	parse:  parseObject,
	split:  splitObject,
	decode: decodeCell,
	encode: compact,
}

// LoadJSONL reads JSON Lines: one object per line, its top-level keys
// becoming columns. Lines that are not a JSON object are skipped and
// counted.
func LoadJSONL(data []byte, opts Options) (*Table, error) {
	return loadLines(data, opts, jsonLines)
}

// loadLines reads a format of one record per line.
//
// The data is read twice. The first pass counts the rows and how often each
// key appears; it decides which keys get a column. Keys that appear in few
// rows would add mostly empty cells, so when the number of columns or of
// empty cells would pass the limits, the rarest keys are folded into one
// JSON column, OtherKeysColumn.
func loadLines(data []byte, opts Options, lf lineFormat) (*Table, error) {
	data = bytes.TrimPrefix(data, utf8BOM)
	maxCols := opts.MaxColumns
	if maxCols <= 0 {
		maxCols = DefaultMaxColumns
	}
	maxEmpty := opts.MaxEmptyCells
	if maxEmpty <= 0 {
		maxEmpty = DefaultMaxEmptyCells
	}

	t := &Table{Format: lf.format}
	keys := map[string]*keyInfo{}
	var order []string
	var valid []bool // per non-blank line, from the first pass
	eachLine(data, lf.trim, func(line []byte) {
		fields, err := lf.parse(line)
		valid = append(valid, err == nil)
		if err != nil {
			t.SkippedLines++
			return
		}
		for _, f := range fields {
			ki := keys[f.key]
			if ki == nil {
				ki = &keyInfo{order: len(order), lastRow: -1}
				keys[f.key] = ki
				order = append(order, f.key)
			}
			if ki.lastRow != t.Rows {
				ki.count++
				ki.lastRow = t.Rows
			}
		}
		t.Rows++
	})
	rows := t.Rows

	// Pick keys from the most to the least frequent while both limits hold.
	byFreq := slices.Clone(order)
	slices.SortStableFunc(byFreq, func(a, b string) int { return keys[b].count - keys[a].count })
	var picked []string
	empty := 0
	for _, k := range byFreq {
		e := rows - keys[k].count
		if len(picked) >= maxCols || empty+e > maxEmpty {
			break
		}
		picked = append(picked, k)
		empty += e
	}
	folded := len(picked) < len(order)
	if folded && len(picked) >= maxCols {
		picked = picked[:maxCols-1] // leave room for OtherKeysColumn
	}
	t.FoldedKeys = len(order) - len(picked)
	slices.SortFunc(picked, func(a, b string) int { return keys[a].order - keys[b].order })

	colOf := make(map[string]int, len(picked))
	for i, k := range picked {
		colOf[k] = i
	}
	ncol := len(picked)
	if folded {
		ncol++
	}
	t.Columns = make([]*Column, ncol)
	for i, k := range picked {
		t.Columns[i] = newColumn(k, rows)
	}
	if folded {
		t.Columns[ncol-1] = newColumn(OtherKeysColumn, rows)
	}

	// Second pass: decode the cells, infer the types from the first
	// typeSample rows, then push every row.
	var sample [][]cell
	typed := false
	inferTypes := func() {
		for ci, c := range t.Columns {
			var cnt counter
			for _, row := range sample {
				cnt.addCell(row[ci])
			}
			c.Type = cnt.typ()
			if folded && ci == ncol-1 {
				c.Type = JSON
			}
			c.prepare(rows)
		}
		typed = true
	}
	push := func(row []cell) {
		for ci, c := range t.Columns {
			if row[ci].kind == 'j' && c.Type != JSON {
				c.toJSON()
			}
			if err := c.push(row[ci].raw, row[ci].null); err != nil {
				c.toString()
			}
		}
	}
	lineNo := -1
	eachLine(data, lf.trim, func(line []byte) {
		lineNo++
		if !valid[lineNo] {
			return
		}
		fields, _ := lf.split(line)
		row := make([]cell, ncol)
		for i := range row {
			row[i].null = true
		}
		var other []field
		for _, f := range fields {
			if ci, ok := colOf[f.key]; ok {
				row[ci] = lf.decode(f.val)
			} else {
				other = append(other, f)
			}
		}
		if folded && len(other) > 0 {
			row[ncol-1] = cell{raw: encodeObject(other, lf.encode), kind: 'j'}
		}
		if typed {
			push(row)
			return
		}
		sample = append(sample, row)
		if len(sample) == typeSample {
			inferTypes()
			for _, r := range sample {
				push(r)
			}
			sample = nil
		}
	})
	if !typed {
		inferTypes()
		for _, r := range sample {
			push(r)
		}
	}
	return t, nil
}

// encodeObject writes fields as one compact JSON object; encode writes a
// value as JSON.
func encodeObject(fields []field, encode func([]byte) string) string {
	var b strings.Builder
	b.WriteByte('{')
	for i, f := range fields {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(f.key)
		b.Write(k)
		b.WriteByte(':')
		b.WriteString(encode(f.val))
	}
	b.WriteByte('}')
	return b.String()
}
