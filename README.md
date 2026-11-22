# xxsv

xxsv shows a CSV, TSV or JSONL file as a table in your browser and keeps it up to date while you edit the file.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/screenshot-light.png">
    <img alt="xxsv showing a table of orders, with a range selected and the distribution of a column open" src="docs/screenshot-light.png">
  </picture>
</p>

Run `xxsv data.csv` and a page opens with the table. Save the file in your editor, and the page reloads it in place: the sort, the filters, the search and the scroll position stay, and the cells that changed glow for a moment.

The name, xxsv (ex-ex-es-vee), comes from [xsv](https://github.com/BurntSushi/xsv), the CSV toolkit. The second x stands for "any": any separator, and line formats that are not separated values at all, such as JSONL. It is a separate tool, not a successor to xsv: xsv transforms files on the command line, and xxsv shows one in the browser while it changes.

## Features

- Follows the file. Every save reloads the table without losing your place. Changed cells and added rows are highlighted, and the status bar says what changed ("3 changed, 2 added, 1 removed").
- Large files. The server holds the table and the page fetches only the rows in view, so a file of a million rows scrolls, sorts and filters without loading the browser.
- Spreadsheet-like. Select cells, ranges, whole columns or rows with the mouse or the arrow keys, and see the count, sum, average, minimum and maximum of the range.
- A distribution for every column. A histogram or the top values sit under each column name; click one for statistics and filters.
- Types. Each column is read as integer, number, date, datetime, boolean, string or JSON, so numbers sort as numbers and dates filter by range. Missing cells and cells that do not fit the column's type are told apart and can be filtered.
- Long values. JSON and long text open in a popover next to the cell, pretty-printed, or in a side panel.
- One binary, local only. The UI is built in, and the page talks to nothing but xxsv on 127.0.0.1.

## Install

```sh
go install github.com/babarot/xxsv/cmd/xxsv@latest
```

## Usage

```sh
xxsv data.csv
xxsv events.jsonl
xxsv -p 8080 --no-open report.tsv
```

```
usage: xxsv [flags] <file>

flags:
  -p, --port N        port to listen on (default 7333; a free one if taken)
      --no-open       do not open the browser
  -n, --no-header     the first row is data; name the columns col1, col2, ...
      --header        always read the first row as the header
  -d, --delimiter C   field delimiter for CSV (a character, or "tab")
      --version       print the version
```

The format comes from the file extension (`.csv`, `.tsv`, `.tab`, `.jsonl`, `.ndjson`) or, failing that, from the content, including whether fields are separated by commas or tabs. For CSV and TSV, the first row is the header unless one of its cells is a bare number; `-n` and `--header` decide it yourself.

In the page:

| Key | Action |
|---|---|
| Arrow keys | Move the selection; with Shift, extend the range |
| Space, double-click | Show the full value of a long cell |
| `/` | Search all cells |
| Esc | Close a popover, leave the search |

The view (search, filters, sort, scroll position) is kept in the URL, so a reload of the page or a copied link opens the same view. Settings (theme, accent, number colors, digit grouping, histogram scale) are saved in the browser.

## How cells are read

xxsv looks at the first 5,000 rows of each column and picks the type that 95% of the non-missing values fit (99% for booleans):

| Type | Values |
|---|---|
| integer | `42`, `-7`, `+1` (not `007`: leading zeros mean a code, such as a postal code, and the column stays a string) |
| number | `3.14`, `.5`, `1e-3` |
| date | `2024-01-02` |
| datetime | `2024-01-02 10:00`, `2024-01-02T10:00:00Z`, `2024-01-02T10:00:00+09:00` (a column may mix dates in) |
| boolean | `true`, `false`, in any case |
| json | objects and arrays, such as nested values in JSONL |
| string | anything else |

A cell is then one of three things:

- a value of the column's type;
- missing: empty, an absent key or `null` in JSONL, or, in integer, number, date, datetime and boolean columns, the text `null`, `na` or `nan` (in a string column, `NA` stays a value);
- invalid: text that is not a value of the type, such as `pending` in a number column. Invalid cells are underlined in the table, counted apart from missing ones, and sort after the values.

Datetimes without a time zone are shown as written. When a column has times with zones, they are shown in UTC.

JSONL lines become rows and their top-level keys become columns. Files whose lines use many different keys keep the 1,000 most common as columns and fold the rest into an `(other keys)` column.

## Development

The server is Go; the UI is TypeScript in `web/`, built with esbuild into `internal/server/ui/dist`, which the binary embeds. The build output is committed so that `go install` needs no Node. After changing `web/src`, rebuild and commit the result:

```sh
cd web
npm ci
npm run build
```

Tests:

```sh
go test ./...        # server
cd web
npm test             # UI unit tests (Node's test runner)
npm run e2e          # end-to-end tests: builds the UI and xxsv, drives the page with Playwright
```

The end-to-end tests use the installed Google Chrome. Set `XXSV_E2E_BROWSER=chromium` to use Playwright's Chromium instead (`npx playwright install chromium`).

To measure a large file:

```sh
go run ./scripts/gendata 1000000 data.csv
XXSV_BENCH_FILE=data.csv go test ./internal/query -run TestQueryTiming -v
```

`npm run screenshot` in `web/` takes the pictures at the top of this file, light and dark, from generated data.

## License

[MIT](LICENSE)
