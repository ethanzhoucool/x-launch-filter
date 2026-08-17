// Runs at document_start. Walks the timeline as X mounts posts and hides the
// cells that fail XLF.decide().
//
// Why the layout takeover in filter.css matters: X positions every
// cellInnerDiv absolutely with a cached translateY, so display:none on a cell
// leaves a hole the virtualiser never closes (measured: hiding a cell does not
// change any sibling's translateY). Its parent reserves scroll space with
// min-height, not height, so switching the cells to position:relative lets them
// flow and close ranks without starving the scroller.

const HTML = document.documentElement;
const DEFAULTS = self.XLF.DEFAULTS;

let cfg = self.XLF.buildConfig({});
let gateEl = null;
let hudEl = null;

// Keyed by article: the virtualiser recycles cells, so a cell is not a stable
// identity for a decision.
const decided = new WeakMap();

const filterOn = () => cfg.enabled && Date.now() >= cfg.unlockUntil;

function surface() {
  const p = location.pathname;
  if (p === "/" || p === "/home") return "home";
  if (p === "/explore" || p.startsWith("/explore/") || p.startsWith("/i/trending"))
    return "explore";
  if (p.startsWith("/search")) return "search";
  if (/^\/[A-Za-z0-9_]+\/status\//.test(p)) return "status";
  if (p.startsWith("/i/") || p.startsWith("/messages") ||
      p.startsWith("/notifications") || p.startsWith("/settings")) return "other";
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

/* ---------- the filtering pass ---------- */

function evaluate(art) {
  const prev = decided.get(art);
  if (prev && !prev.retry) return prev;

  const attempts = (prev?.attempts || 0) + 1;
  const d = self.XLF.decide(art, cfg);
  d.attempts = attempts;

  // A post whose view count never renders cannot clear a view floor, so after a
  // few frames of waiting it is judged on what is actually there.
  if (d.retry && attempts >= 4) {
    d.retry = false;
    d.reason = "no view count";
  }
  decided.set(art, d);
  return d;
}

function pass() {
  const active = filteringHere();
  HTML.classList.toggle("xlf-flow", active);

  if (!active) {
    document
      .querySelectorAll(".xlf-hide")
      .forEach((c) => c.classList.remove("xlf-hide"));
    setHud(null);
    return;
  }

  let kept = 0;
  let hidden = 0;
  let pending = false;

  for (const cell of document.querySelectorAll('[data-testid="cellInnerDiv"]')) {
    // Cells without an article are the composer, separators and the sentinel
    // that drives infinite scroll — never touch those.
    const art = cell.querySelector('article[data-testid="tweet"]');
    if (!art) continue;

    const d = evaluate(art);
    if (d.retry) pending = true;
    cell.classList.toggle("xlf-hide", !d.keep);
    if (d.keep) kept++;
    else hidden++;
  }

  setHud({ kept, hidden });
  return pending;
}

/* ---------- HUD ---------- */

function setHud(counts) {
  if (!counts || !cfg.showHud) {
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
  const n = Math.round(cfg.minViews / 1000);
  hudEl.querySelector(".xlf-hud-text").textContent =
    `${counts.kept} shown · ${counts.hidden} filtered · ${n}k+ launch posts`;
}

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
    form.addEventListener("submit", (e) => {
      e.preventDefault();
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
    HTML.classList.remove("xlf-flow");
    return;
  }
  HTML.classList.remove("xlf-gated");
  pass();
}

/* ---------- wiring ---------- */

chrome.storage.local.get(DEFAULTS, (stored) => {
  cfg = self.XLF.buildConfig(stored);
  apply();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const next = {};
  for (const [k, { newValue }] of Object.entries(changes)) next[k] = newValue;
  cfg = self.XLF.buildConfig({ ...cfg, ...next });
  // Thresholds may have moved, so every cached verdict is stale.
  if ("minViews" in next || "requireLaunch" in next ||
      "extraInclude" in next || "extraExclude" in next ||
      "hideReplies" in next || "hideReposts" in next) {
    document.querySelectorAll('article[data-testid="tweet"]')
      .forEach((a) => decided.delete(a));
  }
  apply();
});

// X is a SPA: posts stream in, and route changes never reload the document.
const observer = new MutationObserver(() => schedule());
let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    apply();
  });
}

function startObserving() {
  if (!document.body) return;
  observer.observe(document.body, { childList: true, subtree: true });
  apply();
}

let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    apply();
  }
}, 400);

// Engagement counts render a beat after the post, and an unlock can expire
// while the tab sits open.
setInterval(apply, 1500);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startObserving, { once: true });
} else {
  startObserving();
}
