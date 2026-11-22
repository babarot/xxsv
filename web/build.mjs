// Builds the UI into internal/server/ui/dist, which the Go binary embeds.
// The output is committed so that `go install` needs no Node.
import { build } from "esbuild";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";

// Components must take colors from theme tokens only, so that a theme is
// one file. Fail on a color value in any declaration of base.css: a hex
// color, a color function, or a CSS named color.
const NAMED = "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(" ");
const colorValue = new RegExp(
  "#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(|\\b(?:" + NAMED.join("|") + ")\\b",
  "i",
);
const base = await readFile("src/base.css", "utf8");
const bad = [];
// Walk declarations (text between ; { }), comments removed, so a value split
// over lines is still one declaration; check only the part after the colon.
base.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).split(/[;{}]/).reduce((offset, decl) => {
  const colon = decl.indexOf(":");
  if (colon >= 0 && !/^\s*[^:]*\s(?:[.#\[]|::?[a-z-]+\s*$)/i.test(decl.slice(0, colon))) {
    const value = decl.slice(colon + 1);
    const m = value.match(colorValue);
    if (m) bad.push([base.slice(0, offset + colon).split("\n").length, decl.trim().replace(/\s+/g, " ")]);
  }
  return offset + decl.length + 1;
}, 0);
if (bad.length) {
  for (const [n, d] of bad) console.error(`src/base.css:${n}: color value outside a theme: ${d}`);
  process.exit(1);
}

const out = new URL("../internal/server/ui/dist/", import.meta.url);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  outfile: new URL("app.js", out).pathname,
  legalComments: "eof", // keep the license notices of bundled libraries (Lucide, ISC)
});
const themes = (await readdir("src/themes")).filter((f) => f.endsWith(".css")).sort();
const css = [...(await Promise.all(themes.map((f) => readFile(`src/themes/${f}`, "utf8")))), base].join("\n");
await writeFile(new URL("style.css", out), css);
await copyFile("src/index.html", new URL("index.html", out));
await copyFile("src/theme.js", new URL("theme.js", out));
// The favicon cannot read the page's theme tokens, so it carries the mono
// ink colors itself and follows the OS scheme.
await copyFile("src/favicon.svg", new URL("favicon.svg", out));
// Bundled libraries' licenses, which the notices kept in app.js refer to.
await mkdir(new URL("licenses/", out), { recursive: true });
await copyFile("node_modules/lucide/LICENSE", new URL("licenses/lucide.txt", out));
console.log("built", out.pathname, "themes:", themes.join(", "));
