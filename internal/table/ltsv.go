package table

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"slices"
)

// ltsvLines reads Labeled Tab-separated Values (http://ltsv.org): one record
// per line, label:value fields separated by tabs. What the format leaves
// open is read as most parsers do: the last of a repeated label counts, any
// text is taken as a label, and there are no escapes to undo.
var ltsvLines = lineFormat{
	format: LTSV,
	trim: func(line []byte) []byte {
		// Spaces can be part of a value; only a blank line is nothing.
		if len(bytes.TrimSpace(line)) == 0 {
			return nil
		}
		return bytes.TrimSuffix(line, []byte("\r"))
	},
	parse:  parseLTSV,
	split:  parseLTSV,
	decode: func(v []byte) cell { return cell{raw: view(v), kind: 's'} },
	encode: func(v []byte) string {
		b, _ := json.Marshal(string(v))
		return string(b)
	},
}

// LoadLTSV reads LTSV. The labels become columns, as the keys of JSONL do
// (see LoadJSONL). Lines with a field that has no label are skipped and
// counted.
func LoadLTSV(data []byte, opts Options) (*Table, error) {
	return loadLines(data, opts, ltsvLines)
}

// parseLTSV splits a line into its fields, in order. Empty fields, such as
// the one after a trailing tab, are nothing.
func parseLTSV(line []byte) ([]field, error) {
	var fields []field
	for part := range bytes.SplitSeq(line, []byte("\t")) {
		if len(part) == 0 {
			continue
		}
		label, value, ok := bytes.Cut(part, []byte(":"))
		if !ok || len(label) == 0 {
			return nil, errors.New("a field without a label")
		}
		f := field{key: view(label), val: value}
		if j := slices.IndexFunc(fields, func(x field) bool { return x.key == f.key }); j >= 0 {
			fields[j].val = f.val
		} else {
			fields = append(fields, f)
		}
	}
	return fields, nil
}

// ltsvLabelRE is what a label looks like when the format is detected: the
// characters of the specification, and not starting like a number, so that
// a time of day (12:30) is not a field labeled 12.
var ltsvLabelRE = regexp.MustCompile(`^[A-Za-z_][0-9A-Za-z_.-]*$`)

// looksLikeLTSV reports whether the first lines are LTSV: the first one, and
// more than half of the first 20, since logs have broken lines. A TSV with a
// row of column names fails on the first.
func looksLikeLTSV(br *bufio.Reader) bool {
	head, err := br.Peek(64 << 10)
	head = bytes.TrimPrefix(head, utf8BOM)
	whole := err == io.EOF
	lines, good := 0, 0
	for len(head) > 0 && lines < 20 {
		line, rest, complete := bytes.Cut(head, []byte("\n"))
		head = rest
		if !complete && !whole {
			if lines > 0 {
				break
			}
			// Only the start of a long first line. Its last field is cut,
			// maybe before the colon.
			if i := bytes.LastIndexByte(line, '\t'); i >= 0 && bytes.IndexByte(line[i:], ':') < 0 {
				line = line[:i]
			}
		}
		line = ltsvLines.trim(line)
		if len(line) == 0 {
			continue
		}
		lines++
		if isLTSVLine(line) {
			good++
		} else if lines == 1 {
			return false
		}
	}
	return good*2 > lines
}

// isLTSVLine reports whether a line has two fields or more, all of them
// label:value, with different labels. URLs (https://...) are not fields, so
// a line of them is not LTSV.
func isLTSVLine(line []byte) bool {
	seen := map[string]bool{}
	for part := range bytes.SplitSeq(line, []byte("\t")) {
		if len(part) == 0 {
			continue
		}
		label, value, ok := bytes.Cut(part, []byte(":"))
		if !ok || !ltsvLabelRE.Match(label) || seen[string(label)] || bytes.HasPrefix(value, []byte("//")) {
			return false
		}
		seen[string(label)] = true
	}
	return len(seen) >= 2
}
