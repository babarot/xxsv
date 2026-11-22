// The view state in the URL hash, so it survives both a file reload and a
// browser reload.
import type { ViewState } from "./types.ts";

export const emptyView = (): ViewState => ({ search: "", filters: [], sorts: [], columns: null, top: 0 });

// parseHash reads a hash (without "#"); anything it cannot read gives the
// empty view, and missing fields their defaults. A hash from before sort
// keys has one "sort", read as the only key.
export function parseHash(hash: string): ViewState {
  try {
    const raw = decodeURIComponent(hash);
    if (!raw) return emptyView();
    const v = JSON.parse(raw);
    const sorts = Array.isArray(v.sorts) ? v.sorts : v.sort ? [v.sort] : [];
    const columns = Array.isArray(v.columns) && v.columns.length ? v.columns : null;
    return { search: v.search ?? "", filters: v.filters ?? [], sorts, columns, top: v.top ?? 0 };
  } catch {
    return emptyView();
  }
}

export const formatHash = (view: ViewState) => "#" + encodeURIComponent(JSON.stringify(view));

export const readHash = () => parseHash(location.hash.slice(1));

let timer = 0;
// writeHash puts the view in the URL, at most every 150 ms (scrolling
// changes view.top all the time).
export function writeHash(view: ViewState) {
  clearTimeout(timer);
  timer = window.setTimeout(() => history.replaceState(null, "", formatHash(view)), 150);
}

// writeHashNow puts the view in the URL at once (before copying a link).
export function writeHashNow(view: ViewState) {
  clearTimeout(timer);
  history.replaceState(null, "", formatHash(view));
}
