// Isolated-world half of the extension. It does three things and deliberately
// no longer filters the DOM: posts are now removed from the API response by
// src/intercept.js, before X renders them.
//
//  1. Bridges settings to the page world, which has no chrome.* access.
//  2. Draws the counter, fed by what the interceptor actually dropped.
//  3. Gates Explore / Trending.

const HTML = document.documentElement;
const DEFAULTS = self.XLF.DEFAULTS;

let cfg = { ...DEFAULTS };
let gateEl = null;
let hudEl = null;
let tally = { kept: 0, dropped: 0 };

const filterOn = () => cfg.enabled && Date.now() >= cfg.unlockUntil;

/* ---------- config bridge ---------- */

// The interceptor runs in the page world and reads this attribute on every
// response. Written at document_start so it is in place before X boots and
// issues its first timeline request.
function publishConfig() {
  const payload = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (k !== "history") payload[k] = cfg[k];
  }
  try {
    HTML.setAttribute("data-xlf", JSON.stringify(payload));
  } catch {
    /* nothing useful to do */
  }
}

/* ---------- surfaces ---------- */

function surface() {
  const p = location.pathname;
  if (p === "/" || p === "/home") return "home";
  if (p === "/explore" || p.startsWith("/explore/") || p.startsWith("/i/trending"))
    return "explore";
  if (p.startsWith("/search")) return "search";
  if (/^\/[A-Za-z0-9_]+\/status\//.test(p)) return "status";
  if (
    p.startsWith("/i/") || p.startsWith("/messages") ||
    p.startsWith("/notifications") || p.startsWith("/settings")
  ) return "other";
  if (/^\/[A-Za-z0-9_]+\/?$/.test(p)) return "profile";
  return "other";
}

function filteringHere() {
  if (!filterOn()) return false;
  const s = surface();
  if (s === "home") return true;
  if (s === "search") return cfg.filterSearch;
  if (s === "profile") return cfg.filterProfiles;
  return false;
}

const gatedHere = () => filterOn() && cfg.blockExplore && surface() === "explore";

/* ---------- counter ---------- */

function setHud() {
  const show = cfg.showHud && filteringHere() && !gatedHere();
  if (!show) {
    hudEl?.remove();
    hudEl = null;
    return;
  }
  if (!hudEl || !hudEl.isConnected) {
    if (!document.body) return;
    hudEl = document.createElement("div");
    hudEl.id = "xlf-hud";
    hudEl.appendChild(document.createElement("span")).className = "xlf-dot";
    hudEl.appendChild(document.createElement("span")).className = "xlf-hud-text";
    document.body.appendChild(hudEl);
  }
  const bits = [`${tally.kept} shown`, `${tally.dropped} filtered`];
  bits.push(`${Math.round(cfg.minViews / 1000)}k+`);
  if (cfg.minLikeRate > 0) bits.push(`${cfg.minLikeRate}% likes`);
  if (cfg.minBookmarkRate > 0) bits.push(`${cfg.minBookmarkRate}% saves`);
  hudEl.querySelector(".xlf-hud-text").textContent = bits.join(" · ");
}

// The page world reports what it dropped; detail is a string so it survives the
// world boundary intact.
document.addEventListener("xlf:stats", (e) => {
  try {
    const s = JSON.parse(e.detail);
    tally.kept += s.kept || 0;
    tally.dropped += s.dropped || 0;
    setHud();
  } catch {
    /* cosmetic */
  }
});

/* ---------- explore gate ---------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderGate() {
  if (!document.body) return;
  if (!gateEl || !gateEl.isConnected) {
    gateEl = el("div");
    gateEl.id = "xlf-gate";
    const form = el("form");
    const input = el("input");
    input.type = "search";
    input.placeholder = "Search for something specific";
    input.autocomplete = "off";
    input.spellcheck = false;
    const submit = el("button", null, "Search");
    submit.type = "submit";
    form.append(input, submit);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const q = input.value.trim();
      if (q) location.href = "/search?q=" + encodeURIComponent(q) + "&f=live";
    });
    gateEl.append(
      el("div", "xlf-mark", "▽"),
      el("h1", null, "Explore is off."),
      el(
        "p",
        null,
        "Trending is the most random surface on this site. You came here for launch videos — search for them, or go back to the filtered feed."
      ),
      form
    );
    document.body.appendChild(gateEl);
  }
  HTML.classList.add("xlf-gated");
  document.querySelectorAll("video").forEach((v) => v.pause());
}

function apply() {
  if (gatedHere()) {
    renderGate();
    setHud();
    return;
  }
  HTML.classList.remove("xlf-gated");
  setHud();
}

/* ---------- wiring ---------- */

chrome.storage.local.get(DEFAULTS, (stored) => {
  cfg = { ...DEFAULTS, ...stored };
  publishConfig();
  apply();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [k, { newValue }] of Object.entries(changes)) cfg[k] = newValue;
  publishConfig();
  apply();
});

let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    // Counts are per-surface; carrying them across a route change is noise.
    tally = { kept: 0, dropped: 0 };
    apply();
  }
}, 400);

// An unlock can expire while the tab sits open.
setInterval(apply, 2000);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", apply, { once: true });
} else {
  apply();
}
