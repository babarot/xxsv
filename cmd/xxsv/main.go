// Command xxsv serves a CSV, TSV, LTSV or JSONL file and shows it as a table
// in the browser, reloading it whenever the file changes.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"runtime/debug"
	"strconv"
	"syscall"
	"unicode/utf8"

	"github.com/babarot/xxsv/internal/server"
	"github.com/babarot/xxsv/internal/table"
)

// version is set at build time by a release (-ldflags "-X main.version=...").
// Otherwise it is the version Go records in the binary: the module version
// for go install ...@v0.1.0, a pseudo-version for a build from a clean
// checkout. It stays "dev" when Go records none.
var version = "dev"

func init() {
	if version != "dev" {
		return
	}
	if bi, ok := debug.ReadBuildInfo(); ok && bi.Main.Version != "" && bi.Main.Version != "(devel)" {
		version = bi.Main.Version
	}
}

const defaultPort = 7333

const usage = `usage: xxsv [flags] <file>

Serve a CSV, TSV, LTSV or JSONL file at http://127.0.0.1:%d/ and open it in
the browser. The page follows the file as it changes. Ctrl-C stops.

flags:
  -p, --port N        port to listen on (default %d; a free one if taken)
      --no-open       do not open the browser
  -n, --no-header     the first row is data; name the columns col1, col2, ...
      --header        always read the first row as the header
  -d, --delimiter C   field delimiter for CSV (a character, or "tab")
      --version       print the version
`

type options struct {
	port      int
	portSet   bool
	noOpen    bool
	noHeader  bool
	header    bool
	delimiter string
	version   bool
	file      string
}

func parseArgs(args []string, stderr io.Writer) (*options, error) {
	o := &options{port: defaultPort}
	fs := flag.NewFlagSet("xxsv", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprintf(stderr, usage, defaultPort, defaultPort) }
	for _, name := range []string{"p", "port"} {
		fs.IntVar(&o.port, name, defaultPort, "")
	}
	fs.BoolVar(&o.noOpen, "no-open", false, "")
	for _, name := range []string{"n", "no-header"} {
		fs.BoolVar(&o.noHeader, name, false, "")
	}
	fs.BoolVar(&o.header, "header", false, "")
	for _, name := range []string{"d", "delimiter"} {
		fs.StringVar(&o.delimiter, name, "", "")
	}
	fs.BoolVar(&o.version, "version", false, "")

	// Flags may come after the file too: xxsv data.csv -p 8000.
	var files []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		args = fs.Args()
		if len(args) == 0 {
			break
		}
		files = append(files, args[0])
		args = args[1:]
	}
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "p" || f.Name == "port" {
			o.portSet = true
		}
	})
	if o.version {
		return o, nil
	}
	if len(files) != 1 {
		fs.Usage()
		return nil, errors.New("expected exactly one file")
	}
	if o.noHeader && o.header {
		return nil, errors.New("--no-header and --header cannot be used together")
	}
	o.file = files[0]
	return o, nil
}

func (o *options) loadOptions() (table.Options, error) {
	lo := table.Options{}
	switch {
	case o.noHeader:
		lo.Header = table.HeaderNo
	case o.header:
		lo.Header = table.HeaderYes
	}
	switch d := o.delimiter; {
	case d == "":
	case d == "tab" || d == `\t`:
		lo.Delimiter = '\t'
	case utf8.RuneCountInString(d) == 1:
		r, _ := utf8.DecodeRuneInString(d)
		lo.Delimiter = r
	default:
		return lo, fmt.Errorf("delimiter must be one character or \"tab\": %q", d)
	}
	return lo, nil
}

// listen binds to 127.0.0.1. When the default port is taken and no port
// was asked for, it falls back to a free port.
func listen(o *options) (net.Listener, error) {
	l, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(o.port)))
	if err != nil && !o.portSet && errors.Is(err, syscall.EADDRINUSE) {
		return net.Listen("tcp", "127.0.0.1:0")
	}
	return l, err
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err == nil {
		go func() { _ = cmd.Wait() }()
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	o, err := parseArgs(args, stderr)
	if err != nil {
		return err
	}
	if o.version {
		fmt.Fprintln(stdout, "xxsv", version)
		return nil
	}
	lo, err := o.loadOptions()
	if err != nil {
		return err
	}
	srv, err := server.New(o.file, server.Options{Load: lo, Version: version})
	if err != nil {
		return err
	}
	l, err := listen(o)
	if err != nil {
		return err
	}
	url := fmt.Sprintf("http://%s/", l.Addr())
	fmt.Fprintf(stderr, "xxsv: serving %s at %s (Ctrl-C to stop)\n", o.file, url)
	if !o.noOpen {
		openBrowser(url)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return srv.Serve(ctx, l)
}

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			os.Exit(0)
		}
		fmt.Fprintln(os.Stderr, "xxsv:", err)
		os.Exit(2)
	}
}
