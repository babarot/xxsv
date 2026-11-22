// Runs in <head> before the page is drawn, so the first paint already has
// the right scheme (CSP allows only same-origin scripts, not inline ones).
// The choice is "light", "dark" or "system", kept in localStorage.
(function () {
  var root = document.documentElement;
  var media = window.matchMedia("(prefers-color-scheme: dark)");
  function choice() {
    try { return localStorage.getItem("xxsv.scheme") || "system"; } catch (e) { return "system"; }
  }
  function apply() {
    var c = choice();
    root.setAttribute("data-theme", root.getAttribute("data-theme") || "mono");
    root.setAttribute("data-scheme", c === "system" ? (media.matches ? "dark" : "light") : c);
    var accent = "";
    try { accent = localStorage.getItem("xxsv.accent") || ""; } catch (e) {}
    if (accent) root.setAttribute("data-accent", accent); else root.removeAttribute("data-accent");
    var numColor = "on";
    try { numColor = localStorage.getItem("xxsv.numColor") || "on"; } catch (e) {}
    root.setAttribute("data-numcolor", numColor);
  }
  apply();
  media.addEventListener("change", apply);
  window.xxsvApplyScheme = apply;
})();
