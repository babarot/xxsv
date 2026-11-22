package table

import (
	"encoding/json"
	"math"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// uniqueLimit caps the distinct values counted per column; past it the
// count is reported as approximate.
const uniqueLimit = 100_000

// Stats summarises one column.
type Stats struct {
	Name         string `json:"name"`
	Type         Type   `json:"type"`
	Count        int    `json:"count"`   // cells with a value of the column's type
	Nulls        int    `json:"nulls"`   // missing cells
	Invalid      int    `json:"invalid"` // cells whose text is not a value of the type
	Unique       int    `json:"unique"`
	UniqueApprox bool   `json:"uniqueApprox"`

	// Integer, Number, Date and Datetime columns. Min and Max are exact for
	// integers; dates and datetimes are Unix milliseconds.
	Min       *json.Number `json:"min,omitempty"`
	Max       *json.Number `json:"max,omitempty"`
	Mean      *float64     `json:"mean,omitempty"`   // Integer and Number only
	Median    *float64     `json:"median,omitempty"` // Integer and Number only
	Std       *float64     `json:"std,omitempty"`    // Integer and Number only
	Histogram *Histogram   `json:"histogram,omitempty"`
	// HistogramLog bins log10(x+1) evenly, for integer and number columns
	// whose minimum is 0 or more; its bin edges are back on the original
	// scale. A long right tail (a few large values) spreads out on it.
	HistogramLog *Histogram `json:"histogramLog,omitempty"`
	MinLabel     string     `json:"minLabel,omitempty"` // Date and Datetime only
	MaxLabel     string     `json:"maxLabel,omitempty"`
	// UTC is set for a Datetime column shown in UTC: one with any time that
	// carries a zone. A column of times without zones shows them as written.
	UTC bool `json:"utc,omitempty"`

	// String and Boolean columns: the most frequent values.
	Top []TopValue `json:"top,omitempty"`
}

// Histogram has len(Bins) == len(Counts)+1. Bin i holds the values from
// Bins[i] up to Bins[i+1], the last bin including its upper edge. A
// discrete histogram (integers, dates) has whole-step edges and bin i holds
// Bins[i] to Bins[i+1] minus one step (one day for dates), so every bin
// holds whole values.
type Histogram struct {
	Bins     []float64 `json:"bins"`
	Counts   []int     `json:"counts"`
	Discrete bool      `json:"discrete,omitempty"`
}

// TopValue is a value and how many cells hold it.
type TopValue struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

// Stats computes the statistics of every column, the columns in parallel.
func (t *Table) Stats() []Stats {
	out := make([]Stats, len(t.Columns))
	sem := make(chan struct{}, runtime.GOMAXPROCS(0))
	var wg sync.WaitGroup
	for i, c := range t.Columns {
		sem <- struct{}{}
		wg.Go(func() {
			defer func() { <-sem }()
			out[i] = c.Stats()
		})
	}
	wg.Wait()
	return out
}

// topLimit is how many of the most frequent values Stats reports.
const topLimit = 15

// topValues returns the n most frequent values, most frequent first; ties
// keep the order of first appearance. It keeps only the n best while it
// goes, as a column of millions of distinct values needs no full sort.
func topValues(firstSeen []string, counts map[string]int, n int) []TopValue {
	top := make([]TopValue, 0, n+1)
	for _, v := range firstSeen {
		cnt := counts[v]
		if len(top) == n && cnt <= top[n-1].Count {
			continue
		}
		// Insert after every value with as many or more cells, so that an
		// earlier value wins a tie.
		i := len(top)
		for i > 0 && top[i-1].Count < cnt {
			i--
		}
		top = slices.Insert(top, i, TopValue{v, cnt})
		if len(top) > n {
			top = top[:n]
		}
	}
	if len(top) == 0 {
		return nil
	}
	return top
}

// Stats computes the column's statistics.
func (c *Column) Stats() Stats {
	s := Stats{Name: c.Name, Type: c.Type}
	rows := len(c.Raw)
	switch c.Type {
	case Integer, Date, Datetime:
		vals := make([]int64, 0, rows)
		for i := range rows {
			if c.HasValue(i) {
				vals = append(vals, c.Ints[i])
			}
		}
		s.Count = len(vals)
		s.Unique, s.UniqueApprox = countUnique(vals)
		if len(vals) == 0 {
			break
		}
		slices.Sort(vals)
		lo, hi := json.Number(strconv.FormatInt(vals[0], 10)), json.Number(strconv.FormatInt(vals[len(vals)-1], 10))
		s.Min, s.Max = &lo, &hi
		fs := make([]float64, len(vals))
		for i, v := range vals {
			fs[i] = float64(v)
		}
		switch c.Type {
		case Integer:
			s.Histogram = discreteHistogram(vals, 1)
		case Date:
			s.Histogram = discreteHistogram(vals, msPerDay)
		}
		if s.Histogram == nil {
			s.Histogram = histogram(fs)
		}
		if c.Type == Integer {
			s.HistogramLog = logHistogram(fs)
			moments(&s, fs)
		} else {
			s.UTC = c.Type == Datetime && c.UTC()
			s.MinLabel = timeLabel(vals[0], c.Type, s.UTC)
			s.MaxLabel = timeLabel(vals[len(vals)-1], c.Type, s.UTC)
		}
	case Number:
		vals := make([]float64, 0, rows)
		for i := range rows {
			if c.HasValue(i) {
				vals = append(vals, c.Floats[i])
			}
		}
		s.Count = len(vals)
		s.Unique, s.UniqueApprox = countUnique(vals)
		if len(vals) == 0 {
			break
		}
		slices.Sort(vals)
		lo, hi := floatNumber(vals[0]), floatNumber(vals[len(vals)-1])
		s.Min, s.Max = &lo, &hi
		s.Histogram = histogram(vals)
		s.HistogramLog = logHistogram(vals)
		moments(&s, vals)
	default: // String, Boolean, JSON
		counts := map[string]int{}
		var firstSeen []string
		for i := range rows {
			if !c.HasValue(i) {
				continue
			}
			s.Count++
			v := c.Raw[i]
			if c.Type == Boolean {
				v = strings.ToLower(strings.TrimSpace(v))
			}
			if _, ok := counts[v]; !ok {
				firstSeen = append(firstSeen, v)
			}
			counts[v]++
		}
		s.Unique, s.UniqueApprox = min(len(counts), uniqueLimit+1), len(counts) > uniqueLimit
		if c.Type == JSON {
			break
		}
		s.Top = topValues(firstSeen, counts, topLimit)
	}
	for i := range rows {
		if c.IsInvalid(i) {
			s.Invalid++
		}
	}
	s.Nulls = rows - s.Count - s.Invalid
	return s
}

func countUnique[T comparable](vals []T) (int, bool) {
	seen := make(map[T]struct{})
	for _, v := range vals {
		seen[v] = struct{}{}
		if len(seen) > uniqueLimit {
			return len(seen), true
		}
	}
	return len(seen), false
}

// moments sets mean, median (interpolated) and sample standard deviation
// (n - 1, as pandas, R and spreadsheets give; none for a single value)
// from sorted, finite values. The values are divided by the
// largest magnitude first, so that sums of values near the float64 limit
// (1e308) do not overflow to +Inf, which JSON cannot encode.
func moments(s *Stats, sorted []float64) {
	scale := math.Max(math.Abs(sorted[0]), math.Abs(sorted[len(sorted)-1]))
	if scale == 0 {
		zero := 0.0
		s.Mean, s.Median, s.Std = &zero, &zero, &zero
		return
	}
	var sum float64
	for _, v := range sorted {
		sum += v / scale
	}
	m := sum / float64(len(sorted))
	var sq float64
	for _, v := range sorted {
		d := v/scale - m
		sq += d * d
	}
	mean := m * scale
	var std *float64
	if len(sorted) > 1 {
		std = finite(math.Sqrt(sq/float64(len(sorted)-1)) * scale)
	}
	pos := float64(len(sorted)-1) * 0.5
	base := int(pos)
	median := sorted[base]
	if f := pos - float64(base); f > 0 && base+1 < len(sorted) {
		median = sorted[base]*(1-f) + sorted[base+1]*f
	}
	s.Mean, s.Median, s.Std = finite(mean), finite(median), std
}

func finite(x float64) *float64 {
	if math.IsInf(x, 0) || math.IsNaN(x) {
		return nil
	}
	return &x
}

// binCount is how many bins a histogram of n values gets: sqrt(n), kept
// between 5 and 30.
func binCount(n int) int { return min(30, max(5, int(math.Ceil(math.Sqrt(float64(n)))))) }

const msPerDay = 24 * 60 * 60 * 1000

// maxExact is the largest integer a float64, and so a JavaScript number,
// holds exactly.
const maxExact = 1 << 53

// discreteHistogram bins sorted integers (or day-aligned dates in
// milliseconds, step msPerDay) on whole steps: one bin per value when there
// are few distinct values in the range, else bins a whole number of steps
// wide, so that no bin is empty for lack of a value between the edges.
// The edges are computed in int64 and passed as float64; it returns nil,
// for the plain histogram, when an edge is past 2^53 and would round.
func discreteHistogram(sorted []int64, step int64) *Histogram {
	lo, hi := sorted[0], sorted[len(sorted)-1]
	if lo < -maxExact || hi > maxExact {
		return nil
	}
	// With |lo|, |hi| <= 2^53 nothing below overflows int64.
	span := (hi-lo)/step + 1 // steps from lo to hi, both included
	n := int64(binCount(len(sorted)))
	width := (span + n - 1) / n // in steps
	bins := (span + width - 1) / width
	h := &Histogram{Bins: make([]float64, bins+1), Counts: make([]int, bins), Discrete: true}
	for k := range h.Bins {
		e := lo + int64(k)*width*step
		if e < -maxExact || e > maxExact {
			return nil
		}
		h.Bins[k] = float64(e)
	}
	for _, v := range sorted {
		h.Counts[(v-lo)/(width*step)]++
	}
	return h
}

// histogram splits sorted, finite values into binCount equal bins. Only
// when the range itself overflows float64 (-1e308 to 1e308) are the
// positions computed on scaled values.
func histogram(sorted []float64) *Histogram {
	lo, hi := sorted[0], sorted[len(sorted)-1]
	if lo == hi {
		return &Histogram{Bins: []float64{lo, hi}, Counts: []int{len(sorted)}}
	}
	n := binCount(len(sorted))
	scale := 1.0
	if math.IsInf(hi-lo, 0) {
		scale = math.Max(math.Abs(lo), math.Abs(hi))
	}
	slo, shi := lo/scale, hi/scale
	width := (shi - slo) / float64(n)
	h := &Histogram{Bins: make([]float64, n+1), Counts: make([]int, n)}
	for i := range h.Bins {
		h.Bins[i] = (slo + float64(i)*width) * scale
	}
	for _, v := range sorted {
		k := min(n-1, max(0, int((v/scale-slo)/width)))
		h.Counts[k]++
	}
	return h
}

// logHistogram is histogram on log10(x+1) for sorted values that are all 0
// or more, with the bin edges mapped back to the original scale. It returns
// nil when a value is negative.
func logHistogram(sorted []float64) *Histogram {
	if sorted[0] < 0 {
		return nil
	}
	tf := make([]float64, len(sorted))
	for i, v := range sorted {
		tf[i] = math.Log10(v + 1)
	}
	h := histogram(tf)
	// Mapping back can round past the data (10^log10(1.79e308+1) is +Inf):
	// pin the ends to the real minimum and maximum and keep the inner edges
	// finite and inside them.
	lo, hi := sorted[0], sorted[len(sorted)-1]
	for i, b := range h.Bins {
		x := math.Pow(10, b) - 1
		if math.IsInf(x, 0) || math.IsNaN(x) || x > hi {
			x = hi
		}
		h.Bins[i] = max(x, lo)
	}
	h.Bins[0], h.Bins[len(h.Bins)-1] = lo, hi
	return h
}

func floatNumber(f float64) json.Number {
	return json.Number(strconv.FormatFloat(f, 'g', -1, 64))
}

// timeLabel writes a date (2024-01-02) or a time (2024-01-02 10:00:00),
// with a Z when the column shows its times in UTC.
func timeLabel(ms int64, t Type, utc bool) string {
	tm := time.UnixMilli(ms).UTC()
	if t == Date {
		return tm.Format(time.DateOnly)
	}
	layout := "2006-01-02 15:04:05"
	if tm.Nanosecond() != 0 {
		layout += ".000"
	}
	if utc {
		layout += "Z"
	}
	return tm.Format(layout)
}
