// Isolated-world half of the extension. It does three things and deliberately
// no longer filters the DOM: posts are now removed from the API response by
// src/intercept.js, before X renders them.
//
//  1. Bridges settings to the page world, which has no chrome.* access.
//  2. Draws the counter, fed by what the interceptor actually dropped.
//  3. Gates Explore / Trending.

const HTML = document.documentElement;

// Deliberately self-contained: this file must not depend on src/scoring.js.
// Chrome injects a given script file once even when two content_scripts entries
// list it, so scoring.js lands in the MAIN world for the interceptor and never
// arrives here — reading self.XLF threw on load and took the whole bridge with
// it. These are only the settings this half reads; everything in storage is
// bridged verbatim, so there is no key list to drift out of sync.
const LOCAL = {
  enabled: true,
  unlockUntil: 0,
  minViews: 50000,
  minLikeRate: 0,
  minBookmarkRate: 0,
  requireLaunch: true,
  minPerPage: 2,
  blockExplore: true,
  showHud: true,
  filterSearch: false,
  filterProfiles: false,
};

let stored = {};
let cfg = { ...LOCAL };
let gateEl = null;
let hudEl = null;
let tally = { kept: 0, dropped: 0, rescued: 0 };

const filterOn = () => cfg.enabled && Date.now() >= cfg.unlockUntil;

/* ---------- config bridge ---------- */

// The interceptor runs in the page world, which has no chrome.* access, and
// reads this attribute on every response. Written at document_start so it is in
// place before X boots and issues its first timeline request.
//
// If this never runs the interceptor filters nothing, by design: a dead bridge
// must not leave a page that is filtered with no way to switch it off.
function publishConfig() {
  const payload = { ...stored };
  delete payload.history;
  delete payload.progress;
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
    hudEl.setAttribute("role", "button");
    hudEl.setAttribute("aria-label", "Filter settings");
    hudEl.tabIndex = 0;
    hudEl.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePanel();
    });
    hudEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        togglePanel();
      }
    });
    document.body.appendChild(hudEl);
  }
  const bits = [`${tally.kept} shown`, `${tally.dropped} filtered`];
  bits.push(`${Math.round(cfg.minViews / 1000)}k+`);
  if (cfg.minLikeRate > 0) bits.push(`${cfg.minLikeRate}% likes`);
  if (cfg.minBookmarkRate > 0) bits.push(`${cfg.minBookmarkRate}% saves`);
  // Filler is the one thing here that shows you posts below your own bar, so
  // it says so rather than looking like the filter missed them.
  if (tally.rescued) bits.push(`${tally.rescued} below bar`);
  hudEl.querySelector(".xlf-hud-text").textContent = bits.join(" · ");
}

// The page world reports what it dropped; detail is a string so it survives the
// world boundary intact.
document.addEventListener("xlf:stats", (e) => {
  try {
    const s = JSON.parse(e.detail);
    tally.kept += (s.kept || 0) + (s.banked || 0);
    tally.dropped += s.dropped || 0;
    tally.rescued += s.rescued || 0;
    setHud();
  } catch {
    /* cosmetic */
  }
});

/* ---------- settings panel ---------- */

// The counter is the only piece of this extension you look at while actually
// using X, so it is also where the dials live. Saving writes to storage and
// reloads: the feed you are looking at was already filtered on the way in, so
// new thresholds cannot apply to it without refetching.

const VIEW_STEPS = [
  [0, "no floor"], [5000, "5k"], [10000, "10k"], [25000, "25k"], [50000, "50k"],
  [100000, "100k"], [250000, "250k"], [500000, "500k"], [1000000, "1M"],
];
const LIKE_STEPS = [
  [0, "off"], [0.25, "0.25%"], [0.5, "0.5%"], [1, "1%"], [2, "2%"], [3, "3%"], [5, "5%"],
];
const FILLER_STEPS = [
  [0, "none"], [1, "1"], [2, "2"], [3, "3"],
];
const BOOKMARK_STEPS = [
  [0, "off"], [0.05, "0.05%"], [0.1, "0.1%"], [0.25, "0.25%"], [0.5, "0.5%"], [1, "1%"],
];

let panelEl = null;

function buildSelect(steps, current) {
  const s = document.createElement("select");
  for (const [value, label] of steps) {
    const o = document.createElement("option");
    o.value = String(value);
    o.textContent = label;
    if (Number(current) === value) o.selected = true;
    s.appendChild(o);
  }
  return s;
}

function panelRow(text, control) {
  const r = el("div", "xlf-row");
  r.append(el("label", null, text), control);
  return r;
}

function buildPanel() {
  const p = el("div");
  p.id = "xlf-panel";
  p.addEventListener("click", (e) => e.stopPropagation());

  const views = buildSelect(VIEW_STEPS, cfg.minViews);
  const likes = buildSelect(LIKE_STEPS, cfg.minLikeRate);
  const marks = buildSelect(BOOKMARK_STEPS, cfg.minBookmarkRate);

  const filler = buildSelect(FILLER_STEPS, cfg.minPerPage);

  const launch = document.createElement("input");
  launch.type = "checkbox";
  launch.checked = cfg.requireLaunch !== false;
  const launchRow = el("label", "xlf-check");
  launchRow.append(launch, el("span", null, "Require launch signals"));

  const save = el("button", "xlf-save", "Save and reload");
  save.type = "button";
  const cancel = el("button", "xlf-ghost", "Cancel");
  cancel.type = "button";
  const more = el("button", "xlf-link", "All settings");
  more.type = "button";

  save.addEventListener("click", () => {
    save.disabled = true;
    save.textContent = "Saving\u2026";
    chrome.storage.local.set(
      {
        minViews: Number(views.value),
        minLikeRate: Number(likes.value),
        minBookmarkRate: Number(marks.value),
        requireLaunch: launch.checked,
        minPerPage: Number(filler.value),
      },
      () => location.reload()
    );
  });
  cancel.addEventListener("click", closePanel);
  more.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "openOptions" });
    closePanel();
  });

  const actions = el("div", "xlf-actions");
  actions.append(save, cancel);

  p.append(
    el("div", "xlf-title", "Filter"),
    panelRow("Minimum views", views),
    panelRow("Like rate", likes),
    panelRow("Bookmark rate", marks),
    panelRow("Below-bar filler", filler),
    launchRow,
    actions,
    more
  );
  return p;
}

function onPanelKey(e) {
  if (e.key === "Escape") closePanel();
}

function openPanel() {
  if (!document.body) return;
  closePanel();
  panelEl = buildPanel();
  document.body.appendChild(panelEl);
  document.addEventListener("click", closePanel);
  document.addEventListener("keydown", onPanelKey);
}

function closePanel() {
  panelEl?.remove();
  panelEl = null;
  document.removeEventListener("click", closePanel);
  document.removeEventListener("keydown", onPanelKey);
}

const togglePanel = () => (panelEl ? closePanel() : openPanel());

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

chrome.storage.local.get(null, (all) => {
  stored = all || {};
  cfg = { ...LOCAL, ...stored };
  publishConfig();
  apply();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [k, { newValue }] of Object.entries(changes)) {
    stored[k] = newValue;
    cfg[k] = newValue;
  }
  publishConfig();
  apply();
});

let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    // Counts are per-surface; carrying them across a route change is noise.
    tally = { kept: 0, dropped: 0, rescued: 0 };
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
