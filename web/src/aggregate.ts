// The aggregate of the selected range (count, sum, average, min, max), computed by the server.
import { fmt, round } from "./format.ts";
import type { Aggregate } from "./types.ts";
import { api, post } from "./api.ts";
import { S, currentQuery, selRange } from "./app.ts";
import { $, el } from "./dom.ts";

let aggSeq = 0;
let aggTimer = 0;
// cancelAggregate drops any aggregate in flight and clears the display; a
// response that arrives later fails the sequence check.

export function cancelAggregate() {
  clearTimeout(aggTimer);
  aggSeq++;
  $("agg").replaceChildren();
}

export function requestAggregate() {
  cancelAggregate();
  const out = $("agg");
  const { r0, r1, c0, c1 } = selRange();
  if (r0 === r1 && c0 === c1) return;
  const seq = aggSeq;
  const epoch = S.epoch;
  aggTimer = window.setTimeout(async () => {
    try {
      const a = await api<Aggregate>("/api/aggregate", post({ ...currentQuery(), r0, r1, c0, c1 }));
      // Drop it when a newer range, another query or another file version
      // was asked for meanwhile.
      if (seq !== aggSeq || epoch !== S.epoch || (S.meta && a.generation !== S.meta.generation)) return;
      const parts: [string, string][] = [["Count", fmt(a.count)]];
      if (a.numericCount > 0) {
        // Sum is missing when it overflows; the rest still apply.
        if (a.sum !== undefined) parts.push(["Sum", round(a.sum)]);
        parts.push(["Avg", round(a.avg!)], ["Min", round(a.min!)], ["Max", round(a.max!)]);
      }
      out.replaceChildren(...parts.map(([k, v]) => {
        const s = el("span", "", k);
        s.appendChild(el("b", "", v));
        return s;
      }));
    } catch (e) {
      if (seq === aggSeq) out.textContent = String((e as Error).message);
    }
  }, 60);
}
