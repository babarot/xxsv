// The rows the page holds: blocks of BLOCK rows, fetched as they come into
// view and dropped when far from it (at most MAX_BLOCKS). Nothing here
// touches the DOM; fetching and what happens next are passed in.
import { BLOCK, MAX_BLOCKS } from "./constants.ts";
import type { Pos, RowsResponse } from "./types.ts";

// cut, changed and invalid hold "row,column" keys, rows counted within the
// block.
export interface Block { rowIds: number[]; rows: string[][]; cut: Set<string>; changed: Set<string>; added: Set<number>; invalid: Set<string> }

export interface CellInfo { rowId: number; value: string; cut: boolean }

export interface RowsDeps {
  fetch(offset: number, limit: number): Promise<RowsResponse>;
  epoch(): number; // the current epoch (state.ts)
  generation(): number | undefined; // the current meta's generation
  stale(): void; // a response came from another generation: refresh the meta
  loaded(b: number, res: RowsResponse): void; // a block of the current epoch was stored
  failed(message: string): void;
}

export const blockOf = (r: number) => Math.floor(r / BLOCK);

export function toBlock(res: RowsResponse): Block {
  return {
    rowIds: res.rowIds,
    rows: res.rows,
    cut: new Set((res.cut ?? []).map(([r, c]) => `${r},${c}`)),
    changed: new Set((res.changed ?? []).map(([r, c]) => `${r},${c}`)),
    added: new Set(res.added ?? []),
    invalid: new Set((res.invalid ?? []).map(([r, c]) => `${r},${c}`)),
  };
}

export class Rows {
  private blocks = new Map<number, Block | "loading">();
  private deps: RowsDeps;
  constructor(deps: RowsDeps) { this.deps = deps; }

  // reset drops every block; call it when the epoch moves on. Responses
  // still in flight see another epoch and are dropped.
  reset() { this.blocks = new Map(); }

  get size() { return this.blocks.size; }
  has(b: number) { return this.blocks.has(b); }
  block(b: number): Block | undefined {
    const v = this.blocks.get(b);
    return v === "loading" ? undefined : v;
  }

  async load(b: number) {
    if (this.blocks.has(b)) return;
    const blocks = this.blocks;
    blocks.set(b, "loading");
    const epoch = this.deps.epoch();
    try {
      const res = await this.deps.fetch(b * BLOCK, BLOCK);
      if (epoch !== this.deps.epoch()) return; // the query or the file changed meanwhile
      const gen = this.deps.generation();
      if (gen !== undefined && res.generation !== gen) {
        this.deps.stale();
        return;
      }
      blocks.set(b, toBlock(res));
      this.deps.loaded(b, res);
    } catch (e) {
      if (epoch === this.deps.epoch()) {
        blocks.delete(b);
        this.deps.failed(String((e as Error).message));
      }
    }
  }

  // evict drops the loaded blocks farthest from the block in view once
  // more than MAX_BLOCKS are held. Blocks still loading, and the block of
  // the selected cell (keep), are kept.
  evict(current: number, keep: number) {
    if (this.blocks.size <= MAX_BLOCKS) return;
    const loaded = [...this.blocks.entries()].filter(([b, v]) => v !== "loading" && b !== keep).map(([b]) => b);
    loaded.sort((a, b) => Math.abs(b - current) - Math.abs(a - current));
    for (const b of loaded.slice(0, this.blocks.size - MAX_BLOCKS)) this.blocks.delete(b);
  }

  cell(p: Pos): CellInfo | null {
    const block = this.block(blockOf(p.r));
    if (!block) return null;
    const r = p.r - blockOf(p.r) * BLOCK;
    if (r >= block.rows.length) return null;
    return { rowId: block.rowIds[r], value: block.rows[r][p.c], cut: block.cut.has(`${r},${p.c}`) };
  }
}
