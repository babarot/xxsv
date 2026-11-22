package table

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestStatsNumeric(t *testing.T) {
	tb := load(t, CSV, "n\n1\n2\n3\n4\n\n", Options{})
	s := tb.Columns[0].Stats()
	eq(t, "count", s.Count, 4)
	eq(t, "nulls", s.Nulls, 0) // the blank line is not a row
	eq(t, "min", *s.Min, json.Number("1"))
	eq(t, "max", *s.Max, json.Number("4"))
	eq(t, "mean", *s.Mean, 2.5)
	eq(t, "median interpolates", *s.Median, 2.5)
	eq(t, "unique", s.Unique, 4)
	eq(t, "histogram: one bin per value", s.Histogram.Bins, []float64{1, 2, 3, 4, 5})
	eq(t, "discrete", s.Histogram.Discrete, true)
	eq(t, "sample std", fmt.Sprintf("%.4f", *s.Std), "1.2910")
	eq(t, "histogram total", sum(s.Histogram.Counts), 4)
}

func TestStatsTopLimit(t *testing.T) {
	// 20 values seen once, then "late" three times: "late" comes first,
	// and the ties that follow keep the order of first appearance.
	var b strings.Builder
	b.WriteString("c\n")
	for i := range 20 {
		fmt.Fprintf(&b, "v%02d\n", i)
	}
	b.WriteString("late\nlate\nlate\n")
	s := load(t, CSV, b.String(), Options{}).Columns[0].Stats()
	want := []TopValue{{"late", 3}}
	for i := range topLimit - 1 {
		want = append(want, TopValue{fmt.Sprintf("v%02d", i), 1})
	}
	eq(t, "top", s.Top, want)
}

func TestStatsExactIntegerBounds(t *testing.T) {
	tb := load(t, CSV, "id\n9007199254740993\n9007199254740992\n", Options{})
	s := tb.Columns[0].Stats()
	eq(t, "unique", s.Unique, 2)
	eq(t, "min", *s.Min, json.Number("9007199254740992"))
	eq(t, "max", *s.Max, json.Number("9007199254740993"))
}

func TestStatsTop(t *testing.T) {
	tb := load(t, CSV, "c,b\nx,true\ny,TRUE\ny,false\nz,\n", Options{})
	s := tb.Columns[0].Stats()
	eq(t, "top", s.Top, []TopValue{{"y", 2}, {"x", 1}, {"z", 1}})
	b := tb.Columns[1].Stats()
	eq(t, "boolean top is normalised", b.Top, []TopValue{{"true", 2}, {"false", 1}})
	eq(t, "boolean nulls", b.Nulls, 1)
}

func TestStatsDates(t *testing.T) {
	tb := load(t, CSV, "d,at\n2024-01-02,2024-01-02T10:00:00Z\n2023-05-06,2024-01-02T10:00:00.123Z\n", Options{})
	d := tb.Columns[0].Stats()
	eq(t, "min label", d.MinLabel, "2023-05-06")
	eq(t, "no mean for dates", d.Mean == nil, true)
	at := tb.Columns[1].Stats()
	eq(t, "datetime label", at.MinLabel, "2024-01-02 10:00:00Z")
	eq(t, "datetime label with ms", at.MaxLabel, "2024-01-02 10:00:00.123Z")
}

func TestStatsSingleValueHistogram(t *testing.T) {
	tb := load(t, CSV, "n\n5\n5\n", Options{})
	h := tb.Columns[0].Stats().Histogram
	eq(t, "bins", h.Bins, []float64{5, 6})
	eq(t, "counts", h.Counts, []int{2})
}

func TestStatsJSONColumn(t *testing.T) {
	tb := loadJ(t, `{"m":{"a":1}}`+"\n"+`{"m":[1]}`+"\n"+`{"m":{"a":1}}`+"\n", Options{})
	s := tb.Columns[0].Stats()
	eq(t, "unique", s.Unique, 2)
	eq(t, "no top for json", s.Top == nil, true)
}

func sum(xs []int) int {
	n := 0
	for _, x := range xs {
		n += x
	}
	return n
}

func TestStatsHugeFiniteNumbers(t *testing.T) {
	tb := load(t, CSV, "n\n1e308\n1e308\n-1e308\n1.5\n", Options{})
	st := tb.Stats()
	if _, err := json.Marshal(st); err != nil {
		t.Fatalf("stats must encode as JSON: %v", err)
	}
	s := st[0]
	if s.Mean == nil || *s.Mean <= 0 || *s.Mean > 1e308 {
		t.Errorf("mean: got %v", s.Mean)
	}
	eq(t, "histogram total", sum(s.Histogram.Counts), 4)
}

func TestNonFiniteTextIsInvalid(t *testing.T) {
	var b strings.Builder
	b.WriteString("n\n")
	for i := 0; i < 99; i++ {
		b.WriteString("1.5\n")
	}
	b.WriteString("inf\n")
	tb := load(t, CSV, b.String(), Options{})
	c := tb.Columns[0]
	eq(t, "type", c.Type, Number)
	eq(t, "inf is invalid", c.IsInvalid(99), true)
	if _, err := json.Marshal(tb.Stats()); err != nil {
		t.Fatal(err)
	}
}

func TestHistogramLog(t *testing.T) {
	var b strings.Builder
	b.WriteString("n,neg\n")
	for i := 0; i < 90; i++ {
		fmt.Fprintf(&b, "%d,-1\n", 1+i%10)
	}
	for i := 0; i < 10; i++ {
		fmt.Fprintf(&b, "%d,1\n", 10000+i)
	}
	tb := load(t, CSV, b.String(), Options{})
	s := tb.Columns[0].Stats()
	if s.HistogramLog == nil {
		t.Fatal("no log histogram")
	}
	eq(t, "log total", sum(s.HistogramLog.Counts), 100)
	h := s.HistogramLog
	if d := h.Bins[0] - 1; d > 1e-9 || d < -1e-9 {
		t.Errorf("first edge: %v", h.Bins[0])
	}
	if d := h.Bins[len(h.Bins)-1] - 10009; d > 1e-6 || d < -1e-6 {
		t.Errorf("last edge: %v", h.Bins[len(h.Bins)-1])
	}
	// on a linear axis 90 values sit in the first bin; on a log axis they spread
	eq(t, "linear first bin", s.Histogram.Counts[0], 90)
	if s.HistogramLog.Counts[0] >= 90 {
		t.Errorf("log first bin: %d", s.HistogramLog.Counts[0])
	}
	eq(t, "negative column has none", tb.Columns[1].Stats().HistogramLog == nil, true)
}

func TestHistogramLogNearFloatLimit(t *testing.T) {
	tb := load(t, CSV, "n\n0\n1.7976931348623157e308\n1e300\n", Options{})
	st := tb.Stats()
	if _, err := json.Marshal(st); err != nil {
		t.Fatalf("stats must encode: %v", err)
	}
	h := st[0].HistogramLog
	eq(t, "first edge", h.Bins[0], 0.0)
	eq(t, "last edge", h.Bins[len(h.Bins)-1], 1.7976931348623157e308)
}

func TestStatsInvalidAndMissing(t *testing.T) {
	var b strings.Builder
	b.WriteString("price\n")
	for i := 0; i < 100; i++ {
		switch {
		case i%25 == 0:
			b.WriteString("pending\n")
		case i%25 == 1:
			b.WriteString("NA\n")
		default:
			fmt.Fprintf(&b, "%d\n", i)
		}
	}
	s := load(t, CSV, b.String(), Options{}).Columns[0].Stats()
	eq(t, "counts", [3]int{s.Count, s.Nulls, s.Invalid}, [3]int{92, 4, 4})
}

func TestStatsDiscreteHistogram(t *testing.T) {
	var b strings.Builder
	b.WriteString("rating,big,day\n")
	for i := 0; i < 1000; i++ {
		fmt.Fprintf(&b, "%d,%d,2024-01-%02d\n", i%5+1, i*1000, i%10+1)
	}
	tb := load(t, CSV, b.String(), Options{})
	r := tb.Columns[0].Stats().Histogram
	eq(t, "ratings: one bin per value", r.Bins, []float64{1, 2, 3, 4, 5, 6})
	eq(t, "ratings counts", r.Counts, []int{200, 200, 200, 200, 200})
	big := tb.Columns[1].Stats().Histogram
	eq(t, "wide range: 30 bins", len(big.Counts), 30)
	w := big.Bins[1] - big.Bins[0]
	eq(t, "whole-step width", w == float64(int64(w)), true)
	eq(t, "every value counted", sum(big.Counts), 1000)
	day := tb.Columns[2].Stats().Histogram
	eq(t, "days: one bin per day", len(day.Counts), 10)
	eq(t, "day step", day.Bins[1]-day.Bins[0], float64(msPerDay))
}

func TestStatsDiscreteHistogramNearExactLimit(t *testing.T) {
	// The last edge (max + 1) would be 2^53 + 1, which a float64 cannot hold:
	// fall back to the plain histogram.
	tb := load(t, CSV, "n\n9007199254740991\n9007199254740992\n", Options{})
	h := tb.Columns[0].Stats().Histogram
	eq(t, "not discrete", h.Discrete, false)
	tb = load(t, CSV, "n\n-9223372036854775808\n9223372036854775807\n", Options{})
	h = tb.Columns[0].Stats().Histogram
	eq(t, "full int64 range: not discrete", h.Discrete, false)
	eq(t, "counted", sum(h.Counts), 2)
}

func TestStatsDatetimeZones(t *testing.T) {
	tb := load(t, CSV, "zoned,naive,mixed\n"+
		"2024-01-02T10:00:00Z,2024-01-02 10:00:00,2024-01-02T10:00:00+09:00\n"+
		"2024-01-03T10:00:00+09:00,2024-01-03 10:00:00,2024-01-03 10:00:00\n", Options{})
	z := tb.Columns[0].Stats()
	eq(t, "zoned is UTC", z.UTC, true)
	eq(t, "zoned label", z.MinLabel, "2024-01-02 10:00:00Z")
	eq(t, "+09:00 converted", z.MaxLabel, "2024-01-03 01:00:00Z")
	n := tb.Columns[1].Stats()
	eq(t, "naive is not UTC", n.UTC, false)
	eq(t, "naive label as written", n.MinLabel, "2024-01-02 10:00:00")
	eq(t, "mixed is UTC", tb.Columns[2].Stats().UTC, true)
}

func TestStatsSingleValueHasNoStd(t *testing.T) {
	s := load(t, CSV, "n\n5\n", Options{}).Columns[0].Stats()
	eq(t, "no std", s.Std == nil, true)
}
