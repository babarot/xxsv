// Package query filters, sorts and pages a table.Table.
//
// A query is a filter, a sort and a page (offset and limit). Filtering and
// sorting produce the list of matching row numbers in order; that list is
// cached, so scrolling, which only changes the page, does not sort again.
package query

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/babarot/xxsv/internal/table"
)

// Query selects a page of rows.
type Query struct {
	// Search keeps rows where any cell contains the text. ASCII letters
	// match regardless of case; other characters must match exactly.
	Search  string   `json:"search,omitempty"`
	Filters []Filter `json:"filters,omitempty"`
	// Sorts are the sort keys, compared in order; at most MaxSortKeys.
	Sorts []Sort `json:"sorts,omitempty"`
	// Columns are the columns to return and their order, by name; empty
	// means every column in file order. They also set what an aggregate
	// range's columns refer to.
	Columns []string `json:"columns,omitempty"`
	Offset  int      `json:"offset"`
	Limit   int      `json:"limit"`
	// MaxCellBytes cuts each returned cell to about this many bytes, at a
	// character boundary; 0 means DefaultMaxCellBytes. A Claude Code
	// session can hold cells of more than 1 MB.
	MaxCellBytes int `json:"maxCellBytes,omitempty"`
}

// Filter keeps the rows whose cell in Column satisfies Op.
type Filter struct {
	Column string `json:"column"`
	Op     Op     `json:"op"`
	// Value is the text for OpContains and OpEquals.
	Value string `json:"value,omitempty"`
	// Min and Max bound OpRange, inclusive; either may be empty. They are
	// read as the column's type: an integer, a number, or a date or
	// datetime (a date is accepted for a datetime column).
	Min string `json:"min,omitempty"`
	Max string `json:"max,omitempty"`
}

// Op is a filter operation.
type Op string

const (
	OpContains Op = "contains" // any column: the raw text contains Value
	OpEquals   Op = "equals"   // any column: the raw text equals Value; booleans ignore case
	OpRange    Op = "range"    // integer, number, date and datetime columns
	OpNull     Op = "null"     // the cell is missing
	OpNotNull  Op = "notnull"  // the cell is not missing (a value, or invalid)
	OpInvalid  Op = "invalid"  // the cell's text is not a value of the column's type
)

// Sort is one sort key: a column and its direction. On each key, invalid,
// then missing cells come after the values in both directions; rows equal
// on every key keep the file order.
type Sort struct {
	Column string `json:"column"`
	Desc   bool   `json:"desc,omitempty"`
}

// Result is a page of rows.
type Result struct {
	// Total is the number of rows that match, before paging.
	Total int `json:"total"`
	// RowIDs are the matched rows' positions in the file, starting at 0.
	RowIDs []int `json:"rowIds"`
	// Rows holds the cells' raw text, cut to MaxCellBytes, in the columns
	// of the query (Query.Columns).
	Rows [][]string `json:"rows"`
	// Cols are the file positions of the returned columns, in their order.
	Cols []int `json:"-"`
	// Cut lists the cells that were cut, as [row index in Rows, column in
	// Rows].
	Cut [][2]int `json:"cut,omitempty"`
}

// Limits on a page.
const (
	DefaultLimit        = 200
	MaxLimit            = 5000
	DefaultMaxCellBytes = 1000
	MaxSortKeys         = 5
)

// ErrBadQuery wraps errors in a query: an unknown column, an operation the
// column's type does not support, or a bound that does not parse.
var ErrBadQuery = errors.New("bad query")

func badQuery(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrBadQuery, fmt.Sprintf(format, args...))
}

// Engine answers queries over one table. It is safe for concurrent use.
// The table must not change; a reloaded file gets a new Engine.
type Engine struct {
	t     *table.Table
	index map[string]int

	mu    sync.Mutex
	cache []cached // most recent first
}

type cached struct {
	key  string
	rows []int32
}

// cacheSize is how many filter-and-sort results are kept. A few let the
// user toggle between sorts without recomputing.
const cacheSize = 4

// New returns an Engine for t.
func New(t *table.Table) *Engine {
	index := make(map[string]int, len(t.Columns))
	for i, c := range t.Columns {
		index[c.Name] = i
	}
	return &Engine{t: t, index: index}
}

// Run answers q.
func (e *Engine) Run(q Query) (*Result, error) {
	if q.Offset < 0 {
		return nil, badQuery("negative offset")
	}
	limit := q.Limit
	switch {
	case limit <= 0:
		limit = DefaultLimit
	case limit > MaxLimit:
		limit = MaxLimit
	}
	maxCell := q.MaxCellBytes
	if maxCell <= 0 {
		maxCell = DefaultMaxCellBytes
	}
	cols, err := e.Columns(q.Columns)
	if err != nil {
		return nil, err
	}
	rows, err := e.match(q)
	if err != nil {
		return nil, err
	}
	res := &Result{Total: len(rows), RowIDs: []int{}, Rows: [][]string{}, Cols: cols}
	if q.Offset >= len(rows) {
		return res, nil
	}
	page := rows[q.Offset:min(len(rows), q.Offset+limit)]
	for ri, r := range page {
		res.RowIDs = append(res.RowIDs, int(r))
		out := make([]string, len(cols))
		for ci, fi := range cols {
			s := e.t.Columns[fi].Raw[r]
			if len(s) > maxCell {
				s = cut(s, maxCell)
				res.Cut = append(res.Cut, [2]int{ri, ci})
			}
			out[ci] = s
		}
		res.Rows = append(res.Rows, out)
	}
	return res, nil
}

// Columns returns the file positions of the named columns, in order: every
// column for none. A name the table lacks, or one given twice, is a bad
// query.
func (e *Engine) Columns(names []string) ([]int, error) {
	if len(names) == 0 {
		cols := make([]int, len(e.t.Columns))
		for i := range cols {
			cols[i] = i
		}
		return cols, nil
	}
	cols := make([]int, 0, len(names))
	seen := make(map[string]bool, len(names))
	for _, n := range names {
		i, ok := e.index[n]
		if !ok {
			return nil, badQuery("unknown column %q", n)
		}
		if seen[n] {
			return nil, badQuery("column %q given twice", n)
		}
		seen[n] = true
		cols = append(cols, i)
	}
	return cols, nil
}

// cut shortens s to at most n bytes without splitting a character.
func cut(s string, n int) string {
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// Range is a block of cells in the matched, sorted rows: rows R0..R1 (by
// position after filtering and sorting) and columns C0..C1 (by position in
// the query's columns), inclusive.
type Range struct {
	R0 int `json:"r0"`
	R1 int `json:"r1"`
	C0 int `json:"c0"`
	C1 int `json:"c1"`
}

// Aggregate summarises a range of cells, like a spreadsheet's status bar.
// Min, Max, Sum and Avg cover the integer and number cells only, and are
// nil when the range has none. Sum is also nil when it overflows float64.
type Aggregate struct {
	Count        int      `json:"count"`        // cells that are not missing
	NumericCount int      `json:"numericCount"` // of those, integer or number
	Sum          *float64 `json:"sum,omitempty"`
	Avg          *float64 `json:"avg,omitempty"`
	Min          *float64 `json:"min,omitempty"`
	Max          *float64 `json:"max,omitempty"`
}

// Aggregate summarises the cells of r in the rows q matches, in q's order.
// The range is clamped to the matched rows and the columns. It reuses the
// cached order, so scrolling or moving the range does not sort again.
func (e *Engine) Aggregate(q Query, r Range) (*Aggregate, error) {
	cols, err := e.Columns(q.Columns)
	if err != nil {
		return nil, err
	}
	rows, err := e.match(q)
	if err != nil {
		return nil, err
	}
	out := &Aggregate{}
	if r.R0 > r.R1 {
		r.R0, r.R1 = r.R1, r.R0
	}
	if r.C0 > r.C1 {
		r.C0, r.C1 = r.C1, r.C0
	}
	r.R0, r.C0 = max(r.R0, 0), max(r.C0, 0)
	r.R1, r.C1 = min(r.R1, len(rows)-1), min(r.C1, len(cols)-1)
	if r.R0 > r.R1 || r.C0 > r.C1 {
		return out, nil
	}
	// The mean is updated step by step (m += x/n - m/n) so it stays finite
	// for values near the float64 limit; the plain sum may overflow, and is
	// then left out, since JSON cannot carry +Inf.
	var sum, mean float64
	lo, hi := math.Inf(1), math.Inf(-1)
	for _, fi := range cols[r.C0 : r.C1+1] {
		c := e.t.Columns[fi]
		for _, row := range rows[r.R0 : r.R1+1] {
			i := int(row)
			if c.IsMissing(i) {
				continue
			}
			out.Count++
			if !c.HasValue(i) {
				continue // invalid text counts, but has no number
			}
			var x float64
			switch c.Type {
			case table.Integer:
				x = float64(c.Ints[i])
			case table.Number:
				x = c.Floats[i]
			default:
				continue
			}
			out.NumericCount++
			sum += x
			n := float64(out.NumericCount)
			mean += x/n - mean/n
			lo, hi = math.Min(lo, x), math.Max(hi, x)
		}
	}
	if out.NumericCount > 0 {
		out.Avg, out.Min, out.Max = &mean, &lo, &hi
		if !math.IsInf(sum, 0) && !math.IsNaN(sum) {
			out.Sum = &sum
		}
	}
	return out, nil
}

// match returns the matching rows in order, from the cache when possible.
func (e *Engine) match(q Query) ([]int32, error) {
	keyBytes, _ := json.Marshal(struct {
		S string
		F []Filter
		O []Sort
	}{q.Search, q.Filters, q.Sorts})
	key := string(keyBytes)

	e.mu.Lock()
	for i, c := range e.cache {
		if c.key == key {
			// move to the front
			copy(e.cache[1:i+1], e.cache[:i])
			e.cache[0] = c
			e.mu.Unlock()
			return c.rows, nil
		}
	}
	e.mu.Unlock()

	rows, err := e.compute(q)
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	e.cache = append([]cached{{key, rows}}, e.cache...)
	if len(e.cache) > cacheSize {
		e.cache = e.cache[:cacheSize]
	}
	e.mu.Unlock()
	return rows, nil
}

func (e *Engine) compute(q Query) ([]int32, error) {
	preds := make([]func(int) bool, 0, len(q.Filters)+1)
	for _, f := range q.Filters {
		p, err := e.compile(f)
		if err != nil {
			return nil, err
		}
		preds = append(preds, p)
	}
	if q.Search != "" {
		needle := lowerASCII(q.Search)
		cols := e.t.Columns
		preds = append(preds, func(r int) bool {
			for _, c := range cols {
				if containsFold(c.Raw[r], needle) {
					return true
				}
			}
			return false
		})
	}

	if len(q.Sorts) > MaxSortKeys {
		return nil, badQuery("%d sort keys; at most %d", len(q.Sorts), MaxSortKeys)
	}
	keys := make([]sortKey, 0, len(q.Sorts))
	for _, k := range q.Sorts {
		i, ok := e.index[k.Column]
		if !ok {
			return nil, badQuery("unknown sort column %q", k.Column)
		}
		keys = append(keys, sortKey{e.t.Columns[i], k.Desc})
	}

	rows := e.filter(preds)
	if len(keys) > 0 {
		sortRows(rows, keys)
	}
	return rows, nil
}

// filter runs the predicates over all rows, splitting the rows across CPUs.
func (e *Engine) filter(preds []func(int) bool) []int32 {
	n := e.t.Rows
	if len(preds) == 0 {
		rows := make([]int32, n)
		for i := range rows {
			rows[i] = int32(i)
		}
		return rows
	}
	workers := min(runtime.GOMAXPROCS(0), max(1, n/50_000))
	parts := make([][]int32, workers)
	var wg sync.WaitGroup
	for w := range workers {
		lo, hi := n*w/workers, n*(w+1)/workers
		wg.Go(func() {
			var out []int32
		rows:
			for r := lo; r < hi; r++ {
				for _, p := range preds {
					if !p(r) {
						continue rows
					}
				}
				out = append(out, int32(r))
			}
			parts[w] = out
		})
	}
	wg.Wait()
	return slices.Concat(parts...)
}

func (e *Engine) compile(f Filter) (func(int) bool, error) {
	i, ok := e.index[f.Column]
	if !ok {
		return nil, badQuery("unknown filter column %q", f.Column)
	}
	c := e.t.Columns[i]
	switch f.Op {
	case OpNull:
		return c.IsMissing, nil
	case OpNotNull:
		return func(r int) bool { return !c.IsMissing(r) }, nil
	case OpInvalid:
		return c.IsInvalid, nil
	case OpContains:
		needle := lowerASCII(f.Value)
		return func(r int) bool { return containsFold(c.Raw[r], needle) }, nil
	case OpEquals:
		if c.Type == table.Boolean {
			want := strings.TrimSpace(f.Value)
			return func(r int) bool {
				return c.HasValue(r) && strings.EqualFold(strings.TrimSpace(c.Raw[r]), want)
			}, nil
		}
		return func(r int) bool { return c.Raw[r] == f.Value }, nil
	case OpRange:
		return compileRange(c, f)
	}
	return nil, badQuery("unknown filter op %q", f.Op)
}

func compileRange(c *table.Column, f Filter) (func(int) bool, error) {
	switch c.Type {
	case table.Integer, table.Date, table.Datetime:
		lo, hi := int64(-1<<63), int64(1<<63-1)
		parse := func(s string) (int64, error) {
			if c.Type == table.Integer {
				return strconv.ParseInt(strings.TrimSpace(s), 10, 64)
			}
			return table.ParseTime(s, c.Type)
		}
		var err error
		if f.Min != "" {
			if lo, err = parse(f.Min); err != nil {
				return nil, badQuery("min %q for column %q: %v", f.Min, c.Name, err)
			}
		}
		if f.Max != "" {
			if hi, err = parse(f.Max); err != nil {
				return nil, badQuery("max %q for column %q: %v", f.Max, c.Name, err)
			}
		}
		return func(r int) bool { return c.HasValue(r) && c.Ints[r] >= lo && c.Ints[r] <= hi }, nil
	case table.Number:
		lo, hi := math.Inf(-1), math.Inf(1)
		var err error
		if f.Min != "" {
			if lo, err = strconv.ParseFloat(strings.TrimSpace(f.Min), 64); err != nil {
				return nil, badQuery("min %q for column %q: %v", f.Min, c.Name, err)
			}
		}
		if f.Max != "" {
			if hi, err = strconv.ParseFloat(strings.TrimSpace(f.Max), 64); err != nil {
				return nil, badQuery("max %q for column %q: %v", f.Max, c.Name, err)
			}
		}
		return func(r int) bool { return c.HasValue(r) && c.Floats[r] >= lo && c.Floats[r] <= hi }, nil
	}
	return nil, badQuery("range filter on %s column %q", c.Type, c.Name)
}

type sortKey struct {
	c    *table.Column
	desc bool
}

// sortRows sorts row numbers by the keys in order, ties in file order.
func sortRows(rows []int32, keys []sortKey) {
	cmps := make([]func(a, b int32) int, len(keys))
	for i, k := range keys {
		cmps[i] = keyCompare(k.c, k.desc)
	}
	// Comparing row numbers last makes the order total, so the faster
	// unstable sort gives the same result as a stable one.
	if len(cmps) == 1 {
		cmp := cmps[0]
		slices.SortFunc(rows, func(a, b int32) int {
			if r := cmp(a, b); r != 0 {
				return r
			}
			return cmp3(int64(a), int64(b))
		})
		return
	}
	slices.SortFunc(rows, func(a, b int32) int {
		for _, cmp := range cmps {
			if r := cmp(a, b); r != 0 {
				return r
			}
		}
		return cmp3(int64(a), int64(b))
	})
}

// keyCompare compares two rows on one column. Values come first in the order
// asked for, then invalid cells, then missing ones, both last in either
// direction; two invalid or two missing cells are equal on this key.
func keyCompare(c *table.Column, desc bool) func(a, b int32) int {
	sign := 1
	if desc {
		sign = -1
	}
	var cmpValues func(a, b int32) int
	switch c.Type {
	case table.Integer, table.Date, table.Datetime:
		v := c.Ints
		cmpValues = func(a, b int32) int { return cmp3(v[a], v[b]) }
	case table.Number:
		v := c.Floats
		cmpValues = func(a, b int32) int { return cmp3(v[a], v[b]) }
	case table.Boolean:
		// false < true. Raw holds any case and spacing, so read each cell
		// once instead of in every comparison.
		v := make([]int64, len(c.Raw))
		for i, s := range c.Raw {
			if strings.EqualFold(strings.TrimSpace(s), "true") {
				v[i] = 1
			}
		}
		cmpValues = func(a, b int32) int { return cmp3(v[a], v[b]) }
	default:
		v := c.Raw
		cmpValues = func(a, b int32) int { return strings.Compare(v[a], v[b]) }
	}
	kind := func(r int32) int64 {
		switch {
		case c.HasValue(int(r)):
			return 0
		case c.IsInvalid(int(r)):
			return 1
		}
		return 2
	}
	return func(a, b int32) int {
		// Most pairs both hold values: one bit test each.
		if !c.HasValue(int(a)) || !c.HasValue(int(b)) {
			return cmp3(kind(a), kind(b))
		}
		return sign * cmpValues(a, b)
	}
}

func cmp3[T int64 | float64](a, b T) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func lowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + 'a' - 'A'
		}
	}
	return string(b)
}

// containsFold reports whether s contains needle, which must be lower-case
// ASCII-wise. ASCII letters in s match regardless of case. It does not
// allocate.
func containsFold(s, needle string) bool {
	n := len(needle)
	if n == 0 {
		return true
	}
	first := needle[0]
	upper := first
	if 'a' <= first && first <= 'z' {
		upper = first - ('a' - 'A')
	}
	for i := 0; i+n <= len(s); i++ {
		if c := s[i]; c != first && c != upper {
			continue
		}
		j := 1
		for ; j < n; j++ {
			c := s[i+j]
			if 'A' <= c && c <= 'Z' {
				c += 'a' - 'A'
			}
			if c != needle[j] {
				break
			}
		}
		if j == n {
			return true
		}
	}
	return false
}
