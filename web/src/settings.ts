// The settings panel: theme, accent, number color, histogram scale, the view and about.
import { fmt, viewSentence } from "./format.ts";
import { S } from "./app.ts";
import { renderColPop } from "./col-popover.ts";
import { $, el } from "./dom.ts";
import { render } from "./grid.ts";
import { renderHeader } from "./header.ts";

export function renderAbout() {
  if (!S.meta) return;
  const dl = $("about-list");
  dl.replaceChildren();
  const add = (k: string, v: string) => dl.append(el("dt", "", k), el("dd", "", v));
  add("File", S.meta.file);
  add("Format", S.meta.format + (S.meta.delimiter ? ` (delimiter ${S.meta.delimiter === "\t" ? "tab" : `“${S.meta.delimiter}”`})` : ""));
  add("Shape", `${fmt(S.meta.rows)} rows × ${S.meta.columns.length} columns`);
  if (S.meta.headerGenerated) add("Header", "none found; columns are named col1, col2, …");
  if (S.meta.raggedRows) add("Ragged rows", fmt(S.meta.raggedRows));
  if (S.meta.skippedLines) add("Skipped lines", fmt(S.meta.skippedLines));
  if (S.meta.foldedKeys) add("Folded keys", `${fmt(S.meta.foldedKeys)} in “(other keys)”`);
  add("Loaded", `${new Date(S.meta.loadedAt).toLocaleString()} (generation ${S.meta.generation})`);
  add("xxsv", S.meta.version);
  $("about-view").textContent = viewSentence(S.meta, S.total, S.view);
  renderChoices();
}

export function toggleSettings(open?: boolean) {
  const p = $("settings");
  p.hidden = !(open ?? p.hidden);
  if (!p.hidden) renderAbout();
}

// theme.js (loaded before this file) exposes the function that applies the
// stored theme, accent and number coloring.
export const applyStored = () => (window as unknown as { xxsvApplyScheme?: () => void }).xxsvApplyScheme?.();

export function stored(key: string, fallback: string): string {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

// store saves a choice; the default value is removed rather than stored.
export function store(key: string, value: string, fallback: string) {
  try {
    if (value === fallback) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage may be blocked; the choice lasts for this page */ }
}

export const histScale = () => (stored("xxsv.histScale", "linear") === "log" ? "log" : "linear");
export const numGroup = () => stored("xxsv.numGroup", "on") !== "off";

// A choice is a row of buttons in the settings panel, saved under key.
// apply puts a choice in effect; current, for choices the page keeps in its
// state, says which one is on (the others read it from storage).
export const CHOICES: { id: string; attr: string; key: string; fallback: string; apply: (v: string) => void; current?: () => string }[] = [
  {
    id: "scheme-choice", attr: "scheme", key: "xxsv.scheme", fallback: "system",
    apply: (v) => {
      applyStored();
      if (stored("xxsv.scheme", "system") !== v) {
        document.documentElement.dataset.scheme = v === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : v;
      }
    },
  },
  {
    id: "accent-choice", attr: "accent", key: "xxsv.accent", fallback: "",
    apply: (v) => { if (v) document.documentElement.dataset.accent = v; else delete document.documentElement.dataset.accent; },
  },
  {
    id: "numcolor-choice", attr: "numcolor", key: "xxsv.numColor", fallback: "on",
    apply: (v) => { document.documentElement.dataset.numcolor = v; },
  },
  {
    id: "histscale-choice", attr: "histscale", key: "xxsv.histScale", fallback: "linear",
    apply: (v) => { S.histScale = v === "log" ? "log" : "linear"; renderHeader(); if (S.colPop !== null) renderColPop(); },
    current: () => S.histScale,
  },
  {
    id: "numgroup-choice", attr: "numgroup", key: "xxsv.numGroup", fallback: "on",
    apply: (v) => { S.numGroup = v !== "off"; render(); },
    current: () => (S.numGroup ? "on" : "off"),
  },
];

export function renderChoices() {
  for (const ch of CHOICES) {
    const now = ch.current ? ch.current() : stored(ch.key, ch.fallback);
    document.querySelectorAll<HTMLButtonElement>(`#${ch.id} button`).forEach((b) => b.classList.toggle("on", (b.dataset[ch.attr] ?? "") === now));
  }
}

// wireChoices makes the settings' buttons save and apply their choice.
export function wireChoices() {
  for (const ch of CHOICES) {
    document.querySelectorAll<HTMLButtonElement>(`#${ch.id} button`).forEach((b) =>
      b.addEventListener("click", () => {
        const v = b.dataset[ch.attr] ?? "";
        store(ch.key, v, ch.fallback);
        ch.apply(v);
        renderChoices();
      }));
  }
  renderChoices();
}
