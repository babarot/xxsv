package query

import (
	"slices"
	"strings"

	"github.com/babarot/xxsv/internal/table"
)

// Values are the distinct values of a column over the rows a query matches,
// most frequent first, and values of the same count in the order they first
// appear in the file (sorting a million distinct values as text would take
// several times longer).
type Values struct {
	// Distinct is the number of distinct values (a missing cell counts as
	// one); Rows is the number of rows the query matches.
	Distinct int `json:"distinct"`
	Rows     int `json:"rows"`
	// Total is the number of items that match the search, before paging.
	Total int         `json:"total"`
	Items []ValueItem `json:"items"`
}

// ValueItem is one value and the number of rows that hold it.
type ValueItem struct {
	// Value is the text, cut to MaxCellBytes when Cut is set; for a
	// boolean value, its lower-case form.
	Value   string `json:"value"`
	Count   int    `json:"count"`
	Missing bool   `json:"missing,omitempty"`
	Cut     bool   `json:"cut,omitempty"`
	// RowID is the first row (by position in the file) that holds the
	// value, to fetch the whole of a cut one.
	RowID int `json:"rowId"`
}

// ValuesQuery picks a page of a column's values: in the rows Query matches
// leaving out its filters on that column (its sort and columns do not
// matter), those containing Search (ASCII letters ignoring case, as the
// table's search), from Offset. Leaving out the column's own filters lists
// the values a filter on it can switch to, as a spreadsheet's filter does;
// only filters directly in Query.Filters are left out, not those in groups.
type ValuesQuery struct {
	Query  Query  `json:"query"`
	Column string `json:"column"`
	Search string `json:"search,omitempty"`
	Offset int    `json:"offset"`
	Limit  int    `json:"limit"`
}

type valueGroup struct {
	value   string
	count   int
	missing bool
	rowID   int32
}

type cachedValues struct {
	key    string
	groups []valueGroup
}

// Values counts the values of a column the way OpEquals matches them, so a
// value's count is the number of rows a filter on it keeps: boolean values
// regardless of case and surrounding spaces, any other text (invalid text in
// a boolean column too) exactly as written. Missing cells are one item.
func (e *Engine) Values(vq ValuesQuery) (*Values, error) {
	if vq.Offset < 0 {
		return nil, badQuery("negative offset")
	}
	ci, ok := e.index[vq.Column]
	if !ok {
		return nil, badQuery("unknown column %q", vq.Column)
	}
	limit := vq.Limit
	switch {
	case limit <= 0:
		limit = DefaultLimit
	case limit > MaxLimit:
		limit = MaxLimit
	}
	q := Query{Search: vq.Query.Search, Regex: vq.Query.Regex}
	for _, f := range vq.Query.Filters {
		if f.isGroup() || f.Column != vq.Column {
			q.Filters = append(q.Filters, f)
		}
	}
	rows, err := e.match(q)
	if err != nil {
		return nil, err
	}
	groups := e.valueGroups(q, ci, rows)
	out := &Values{Distinct: len(groups), Rows: len(rows), Items: []ValueItem{}}
	needle := lowerASCII(vq.Search)
	for _, g := range groups {
		if needle != "" && (g.missing || !containsFold(g.value, needle)) {
			continue
		}
		out.Total++
		if out.Total <= vq.Offset || len(out.Items) >= limit {
			continue
		}
		it := ValueItem{Value: g.value, Count: g.count, Missing: g.missing, RowID: int(g.rowID)}
		if len(it.Value) > DefaultMaxCellBytes {
			it.Value, it.Cut = cut(it.Value, DefaultMaxCellBytes), true
		}
		out.Items = append(out.Items, it)
	}
	return out, nil
}

// valueGroups counts a column's values in rows, from the cache when the
// same filter and column were counted last.
func (e *Engine) valueGroups(q Query, ci int, rows []int32) []valueGroup {
	key := e.key(q) + "\x00" + e.t.Columns[ci].Name
	e.mu.Lock()
	for _, c := range e.values {
		if c.key == key {
			e.mu.Unlock()
			return c.groups
		}
	}
	e.mu.Unlock()

	c := e.t.Columns[ci]
	// Sized up front from a sample of the rows: a column of mostly distinct
	// values would otherwise grow the map many times.
	index := make(map[string]int, sizeHint(c, rows))
	var groups []valueGroup
	missing := -1
	for _, r32 := range rows {
		r := int(r32)
		if c.IsMissing(r) {
			if missing < 0 {
				missing = len(groups)
				groups = append(groups, valueGroup{missing: true, rowID: r32})
			}
			groups[missing].count++
			continue
		}
		v := c.Raw[r]
		if c.HasValue(r) && c.Type == table.Boolean {
			v = strings.ToLower(strings.TrimSpace(v))
		}
		i, ok := index[v]
		if !ok {
			i = len(groups)
			index[v] = i
			groups = append(groups, valueGroup{value: v, rowID: r32})
		}
		groups[i].count++
	}
	slices.SortFunc(groups, func(a, b valueGroup) int {
		if a.count != b.count {
			return b.count - a.count
		}
		return int(a.rowID - b.rowID)
	})

	e.mu.Lock()
	e.values = append([]cachedValues{{key, groups}}, e.values...)
	if len(e.values) > cacheSize {
		e.values = e.values[:cacheSize]
	}
	e.mu.Unlock()
	return groups
}

// sizeHint guesses the number of distinct values in rows from the first
// 1000 of them.
func sizeHint(c *table.Column, rows []int32) int {
	n := min(len(rows), 1000)
	seen := make(map[string]struct{}, n)
	for _, r := range rows[:n] {
		seen[c.Raw[r]] = struct{}{}
	}
	if n == 0 {
		return 0
	}
	return len(rows) * len(seen) / n
}
