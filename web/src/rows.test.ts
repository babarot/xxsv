import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOCK, MAX_BLOCKS } from "./constants.ts";
import { Rows, type RowsDeps } from "./rows.ts";
import type { RowsResponse } from "./types.ts";

// A fake server: each fetch waits until the test resolves it.
function setup() {
  let epoch = 1;
  let generation = 1;
  const pending: { offset: number; resolve: (r: RowsResponse) => void; reject: (e: Error) => void }[] = [];
  const events: string[] = [];
  const deps: RowsDeps = {
    fetch: (offset) => new Promise((resolve, reject) => pending.push({ offset, resolve, reject })),
    epoch: () => epoch,
    generation: () => generation,
    stale: () => events.push("stale"),
    loaded: (b) => events.push(`loaded ${b}`),
    failed: (m) => events.push(`failed ${m}`),
  };
  const rows = new Rows(deps);
  const response = (offset: number, gen = generation): RowsResponse => ({
    generation: gen, total: 1000,
    rowIds: [offset, offset + 1], rows: [[`v${offset}`, "x"], [`v${offset + 1}`, "y"]],
    cut: [[1, 1]], changed: [[0, 1]], added: [1], invalid: [[1, 0]],
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    rows, pending, events, response, tick,
    setEpoch: (e: number) => (epoch = e),
    setGeneration: (g: number) => (generation = g),
  };
}

test("stores a block of the current epoch and finds its cells", async () => {
  const t = setup();
  const done = t.rows.load(2);
  assert.equal(t.rows.has(2), true);
  assert.equal(t.rows.block(2), undefined); // loading
  assert.equal(t.pending[0].offset, 2 * BLOCK);
  t.pending[0].resolve(t.response(2 * BLOCK));
  await done;
  assert.deepEqual(t.events, ["loaded 2"]);
  const b = t.rows.block(2)!;
  assert.ok(b.changed.has("0,1"));
  assert.ok(b.added.has(1));
  assert.ok(b.invalid.has("1,0"));
  assert.deepEqual(t.rows.cell({ r: 2 * BLOCK + 1, c: 1 }), { rowId: 2 * BLOCK + 1, value: "y", cut: true });
  assert.equal(t.rows.cell({ r: 2 * BLOCK + 5, c: 0 }), null); // past the rows returned
  assert.equal(t.rows.cell({ r: 0, c: 0 }), null); // no block
});

test("does not fetch a block twice", () => {
  const t = setup();
  void t.rows.load(0);
  void t.rows.load(0);
  assert.equal(t.pending.length, 1);
});

test("drops a response from an older epoch", async () => {
  const t = setup();
  const done = t.rows.load(0);
  t.setEpoch(2);
  t.rows.reset();
  t.pending[0].resolve(t.response(0));
  await done;
  assert.deepEqual(t.events, []);
  assert.equal(t.rows.has(0), false);
});

test("asks for the meta again on a response from another generation", async () => {
  const t = setup();
  const done = t.rows.load(0);
  t.pending[0].resolve(t.response(0, 2));
  await done;
  assert.deepEqual(t.events, ["stale"]);
  assert.equal(t.rows.block(0), undefined);
});

test("forgets a failed block so it is fetched again, unless the epoch moved on", async () => {
  const t = setup();
  let done = t.rows.load(0);
  t.pending[0].reject(new Error("boom"));
  await done;
  assert.deepEqual(t.events, ["failed boom"]);
  assert.equal(t.rows.has(0), false);

  done = t.rows.load(1);
  t.setEpoch(2);
  t.rows.reset();
  void t.rows.load(1); // the new epoch's request
  t.pending[1].reject(new Error("old"));
  await done;
  assert.deepEqual(t.events, ["failed boom"]); // the old failure is not reported
  assert.equal(t.rows.has(1), true); // and does not drop the new request
});

test("keeps at most MAX_BLOCKS, dropping the farthest, never the selected or a loading block", async () => {
  const t = setup();
  const loads: Promise<void>[] = [];
  for (let b = 0; b <= MAX_BLOCKS; b++) loads.push(t.rows.load(b * 10));
  // Block 30 still loading.
  t.pending.forEach((p, i) => { if (i !== 3) p.resolve(t.response(p.offset)); });
  await t.tick();
  assert.equal(t.rows.size, MAX_BLOCKS + 1);
  // In view: block 200; selected: block 0, the farthest. Block 10 goes.
  t.rows.evict(MAX_BLOCKS * 10, 0);
  assert.equal(t.rows.size, MAX_BLOCKS);
  assert.equal(t.rows.has(0), true);
  assert.equal(t.rows.has(10), false);
  assert.equal(t.rows.has(30), true); // loading
  t.rows.evict(MAX_BLOCKS * 10, 0); // nothing more to drop
  assert.equal(t.rows.size, MAX_BLOCKS);
});
