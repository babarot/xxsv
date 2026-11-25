// Images that cells name: the path of a file, or a data: URL. The server reads either and checks it. Other URLs are never loaded; the page talks to
// nothing but xxsv.
import type { ColType } from "./types.ts";
import { el } from "./dom.ts";
import { imageKind } from "./format.ts";

export interface ImageCell { value: string; type: ColType; gen: number; rowId: number; fileCol: number }

export const imageURL = (c: ImageCell) => `/api/image?gen=${c.gen}&row=${c.rowId}&col=${c.fileCol}`;

// cellImage makes the preview of a cell's image, or null for a value that
// names none. When the image cannot be loaded the preview goes away, or says
// so with note.
export function cellImage(c: ImageCell, opts: { onLoad?: () => void; note?: boolean } = {}): HTMLElement | null {
  const kind = imageKind(c.value, c.type);
  if (!kind) return null;
  const box = el("div", "cellimg");
  const img = el("img") as HTMLImageElement;
  img.alt = "";
  img.addEventListener("load", () => opts.onLoad?.());
  img.addEventListener("error", () => {
    if (opts.note) box.replaceChildren(el("div", "dim", kind === "path" ? "No image at this path" : "This image cannot be shown"));
    else box.remove();
    opts.onLoad?.();
  });
  img.src = imageURL(c);
  box.appendChild(img);
  return box;
}
