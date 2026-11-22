package table

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// LoadFile reads a CSV, TSV or JSONL file.
func LoadFile(path string, opts Options) (*Table, error) {
	format := opts.Format
	if format == "" {
		format = formatFromExt(path)
	}
	if format == JSONL {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		return LoadJSONL(data, opts)
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	br := bufio.NewReaderSize(f, 1<<20)
	if format == "" && looksLikeJSONL(br) {
		data, err := io.ReadAll(br)
		if err != nil {
			return nil, err
		}
		return LoadJSONL(data, opts)
	}
	if format == "" {
		format = CSV
	}
	return LoadDelimited(br, format, opts)
}

func formatFromExt(path string) Format {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".tsv", ".tab":
		return TSV
	case ".jsonl", ".ndjson":
		return JSONL
	case ".csv":
		return CSV
	}
	return ""
}

// looksLikeJSONL reports whether the first non-space byte (after a BOM) is
// '{'. A CSV file cannot start like that unless its first header is "{".
func looksLikeJSONL(br *bufio.Reader) bool {
	b, _ := br.Peek(4096)
	b = bytes.TrimPrefix(b, utf8BOM)
	b = bytes.TrimLeft(b, " \t\r\n")
	return len(b) > 0 && b[0] == '{'
}

// LoadDelimited reads CSV or TSV from r. format is CSV or TSV; the
// delimiter is detected unless opts.Delimiter is set or format is TSV.
func LoadDelimited(r io.Reader, format Format, opts Options) (*Table, error) {
	br, ok := r.(*bufio.Reader)
	if !ok {
		br = bufio.NewReaderSize(r, 1<<20)
	}
	if b, _ := br.Peek(3); bytes.Equal(b, utf8BOM) {
		_, _ = br.Discard(3)
	}

	delim := opts.Delimiter
	if delim == 0 {
		if format == TSV {
			delim = '\t'
		} else {
			head, _ := br.Peek(64 << 10)
			delim = detectDelimiter(head)
		}
	}
	t := &Table{Format: CSV, Delimiter: delim}
	if delim == '\t' {
		t.Format = TSV
	}

	cr := csv.NewReader(br)
	cr.Comma = delim
	cr.LazyQuotes = true
	cr.FieldsPerRecord = -1
	read := func() ([]string, error) {
		rec, err := cr.Read()
		if pe, ok := errors.AsType[*csv.ParseError](err); ok {
			return nil, fmt.Errorf("line %d: %w", pe.Line, pe.Err)
		}
		return rec, err
	}

	first, err := read()
	if err == io.EOF {
		return t, nil
	}
	if err != nil {
		return nil, err
	}

	var sample [][]string
	t.HeaderGenerated = opts.Header == HeaderNo || (opts.Header == HeaderAuto && hasBareNumber(first))
	var names []string
	if t.HeaderGenerated {
		names = make([]string, len(first))
		sample = append(sample, first)
	} else {
		names = first
	}
	names = uniqueNames(names)

	for len(sample) < typeSample {
		rec, err := read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		sample = append(sample, rec)
	}

	t.Columns = make([]*Column, len(names))
	for ci, name := range names {
		var cnt counter
		for _, rec := range sample {
			if ci < len(rec) {
				cnt.addText(rec[ci])
			}
		}
		c := newColumn(name, len(sample))
		c.Type = cnt.typ()
		c.prepare(len(sample))
		t.Columns[ci] = c
	}

	add := func(rec []string) {
		if len(rec) != len(t.Columns) {
			t.RaggedRows++
		}
		for ci, c := range t.Columns {
			raw, null := "", true
			if ci < len(rec) {
				raw, null = rec[ci], false
			}
			if err := c.push(raw, null); err != nil {
				c.toString()
			}
		}
		t.Rows++
	}
	for _, rec := range sample {
		add(rec)
	}
	for {
		rec, err := read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		add(rec)
	}
	return t, nil
}

// detectDelimiter picks tab or comma from the first records of a file:
// whichever appears the same, non-zero number of times in every record,
// preferring the more frequent one when both qualify. Delimiters inside
// double quotes do not count.
func detectDelimiter(head []byte) rune {
	type tally struct{ tabs, commas int }
	var recs []tally
	var cur tally
	inQuote, complete := false, false
	for _, b := range head {
		switch {
		case b == '"':
			inQuote = !inQuote
		case inQuote:
		case b == '\t':
			cur.tabs++
		case b == ',':
			cur.commas++
		case b == '\n':
			recs = append(recs, cur)
			cur, complete = tally{}, true
			if len(recs) == 20 {
				goto done
			}
		}
	}
	// A file with no newline at all is a single, complete record.
	if !complete {
		recs = append(recs, cur)
	}
done:
	consistent := func(get func(tally) int) (int, bool) {
		if len(recs) == 0 || get(recs[0]) == 0 {
			return 0, false
		}
		for _, r := range recs[1:] {
			if get(r) != get(recs[0]) {
				return get(recs[0]), false
			}
		}
		return get(recs[0]), true
	}
	tabs, tabOK := consistent(func(t tally) int { return t.tabs })
	commas, commaOK := consistent(func(t tally) int { return t.commas })
	switch {
	case tabOK && !commaOK:
		return '\t'
	case commaOK && !tabOK:
		return ','
	case tabs > commas:
		return '\t'
	}
	return ','
}

// bareNumberRE is a cell that is only a number, leading zeros allowed: a
// first row of 007 or 00097 is data, not names.
var bareNumberRE = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

// hasBareNumber reports whether a cell of the first row is only a number,
// which header names almost never are.
func hasBareNumber(rec []string) bool {
	for _, s := range rec {
		if bareNumberRE.MatchString(strings.TrimSpace(s)) {
			return true
		}
	}
	return false
}

// uniqueNames fills empty names with colN and makes duplicates unique by
// appending _2, _3, ...
func uniqueNames(names []string) []string {
	out := make([]string, len(names))
	seen := make(map[string]bool, len(names))
	for i, n := range names {
		n = strings.TrimSpace(n)
		if n == "" {
			n = "col" + strconv.Itoa(i+1)
		}
		base := n
		for k := 2; seen[n]; k++ {
			n = base + "_" + strconv.Itoa(k)
		}
		seen[n] = true
		out[i] = n
	}
	return out
}
