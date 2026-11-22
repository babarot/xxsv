// Types of the server's API and of the view state.

export type ColType = "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "json";

export interface Column { name: string; type: ColType }

export interface Meta {
  version: string; generation: number; file: string; format: string; delimiter?: string;
  headerGenerated: boolean; columns: Column[]; rows: number;
  raggedRows: number; skippedLines: number; foldedKeys: number;
  loadedAt: string; error?: string; changes?: Changes;
}

// Changes are what changed since the previous generation (the server's
// diff.Changes); the rows' marks come with each block.
export interface Changes {
  from: number; changedRows: number; changedCells: number; addedRows: number; removedRows: number;
  addedColumns: string[]; removedColumns: string[]; tooMany: boolean;
}

// A discrete histogram (integers, dates) has whole-step edges: bin i holds
// bins[i] to bins[i+1] minus one step (1, or a day for dates).
export interface Hist { bins: number[]; counts: number[]; discrete?: boolean }

export interface Stats {
  // count: cells with a value; nulls: missing cells; invalid: cells whose
  // text is not a value of the column's type ("pending" in numbers).
  name: string; type: ColType; count: number; nulls: number; invalid: number; unique: number; uniqueApprox: boolean;
  min?: number; max?: number; mean?: number; median?: number; std?: number;
  histogram?: Hist; histogramLog?: Hist;
  minLabel?: string; maxLabel?: string;
  utc?: boolean; // datetimes shown in UTC (some carry a zone)
  top?: { value: string; count: number }[];
}

export interface Filter { column: string; op: "contains" | "equals" | "range" | "null" | "notnull" | "invalid"; value?: string; min?: string; max?: string }
export interface Sort { column: string; desc?: boolean }

export interface RowsResponse {
  generation: number; total: number; rowIds: number[]; rows: string[][]; cut?: [number, number][];
  changed?: [number, number][]; added?: number[]; invalid?: [number, number][];
}

export interface Aggregate { generation: number; count: number; numericCount: number; sum?: number; avg?: number; min?: number; max?: number }

// ViewState is what the URL hash keeps: the query and the scroll position
// (the first row shown, in the filtered, sorted order).
export interface ViewState { search: string; filters: Filter[]; sort: Sort | null; top: number }

// Pos is a display position: a row in the filtered, sorted order, and a column.
export interface Pos { r: number; c: number }
