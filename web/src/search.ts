// The search box: plain text, or a regular expression with the .* toggle.
// A regular expression is checked by the server (RE2, as it runs it) before
// the table takes it; one it cannot read shows its error under the box and
// leaves the table as it was.
import { S, currentQuery, resetRows } from "./app.ts";
import { api, post } from "./api.ts";
import { $ } from "./dom.ts";

// check asks the server whether a query is good, without running it. It
// returns the error, or "" when the query is good.
export async function check(query: object): Promise<string> {
  try {
    const { error } = await api<{ error: string }>("/api/check", post(query));
    return error.replace(/^search: /, "");
  } catch (e) {
    return (e as Error).message;
  }
}

let seq = 0;
// regexOn is the toggle as shown; view.regex follows it once the search
// passes the check.
let regexOn = false;

// applySearch puts a search in the view, after checking a regular
// expression.
async function applySearch(text: string, regex: boolean) {
  const mine = ++seq;
  if (regex && text) {
    const err = await check({ ...currentQuery(), search: text, regex: true });
    if (mine !== seq) return;
    showSearchError(err);
    if (err) return;
  } else showSearchError("");
  S.view.search = text;
  S.view.regex = regex;
  S.view.top = 0;
  resetRows();
}

function showSearchError(msg: string) {
  const box = $("search-err");
  box.hidden = !msg;
  box.textContent = msg;
  $("search").closest(".search")!.classList.toggle("bad", !!msg);
}

function renderToggle() {
  const rx = $<HTMLButtonElement>("search-rx");
  rx.classList.toggle("on", regexOn);
  rx.setAttribute("aria-pressed", String(regexOn));
  $<HTMLInputElement>("search").placeholder = regexOn ? "Regex (RE2); (?i) ignores case" : "Search all cells";
}

export function wireSearch() {
  const search = $<HTMLInputElement>("search");
  search.value = S.view.search;
  regexOn = S.view.regex;
  renderToggle();
  let timer = 0;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void applySearch(search.value, regexOn), 250);
  });
  $("search-rx").addEventListener("click", (e) => {
    e.preventDefault(); // inside the label: keep the click from focusing the box
    regexOn = !regexOn; // the toggle shows at once; the rows wait for the check
    renderToggle();
    void applySearch(search.value, regexOn);
  });
}
