// Icons from Lucide (ISC license), bundled: only the icons named here end
// up in app.js, and nothing is fetched at run time (the CSP allows no other
// origin). Icons draw in currentColor, so they follow the theme.
import { ArrowDown, ArrowUp, Check, Contrast, Copy, Funnel, Link, Maximize2, Moon, Pin, PinOff, Search, Settings, Sun, X, createElement } from "lucide";
import type { IconNode } from "lucide";

const ICONS: Record<string, IconNode> = {
  "arrow-down": ArrowDown,
  "arrow-up": ArrowUp,
  check: Check,
  contrast: Contrast,
  copy: Copy,
  filter: Funnel,
  link: Link,
  maximize: Maximize2,
  moon: Moon,
  pin: Pin,
  "pin-off": PinOff,
  search: Search,
  settings: Settings,
  sun: Sun,
  x: X,
};

// icon returns an SVG element for a named icon, sized in CSS pixels.
export function icon(name: string, size = 15): SVGElement {
  const node = ICONS[name];
  if (!node) throw new Error(`unknown icon ${name}`);
  const svg = createElement(node);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

// hydrateIcons replaces every <i data-icon="name" data-size="n"> under root
// with its SVG.
export function hydrateIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("i[data-icon]").forEach((el) => {
    el.replaceWith(icon(el.dataset.icon!, Number(el.dataset.size) || undefined));
  });
}
