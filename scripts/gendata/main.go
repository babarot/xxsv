// Command gendata writes a CSV of generated rows for measuring xxsv on large
// files, such as the timing tests that read XXSV_BENCH_FILE:
//
//	go run ./scripts/gendata 1000000 data.csv
//	XXSV_BENCH_FILE=data.csv go test ./internal/query -run TestQueryTiming -v
//
// The 10 columns cover every type: id, an integer, a number, a date, a
// datetime, a boolean, a category, a short and a long text, and an integer
// that is missing in about one row in ten. The output is the same for the
// same row count.
package main

import (
	"bufio"
	"fmt"
	"math/rand/v2"
	"os"
	"strconv"
	"strings"
	"time"
)

var words = strings.Fields("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu")

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: gendata ROWS OUT.csv")
		os.Exit(2)
	}
	n, err := strconv.Atoi(os.Args[1])
	if err != nil || n < 0 {
		fmt.Fprintln(os.Stderr, "gendata: ROWS must be a number")
		os.Exit(2)
	}
	if err := write(os.Args[2], n); err != nil {
		fmt.Fprintln(os.Stderr, "gendata:", err)
		os.Exit(1)
	}
}

func write(path string, n int) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 1<<20)
	r := rand.New(rand.NewPCG(1, 2))
	fmt.Fprintln(w, "id,qty,price,day,at,ok,category,name,note,maybe")
	base := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := range n {
		day := base.AddDate(0, 0, r.IntN(2000))
		at := base.Add(time.Duration(r.Int64N(int64(2000 * 24 * time.Hour))))
		maybe := ""
		if r.IntN(10) != 0 {
			maybe = strconv.Itoa(r.IntN(1000))
		}
		fmt.Fprintf(w, "%d,%d,%.2f,%s,%s,%t,cat%02d,%s,\"%s\",%s\n",
			i+1, r.IntN(10000), r.Float64()*1000, day.Format("2006-01-02"), at.Format("2006-01-02T15:04:05Z"),
			r.IntN(2) == 0, r.IntN(50), sentence(r, 12), sentence(r, 100), maybe)
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func sentence(r *rand.Rand, n int) string {
	var b strings.Builder
	for b.Len() < n {
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(words[r.IntN(len(words))])
	}
	return b.String()
}
