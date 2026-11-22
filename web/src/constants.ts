// Sizes and limits shared by the modules.
import type { ColType } from "./types.ts";

export const ROW_H = 26;
export const HEAD_H = 22 + 30 + 30; // column letters, names, distribution row
export const BLOCK = 200;
// MAX_BLOCKS bounds the rows kept in the page (20 x 200 = 4,000 rows, cells
// cut to MAX_CELL_BYTES), so memory does not grow with the file however far
// the user scrolls. Blocks far from the view are dropped and fetched again.
export const MAX_BLOCKS = 20;
export const MAX_PX = 8_000_000; // browsers cap element heights; past this the scrollbar is scaled
export const MAX_CELL_BYTES = 400;
export const LONG_CHARS = 28; // a text cell this long is cut in the table
export const NULL_MARK = "∅";
// FLASH_MS is how long changed cells and added rows glow after a reload;
// it matches the flash animation in base.css.
export const FLASH_MS = 3000;
export const TYPE_ABBR: Record<ColType, string> = {
  string: "str", integer: "int", number: "num", boolean: "bool", date: "date", datetime: "time", json: "json",
};
