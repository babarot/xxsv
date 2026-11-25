// Copying the selected cells to the clipboard.
import { fmt } from "./format.ts";
import { post } from "./api.ts";
import { S, currentQuery, selRange } from "./app.ts";
import { $ } from "./dom.ts";

let timer = 0;

function say(text: string) {
  clearTimeout(timer);
  $("copied").textContent = text;
  timer = window.setTimeout(() => ($("copied").textContent = ""), 2500);
}

async function fetchText(): Promise<Blob> {
  const res = await fetch("/api/copy", post({ ...currentQuery(), ...selRange(), generation: S.meta!.generation }));
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return new Blob([await res.text()], { type: "text/plain" });
}

// copySelection copies the selected range as the server writes it: the page
// has only the rows near the view, and long cells cut.
export async function copySelection() {
  if (!S.meta || S.total === 0) return;
  const { r0, r1, c0, c1 } = selRange();
  const n = (r1 - r0 + 1) * (c1 - c0 + 1);
  const text = fetchText();
  // When the write fails first, this says why instead of going unhandled.
  let reason = "";
  text.catch((e: Error) => { reason = e.message; });
  try {
    // The clipboard is written during the key press, with the text to come:
    // Safari refuses a write that starts after waiting for the server.
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]);
    say(n === 1 ? "Copied 1 cell" : `Copied ${fmt(n)} cells (${fmt(r1 - r0 + 1)} × ${fmt(c1 - c0 + 1)})`);
  } catch {
    say(`Copy failed${reason ? `: ${reason}` : ""}`);
  }
}

// isCopy reports whether a key press should copy the selected cells. Text
// selected in the page (the formula bar, a popover, the side panel) is left
// to the browser.
export const isCopy = (e: KeyboardEvent) =>
  (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "c" && String(getSelection()) === "";
