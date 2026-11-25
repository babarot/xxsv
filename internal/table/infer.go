package table

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// What a value of each type looks like. A number whose integer part starts
// with 0 and has more digits (007, 00097) is not a number: the zeros are
// part of a code, such as a postal code. Dates and times are ISO 8601 only;
// 01/02/2024 is ambiguous.
var (
	intRE      = regexp.MustCompile(`^[+-]?(0|[1-9]\d*)$`)
	numRE      = regexp.MustCompile(`^[+-]?((0|[1-9]\d*)(\.\d*)?|\.\d+)([eE][+-]?\d+)?$`)
	dateRE     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	datetimeRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$`)
)

// isIntText and isNumText match intRE and numRE without the regexp engine,
// which is several times slower and runs on every cell of a number column.
// The tests check that they agree with the patterns.
func isIntText(s string) bool {
	if s != "" && (s[0] == '+' || s[0] == '-') {
		s = s[1:]
	}
	return wholeDigits(s) == len(s) && s != ""
}

// wholeDigits returns the length of the integer part at the start of s: one
// or more digits, not starting with 0 unless it is just 0. It returns 0 for
// none and -1 for a leading zero followed by digits.
func wholeDigits(s string) int {
	n := 0
	for n < len(s) && s[n] >= '0' && s[n] <= '9' {
		n++
	}
	if n > 1 && s[0] == '0' {
		return -1
	}
	return n
}

func isNumText(s string) bool {
	if s != "" && (s[0] == '+' || s[0] == '-') {
		s = s[1:]
	}
	n := wholeDigits(s)
	if n < 0 {
		return false
	}
	frac := 0
	if n < len(s) && s[n] == '.' {
		i := n + 1
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
		frac = i - n - 1
		s = s[i:]
	} else {
		s = s[n:]
	}
	if n == 0 && frac == 0 {
		return false // "." or nothing before the exponent
	}
	if s == "" {
		return true
	}
	if s[0] != 'e' && s[0] != 'E' {
		return false
	}
	s = s[1:]
	if s != "" && (s[0] == '+' || s[0] == '-') {
		s = s[1:]
	}
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return i > 0 && i == len(s)
}

// hasZone reports whether a datetime's text ends in a time zone: Z, +09:00
// or +0900.
func hasZone(s string) bool {
	if strings.HasSuffix(s, "Z") {
		return true
	}
	digit := func(b byte) bool { return b >= '0' && b <= '9' }
	for _, n := range []int{6, 5} { // +09:00, +0900
		if len(s) < n {
			continue
		}
		z := s[len(s)-n:]
		if (z[0] == '+' || z[0] == '-') && digit(z[1]) && digit(z[2]) && digit(z[n-2]) && digit(z[n-1]) && (n == 5 || z[3] == ':') {
			return true
		}
	}
	return false
}

// isNullText reports whether a cell's text marks a missing value in a
// column of numbers, dates, times or booleans, where such text cannot be a
// value. In a String column only empty text is missing ("NA" may be
// Namibia).
func isNullText(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return true
	}
	return strings.EqualFold(s, "null") || strings.EqualFold(s, "na") || strings.EqualFold(s, "nan")
}

// counter tallies what the sampled values of one column look like.
type counter struct {
	n, ints, nums, bools, dates, datetimes, nested, jsonText int
}

// addText counts a CSV cell or a JSON string.
func (c *counter) addText(s string) {
	if isNullText(s) {
		return
	}
	c.n++
	s = strings.TrimSpace(s)
	switch {
	case strings.EqualFold(s, "true") || strings.EqualFold(s, "false"):
		c.bools++
	case isIntText(s):
		c.ints++
		c.nums++
	case isNumText(s):
		c.nums++
	case datetimeRE.MatchString(s):
		c.datetimes++
	case dateRE.MatchString(s):
		c.dates++
	case isJSONText(s):
		c.jsonText++
	}
}

// isJSONText reports whether a cell holds a JSON object or array, as a
// CSV/TSV column of JSON does. Other JSON values (numbers, strings, true)
// are left to the other types.
func isJSONText(s string) bool {
	return len(s) >= 2 && (s[0] == '{' || s[0] == '[') && json.Valid([]byte(s))
}

func (c *counter) typ() Type {
	if c.n == 0 {
		return String
	}
	// A JSONL column with any nested value is JSON: the other values are
	// kept as their JSON text rather than lost as missing.
	if c.nested > 0 {
		return JSON
	}
	frac := func(x int) float64 { return float64(x) / float64(c.n) }
	switch {
	case frac(c.bools) >= 0.99:
		return Boolean
	case c.datetimes > 0 && frac(c.datetimes+c.dates) >= 0.95:
		return Datetime // a bare date is midnight
	case frac(c.dates) >= 0.95:
		return Date
	case frac(c.ints) >= 0.95:
		return Integer
	case frac(c.nums) >= 0.95:
		return Number
	case frac(c.jsonText) >= 0.95:
		return JSON
	}
	return String
}

// prepare allocates the typed array for the column's type.
func (c *Column) prepare(rows int) {
	switch c.Type {
	case Integer, Date, Datetime:
		c.Ints = make([]int64, 0, rows)
	case Number:
		c.Floats = make([]float64, 0, rows)
	}
}

// overflowError is returned by push when an Integer column meets an integer
// outside int64; the caller then turns the column into a String column, as
// a float64 would lose precision too.
type overflowError struct{}

func (overflowError) Error() string { return "integer out of int64 range" }

// isMissingText reports whether a cell's text is missing for a column of
// type t (see isNullText).
func isMissingText(s string, t Type) bool {
	switch t {
	case String:
		return strings.TrimSpace(s) == ""
	case JSON:
		s = strings.TrimSpace(s)
		return s == "" || s == "null"
	}
	return isNullText(s)
}

// push appends one cell. null marks a cell that is missing regardless of its
// text (an absent JSONL key or LTSV label, or a JSON null). A cell with text that is not a
// value of the column's type is invalid.
func (c *Column) push(raw string, null bool) error {
	i := len(c.Raw)
	c.Raw = append(c.Raw, raw)
	if i>>6 >= len(c.nulls) {
		c.nulls = append(c.nulls, 0)
		c.invalid = append(c.invalid, 0)
	}
	null = null || isMissingText(raw, c.Type)
	bad := false
	s := strings.TrimSpace(raw)
	switch c.Type {
	case Integer:
		var n int64
		if !null {
			if !isIntText(s) {
				bad = true
			} else if v, err := strconv.ParseInt(s, 10, 64); err != nil {
				c.Ints = append(c.Ints, 0)
				c.setNull(i)
				return overflowError{}
			} else {
				n = v
			}
		}
		c.Ints = append(c.Ints, n)
	case Number:
		var x float64
		if !null {
			v, err := strconv.ParseFloat(s, 64)
			if !isNumText(s) || err != nil || math.IsInf(v, 0) || math.IsNaN(v) {
				bad = true
			} else {
				x = v
			}
		}
		c.Floats = append(c.Floats, x)
	case Date, Datetime:
		var ms int64
		if !null {
			var ok bool
			if ms, ok = parseTime(raw, c.Type); !ok {
				bad, ms = true, 0
			} else if c.Type == Datetime {
				if hasZone(s) {
					c.zoned++
				} else {
					c.naive++
				}
			}
		}
		c.Ints = append(c.Ints, ms)
	case Boolean:
		if !null {
			bad = !strings.EqualFold(s, "true") && !strings.EqualFold(s, "false")
		}
	}
	switch {
	case bad:
		c.setInvalid(i)
	case null:
		c.setNull(i)
	}
	return nil
}

// resetKinds sets the missing bits again after the column's type changed;
// such a column has no invalid cells.
func (c *Column) resetKinds() {
	c.Ints, c.Floats = nil, nil
	c.zoned, c.naive = 0, 0
	for i := range c.nulls {
		c.nulls[i], c.invalid[i] = 0, 0
	}
	for i, s := range c.Raw {
		if isMissingText(s, c.Type) {
			c.setNull(i)
		}
	}
}

// toString turns the column into a String column, when an integer outside
// int64 shows up. Raw already holds every cell, so only the typed array and
// the bits change.
func (c *Column) toString() {
	c.Type = String
	c.resetKinds()
}

// toJSON turns the column into a JSON column, when a nested value shows up
// after the rows used to infer its type. A JSON cell is missing when its
// text is empty or null: an absent key, a JSON null, "", null.
func (c *Column) toJSON() {
	c.Type = JSON
	c.resetKinds()
}

var datetimeLayouts = []string{
	time.RFC3339Nano,
	"2006-01-02T15:04:05.999999999Z0700",
	"2006-01-02 15:04:05.999999999Z07:00",
	"2006-01-02 15:04:05.999999999Z0700",
	"2006-01-02T15:04:05.999999999",
	"2006-01-02 15:04:05.999999999",
	"2006-01-02T15:04Z07:00",
	"2006-01-02 15:04Z07:00",
	"2006-01-02T15:04",
	"2006-01-02 15:04",
}

// ParseTime reads a date or datetime as Unix milliseconds (UTC when the
// text has no zone). For a Datetime it also accepts a bare date.
func ParseTime(s string, t Type) (int64, error) {
	if ms, ok := parseTime(s, t); ok {
		return ms, nil
	}
	return 0, fmt.Errorf("not a %s: %q", t, s)
}

// parseTime returns Unix milliseconds. Values without a zone are read as UTC.
func parseTime(s string, t Type) (int64, bool) {
	s = strings.TrimSpace(s)
	if t == Datetime {
		for _, layout := range datetimeLayouts {
			if tm, err := time.Parse(layout, s); err == nil {
				return tm.UnixMilli(), true
			}
		}
	}
	tm, err := time.Parse(time.DateOnly, s)
	return tm.UnixMilli(), err == nil
}
