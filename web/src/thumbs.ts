// The small images in the table's cells, and the larger one shown while the
// pointer is on one. Rows are rebuilt on every scroll, and an <img> put into
// new rows decodes its file again (a third of a second per frame for a screen
// of 12-megapixel photos), so each image is scaled down once onto a small
// canvas, which is kept here and put into the new rows.
import { imageKind } from "./format.ts";
import { imageURL, type ImageCell } from "./image.ts";
import { $, el } from "./dom.ts";

// MAX_THUMBS bounds the images kept; it is more than a screen shows.
const MAX_THUMBS = 400;
// Images are asked for once the table has stood still this long, so that a
// fast scroll does not queue hundreds of requests before its rows.
const SETTLE_MS = 100;
const HOVER_MS = 120;

// A few at a time: the browser opens six connections to a server, and the
// rows and the reload events need theirs.
const MAX_FETCHES = 3;
const W = 28, H = 20; // .thumb in base.css

interface Thumb { canvas: HTMLCanvasElement; column: string; gen: number; src: string; redraw: () => void }

const thumbs = new Map<string, Thumb>(); // least recently drawn first
const waiting = new Set<Thumb>();
const queue: Thumb[] = [];
let fetches = 0;
// The columns an image was seen in. Only these make room for images, so that
// file names with no files behind them look like any other text.
const withImages = new Set<string>();
let timer = 0;

// showsImages says whether a column was seen to name images, so that its
// cells show file names in place of whole paths.
export const showsImages = (column: string) => withImages.has(column);

// thumb makes the box of a cell's small image, or null for a value that
// names none. redraw runs when a column turns out to have images.
export function thumb(c: ImageCell, column: string, redraw: () => void): HTMLElement | null {
  if (!imageKind(c.value, c.type)) return null;
  const key = [column, c.rowId, c.value].join("\0");
  let t = thumbs.get(key);
  if (!t) {
    const canvas = el("canvas") as HTMLCanvasElement;
    canvas.hidden = true;
    t = { canvas, column, gen: -1, src: "", redraw };
  }
  thumbs.delete(key);
  thumbs.set(key, t);
  if (thumbs.size > MAX_THUMBS) thumbs.delete(thumbs.keys().next().value!);
  // After a reload the file may be another image. The old one stays in
  // place until the new one has come.
  if (t.gen !== c.gen) {
    t.gen = c.gen;
    t.src = imageURL(c);
    waiting.add(t);
  }
  if (waiting.size) {
    clearTimeout(timer);
    timer = window.setTimeout(settle, SETTLE_MS);
  }
  const box = el("span", "thumb" + (withImages.has(column) ? "" : " off"));
  box.dataset.src = t.src;
  box.appendChild(t.canvas);
  return box;
}

function settle() {
  queue.push(...waiting);
  waiting.clear();
  while (fetches < MAX_FETCHES && queue.length) void next();
}

async function next() {
  const t = queue.shift()!;
  // Scrolled away before it was asked for: ask when it is drawn again.
  if (!t.canvas.isConnected) {
    t.gen = -1;
    return;
  }
  fetches++;
  const src = t.src;
  try {
    const res = await fetch(src);
    // Conflict: the file was reloaded; the new rows ask again.
    const blob = res.status === 200 ? await res.blob() : null;
    // Decoded and scaled off the main thread. Larger than the box needs, so
    // that a tall image still fills its width.
    const small = blob && await createImageBitmap(blob, { resizeHeight: H * 8, resizeQuality: "medium" });
    if (t.src === src) draw(t, small);
    small?.close();
  } catch {
    if (t.src === src) draw(t, null);
  } finally {
    fetches--;
    while (fetches < MAX_FETCHES && queue.length) void next();
  }
}

// draw fills the canvas with the image, cut to its shape.
function draw(t: Thumb, small: ImageBitmap | null) {
  t.canvas.hidden = !small;
  if (!small) return;
  t.canvas.width = W * 2;
  t.canvas.height = H * 2;
  const scale = Math.max(t.canvas.width / small.width, t.canvas.height / small.height);
  const w = small.width * scale, h = small.height * scale;
  t.canvas.getContext("2d")!.drawImage(small, (t.canvas.width - w) / 2, (t.canvas.height - h) / 2, w, h);
  if (withImages.has(t.column)) return;
  withImages.add(t.column);
  t.redraw();
}

let hover = 0;

export function hideZoom() {
  clearTimeout(hover);
  $("imgzoom").hidden = true;
  $("imgzoom").replaceChildren();
}

function showZoom(box: HTMLElement) {
  if (!box.isConnected) return;
  const zoom = $("imgzoom");
  const img = el("img") as HTMLImageElement;
  img.alt = "";
  zoom.replaceChildren(img);
  img.addEventListener("load", () => {
    // Another image, or none, is asked for by now.
    if (img.parentNode !== zoom || !box.isConnected) return;
    const scale = Math.min(1, 360 / img.naturalWidth, 300 / img.naturalHeight);
    img.style.width = `${Math.max(1, Math.round(img.naturalWidth * scale))}px`;
    img.style.height = `${Math.max(1, Math.round(img.naturalHeight * scale))}px`;
    zoom.appendChild(el("div", "dim", `${img.naturalWidth} × ${img.naturalHeight}`));
    zoom.hidden = false;
    const center = $("center").getBoundingClientRect();
    const r = box.getBoundingClientRect();
    let left = r.right - center.left + 8;
    if (left + zoom.offsetWidth > center.width - 8) left = Math.max(8, r.left - center.left - zoom.offsetWidth - 8);
    const top = Math.min(r.top - center.top - 8, center.height - zoom.offsetHeight - 8);
    zoom.style.left = left + "px";
    zoom.style.top = Math.max(8, top) + "px";
  });
  img.src = box.dataset.src!;
}

// wireThumbs shows the larger image on hover over the table.
export function wireThumbs(grid: HTMLElement) {
  const boxOf = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>(".thumb");
  grid.addEventListener("pointerover", (e) => {
    const box = boxOf(e);
    if (!box || box.querySelector("canvas")?.hidden || e.pointerType === "touch") return;
    clearTimeout(hover);
    hover = window.setTimeout(showZoom, HOVER_MS, box);
  });
  grid.addEventListener("pointerout", (e) => { if (boxOf(e)) hideZoom(); });
  grid.addEventListener("scroll", hideZoom, { passive: true });
  grid.addEventListener("pointerdown", hideZoom);
  document.addEventListener("keydown", hideZoom);
}
