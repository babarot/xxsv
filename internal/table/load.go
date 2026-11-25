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
	"slices"
	"strconv"
	"strings"
)

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// LoadFile reads a CSV, TSV, LTSV or JSONL file.
func LoadFile(path string, opts Options) (*Table, error) {
	format := opts.Format
	if format == "" {
		format = formatFromExt(path)
	}
	if format == JSONL || format == LTSV {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		return loadLinesOf(format, data, opts)
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	br := bufio.NewReaderSize(f, 1<<20)
	if format == "" {
		format = sniff(br, opts)
	}
	if format == JSONL || format == LTSV {
		data, err := io.ReadAll(br)
		if err != nil {
			return nil, err
		}
		return loadLinesOf(format, data, opts)
	}
	var size int64
	if fi, err := f.Stat(); err == nil {
		size = fi.Size()
	}
	return loadDelimited(br, format, opts, size)
}

func loadLinesOf(format Format, data []byte, opts Options) (*Table, error) {
	if format == LTSV {
		return LoadLTSV(data, opts)
	}
	return LoadJSONL(data, opts)
}

// sniff tells a format by the content, for a file whose extension does not.
// CSV stands for TSV too; the delimiter is detected later. A delimiter or a
// header asked for means CSV or TSV, not LTSV, which has neither.
func sniff(br *bufio.Reader, opts Options) Format {
	switch {
	case looksLikeJSONL(br):
		return JSONL
	case opts.Delimiter == 0 && opts.Header == HeaderAuto && looksLikeLTSV(br):
		return LTSV
	}
	return CSV
}

func formatFromExt(path string) Format {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".tsv", ".tab":
		return TSV
	case ".ltsv":
		return LTSV
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
	return loadDelimited(r, format, opts, 0)
}

// loadDelimited is LoadDelimited for an input of size bytes, or of an
// unknown size when size is 0. The size and the length of the first rows
// give an estimate of the number of rows, so the columns are allocated
// once instead of growing (and being copied) all the way.
func loadDelimited(r io.Reader, format Format, opts Options, size int64) (*Table, error) {
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
	// Fields are substrings of a string allocated per record, so they stay
	// valid when the slice holding them is reused. Records kept past the
	// next read (the header and the type sample) are cloned.
	cr.ReuseRecord = true
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
	first = slices.Clone(first)
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
		sample = append(sample, slices.Clone(rec))
	}
	rows := len(sample)
	if off := cr.InputOffset(); size > off && off > 0 && rows > 0 {
		rows = int(float64(rows) * float64(size) / float64(off) * 1.05)
	}

	t.Columns = make([]*Column, len(names))
	for ci, name := range names {
		var cnt counter
		for _, rec := range sample {
			if ci < len(rec) {
				cnt.addText(rec[ci])
			}
		}
		c := newColumn(name, rows)
		c.Type = cnt.typ()
		c.prepare(rows)
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
