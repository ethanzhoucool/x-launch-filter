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
  maxFollowers: 0,
  requireLaunch: true,
  minPerPage: 2,
  searchFeed: false,
  searchLatest: false,
  searchVideoOnly: false,
  searchQuery: "",
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

const filterOn = () => cfg.enabled !== false && Date.now() >= (cfg.unlockUntil || 0);

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

/* ---------- search as the feed ---------- */

// X's search filters server-side and paginates natively, which sidesteps the
// whole problem the algorithmic timeline creates: there, a strict bar empties
// the page and an empty page ends the feed. Here the pool arriving is already
// mostly good, so the gates trim rather than gut it.
//
// The catch is that X search has no min_views operator, and min_faves is a
// worse proxy for reach than it first appears. Measured on live search results:
// the high-view posts ran 0.42% and 0.56% like rates while the low-view ones ran
// 2.8% to 3.7%. Engagement rate falls as reach rises, so a min_faves tuned to
// the view floor excludes precisely the posts worth keeping — a 40k-view post
// with 170 likes dies at min_faves:300.
//
// So min_faves is used as a junk floor, not as a stand-in for the view floor.
// It is deliberately set well below what the view floor implies, and the exact
// reach bar is enforced here on the results, where it can be done properly.
const LIKES_PER_VIEW = 0.002;
const MIN_FAVES_FLOOR = 25;
const MIN_FAVES_CAP = 400;

// Phrases, not bare words. "launch" on its own matches missile launches, rocket
// launches and launch parties — the first live test of this query returned a
// ballistic missile report as its top hit. Every term here only really occurs
// around a product.
const SEARCH_TERMS = [
  '"just shipped"', '"just launched"', '"we launched"', '"launching today"',
  '"now live"', '"built this"', '"product hunt"', "waitlist", "introducing",
];

// ANDed against the launch phrases, and this is the single thing that makes the
// query usable. "just launched" alone matches ballistic missiles; "just
// launched" AND one of these does not, because news copy almost never carries
// product vocabulary. Measured on live results, adding this group took the
// news share of a page from 3-in-5 down to 1-in-5.
const PRODUCT_TERMS = [
  "app", "product", "beta", "tool", "API", "SaaS", "startup",
  "website", "feature", '"open source"', '"side project"',
];

function buildSearchQuery(c) {
  if (c.searchQuery && c.searchQuery.trim()) return c.searchQuery.trim();
  const parts = [
    `(${SEARCH_TERMS.join(" OR ")})`,
    `(${PRODUCT_TERMS.join(" OR ")})`,
  ];
  const raw = Math.round((c.minViews || 0) * LIKES_PER_VIEW);
  const faves = Math.min(MIN_FAVES_CAP, raw);
  if (faves >= MIN_FAVES_FLOOR) parts.push(`min_faves:${faves}`);
  if (c.searchVideoOnly) parts.push("filter:native_video");
  parts.push("-filter:replies", "lang:en");
  return parts.join(" ");
}

const searchFeedUrl = (c) =>
  "/search?q=" + encodeURIComponent(buildSearchQuery(c)) +
  "&f=" + (c.searchLatest ? "live" : "top");

// Only ever fires on the home path, so it cannot loop: the destination is
// /search, which is not a redirect source.
function maybeRedirectHome() {
  if (!filterOn() || !cfg.searchFeed) return false;
  const p = location.pathname;
  if (p !== "/" && p !== "/home") return false;
  location.replace(searchFeedUrl(cfg));
  return true;
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
  if (s === "search") return cfg.filterSearch || cfg.searchFeed;
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
  // 0 shown / 0 filtered reads like a broken extension. It actually means no
  // posts reached the filter at all, which is a different problem from a bar
  // nothing clears, and the two need different fixes.
  const bits = [];
  if (!tally.kept && !tally.dropped) bits.push("no posts to filter yet");
  else if (!tally.kept) bits.push(`nothing cleared the bar · ${tally.dropped} filtered`);
  else bits.push(`${tally.kept} shown`, `${tally.dropped} filtered`);
  bits.push(`${Math.round(cfg.minViews / 1000)}k+`);
  if (cfg.minLikeRate > 0) bits.push(`${cfg.minLikeRate}% likes`);
  if (cfg.minBookmarkRate > 0) bits.push(`${cfg.minBookmarkRate}% saves`);
  if (cfg.maxFollowers > 0) {
    const f = cfg.maxFollowers >= 1000
      ? `${Math.round(cfg.maxFollowers / 1000)}k`
      : cfg.maxFollowers;
    bits.push(`under ${f} followers`);
  }
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
const FOLLOWER_STEPS = [
  [0, "any"], [1000, "1k"], [5000, "5k"], [10000, "10k"], [25000, "25k"],
  [50000, "50k"], [100000, "100k"], [500000, "500k"], [1000000, "1M"],
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

  const followers = buildSelect(FOLLOWER_STEPS, cfg.maxFollowers);
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
        maxFollowers: Number(followers.value),
        searchFeed: useSearch.checked,
        searchLatest: latest.checked,
        searchVideoOnly: vidOnly.checked,
      },
      () => location.reload()
    );
  });
  cancel.addEventListener("click", closePanel);
  more.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "openOptions" });
    closePanel();
  });

  // A follower ceiling caps reach; a view floor demands it. Set both hard enough
  // and you are asking for posts that outran their author's whole audience,
  // which is rare enough to empty the feed. Say so before it happens.
  const warn = el("div", "xlf-warn");
  warn.hidden = true;
  const checkCombo = () => {
    const v = Number(views.value);
    const f = Number(followers.value);
    if (!v || !f) {
      warn.hidden = true;
      return;
    }
    const ratio = v / f;
    if (ratio < 1) {
      warn.hidden = true;
      return;
    }
    const nice = ratio >= 2 ? `${Math.round(ratio)}x` : "past";
    warn.textContent =
      `Every post would have to reach ${nice} its author's whole audience. ` +
      `That is rare, so expect very few posts — or none.`;
    warn.hidden = false;
  };
  views.addEventListener("change", checkCombo);
  followers.addEventListener("change", checkCombo);
  checkCombo();

  // Search-as-feed. Shown with the query it will actually run, because a
  // generated search you cannot see is impossible to trust or debug.
  const useSearch = document.createElement("input");
  useSearch.type = "checkbox";
  useSearch.checked = !!cfg.searchFeed;
  const useSearchRow = el("label", "xlf-check");
  useSearchRow.append(useSearch, el("span", null, "Use search as the feed"));

  const latest = document.createElement("input");
  latest.type = "checkbox";
  latest.checked = cfg.searchLatest !== false;
  const latestRow = el("label", "xlf-check xlf-sub");
  latestRow.append(latest, el("span", null, "Newest first (off = top posts)"));

  const vidOnly = document.createElement("input");
  vidOnly.type = "checkbox";
  vidOnly.checked = !!cfg.searchVideoOnly;
  const vidRow = el("label", "xlf-check xlf-sub");
  vidRow.append(vidOnly, el("span", null, "Video posts only"));

  const preview = el("div", "xlf-query");

  const refreshSearch = () => {
    const on = useSearch.checked;
    latestRow.hidden = !on;
    vidRow.hidden = !on;
    preview.hidden = !on;
    if (!on) return;
    preview.textContent = buildSearchQuery({
      ...cfg,
      minViews: Number(views.value),
      searchVideoOnly: vidOnly.checked,
    });
  };
  [useSearch, vidOnly, views].forEach((n) =>
    n.addEventListener("change", refreshSearch)
  );
  refreshSearch();

  const actions = el("div", "xlf-actions");
  actions.append(save, cancel);

  p.append(
    el("div", "xlf-title", "Filter"),
    panelRow("Minimum views", views),
    panelRow("Like rate", likes),
    panelRow("Bookmark rate", marks),
    panelRow("Max followers", followers),
    panelRow("Below-bar filler", filler),
    warn,
    launchRow,
    useSearchRow,
    latestRow,
    vidRow,
    preview,
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
  if (maybeRedirectHome()) return;
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
