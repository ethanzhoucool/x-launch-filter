// Isolated-world half of the extension. It does not filter anything — posts are
// removed from the API response by src/intercept.js before X renders them. This
// file is the interface: it bridges settings into the page world, draws the pill
// and its panel, keeps the judgement ledger, and gates Explore.
//
// Deliberately self-contained: it must not depend on src/scoring.js. Chrome
// injects a script file once even when two content_scripts entries list it, so
// scoring.js lands in the MAIN world for the interceptor and never arrives here.

const HTML = document.documentElement;

const LOCAL = {
  enabled: true, unlockUntil: 0, minViews: 50000, minLikeRate: 0,
  minBookmarkRate: 0, maxFollowers: 0, requireLaunch: true, hideAds: true,
  hideReplies: true, hideReposts: false, minPerPage: 2, topUp: false, pageSize: 60,
  searchFeed: false,
  searchLatest: false, searchVideoOnly: false, searchQuery: "",
  blockExplore: true, showHud: true, filterSearch: false, filterProfiles: false,
};

let stored = {};
let cfg = { ...LOCAL };
let gateEl = null, hudEl = null, panelEl = null, controls = null;
let tally = { kept: 0, judged: 0, rescued: 0, reseen: 0 };
// Per mode: home and search pools behave completely differently (roughly 1 in 8
// versus 4 in 5 pass), so previewing one against the other's data would lie.
let ledger = { home: [], search: [] };
let ledgerDirty = false;

const filterOn = () => cfg.enabled !== false && Date.now() >= (cfg.unlockUntil || 0);
const modeOf = (c) => (c.searchFeed ? "search" : "home");
const pausedFor = () => (cfg.unlockUntil || 0) - Date.now();

/* ---------- theme ---------- */

// X paints body per theme and exposes no class we can rely on, so the
// background is read directly. Light, dim and lights-out are far enough apart
// in luminance that summing the channels separates them cleanly.
function detectTheme() {
  let sum = 0;
  try {
    const m = (getComputedStyle(document.body).backgroundColor || "").match(/\d+/g);
    if (m) sum = Number(m[0]) + Number(m[1]) + Number(m[2]);
  } catch { sum = 0; }
  const theme = sum > 600 ? "light" : sum > 30 ? "dim" : "dark";
  if (HTML.getAttribute("data-xlf-theme") !== theme) {
    HTML.setAttribute("data-xlf-theme", theme);
  }
}

/* ---------- config bridge ---------- */

// The interceptor runs in the page world, which has no chrome.* access, and
// reads this attribute on every response. If it never lands the interceptor
// filters nothing, by design: a dead bridge must not leave a filtered page with
// no way to switch it off.
function publishConfig() {
  const payload = { ...stored };
  delete payload.history;
  delete payload.ledger;
  delete payload.seen;
  try { HTML.setAttribute("data-xlf", JSON.stringify(payload)); } catch { /* nothing to do */ }
}

/* ---------- search as the feed ---------- */

// X search has no min_views operator, and min_faves is a poorer proxy than it
// looks: measured live, high-view posts ran 0.42% and 0.56% like rates while
// low-view ones ran 2.8% to 3.7%. Tuning min_faves to the view floor therefore
// excludes the high-reach posts worth keeping. It is a junk floor only; the real
// reach bar is enforced on the results.
const LIKES_PER_VIEW = 0.002, MIN_FAVES_FLOOR = 25, MIN_FAVES_CAP = 400;

const SEARCH_TERMS = [
  '"just shipped"', '"just launched"', '"we launched"', '"launching today"',
  '"now live"', '"built this"', '"product hunt"', "waitlist", "introducing",
];

// ANDed against the launch phrases, and this is what makes the query usable.
// "just launched" alone matches ballistic missiles; alongside a product word it
// does not, because news copy almost never carries product vocabulary. Measured
// live, adding this took the news share of a page from 3-in-5 to none.
const PRODUCT_TERMS = [
  "app", "product", "beta", "tool", "API", "SaaS", "startup",
  "website", "feature", '"open source"', '"side project"',
];

function buildSearchQuery(c) {
  if (c.searchQuery && c.searchQuery.trim()) return c.searchQuery.trim();
  const parts = [`(${SEARCH_TERMS.join(" OR ")})`, `(${PRODUCT_TERMS.join(" OR ")})`];
  const faves = Math.min(MIN_FAVES_CAP, Math.round((c.minViews || 0) * LIKES_PER_VIEW));
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

// True only for the generated feed query. A manual search is the user's own
// business and keeps its own setting, otherwise the pill would appear on
// unrelated searches and claim to be the feed.
function isFeedSearch() {
  if (!cfg.searchFeed) return false;
  try {
    return (new URLSearchParams(location.search).get("q") || "").trim() === buildSearchQuery(cfg);
  } catch { return false; }
}

/* ---------- surfaces ---------- */

function surface() {
  const p = location.pathname;
  if (p === "/" || p === "/home") return "home";
  if (p === "/explore" || p.startsWith("/explore/") || p.startsWith("/i/trending")) return "explore";
  if (p.startsWith("/search")) return "search";
  if (/^\/[A-Za-z0-9_]+\/status\//.test(p)) return "status";
  if (p.startsWith("/i/") || p.startsWith("/messages") ||
      p.startsWith("/notifications") || p.startsWith("/settings")) return "other";
  if (/^\/[A-Za-z0-9_]+\/?$/.test(p)) return "profile";
  return "other";
}

// Where the pill belongs: a surface this extension is responsible for. Not the
// same as "filtering right now", because a paused filter still has to say so
// rather than vanish and look broken.
function ourSurface() {
  const s = surface();
  if (s === "home") return true;
  if (s === "search") return isFeedSearch() || cfg.filterSearch;
  if (s === "profile") return cfg.filterProfiles;
  return false;
}

const gatedHere = () => filterOn() && cfg.blockExplore && surface() === "explore";

/* ---------- the judgement ledger ---------- */

// Mirrors judge() in src/scoring.js, gate for gate. The two are tested against
// each other; if one gains a gate, so must the other.
function rejudge(r, c) {
  if (!r) return { keep: false, reason: "unreadable" };
  if (c.hideAds && r.ad) return { keep: false, reason: "ads" };
  if (c.hideReposts && r.rt) return { keep: false, reason: "reposts" };
  if (c.hideReplies && r.rp) return { keep: false, reason: "replies" };
  if (r.ns) return { keep: false, reason: "muted topics" };
  if (r.v < c.minViews) return { keep: false, reason: "views" };
  if (c.minLikeRate > 0 && r.lr < c.minLikeRate) return { keep: false, reason: "like rate" };
  if (c.minBookmarkRate > 0 && r.br < c.minBookmarkRate) return { keep: false, reason: "bookmark rate" };
  if (c.maxFollowers > 0 && r.f != null && r.f > c.maxFollowers) return { keep: false, reason: "account size" };
  if (c.requireLaunch) {
    const score = (r.kw ? 2 : 0) + (r.vid ? 1 : 0) + (r.cd ? 1 : 0) + (r.ph ? 0.5 : 0);
    if (score < 2) return { keep: false, reason: "no launch signal" };
  }
  return { keep: true, reason: "keep" };
}

const LEDGER_CAP = 300;
const SEEN_CAP = 3000;      // ids remembered
const SEEN_PUBLISH_CAP = 1000;  // ids bridged to the page world

// How many times a post has been handed to X. Counting deliveries is a proxy
// for "seen" — X may not have rendered every one — but it is the only signal
// available on this side, and it errs toward showing a post again rather than
// hiding one you never laid eyes on.
let seenCounts = {};
let seenDirty = false;

function noteDelivered(ids) {
  if (!ids || !ids.length || !cfg.hideSeenAfter) return;
  for (const id of ids) seenCounts[id] = (seenCounts[id] || 0) + 1;
  const keys = Object.keys(seenCounts);
  if (keys.length > SEEN_CAP) {
    for (const k of keys.slice(0, keys.length - SEEN_CAP)) delete seenCounts[k];
  }
  seenDirty = true;
  publishSeen();
}

// Only the ids that have had their turn cross the boundary; the counts stay
// here. Keeps the attribute to the ids that actually change a decision.
function publishSeen() {
  if (!cfg.hideSeenAfter) {
    HTML.removeAttribute("data-xlf-seen");
    return;
  }
  const done = [];
  for (const id in seenCounts) {
    if (seenCounts[id] >= cfg.hideSeenAfter) done.push(id);
  }
  try {
    HTML.setAttribute("data-xlf-seen", done.slice(-SEEN_PUBLISH_CAP).join(","));
  } catch {
    /* the feature degrades, nothing else */
  }
}

function loadSeen() {
  if (!alive()) return;
  chrome.storage.local.get({ seen: null }, (r) => {
    if (r.seen && typeof r.seen === "object") seenCounts = r.seen;
    publishSeen();
  });
}

function saveSeen() {
  if (!seenDirty || !alive()) return;
  seenDirty = false;
  try { chrome.storage.local.set({ seen: seenCounts }); } catch { /* ignore */ }
}

// Reloading the extension orphans content scripts already running in open tabs.
// Every chrome.* call from an orphan throws "Extension context invalidated",
// and this file runs three timers, so an orphan spams the error list every
// 400ms until the tab is refreshed — which buries whatever real error you were
// trying to read. On the first sign of it, stop and clean up instead.
const alive = () => {
  try { return !!chrome.runtime?.id; } catch { return false; }
};

const timers = [];
let torn = false;

function teardown() {
  if (torn) return;
  torn = true;
  timers.forEach(clearInterval);
  closePanel();
  hudEl?.remove();
  hudEl = null;
  gateEl?.remove();
  gateEl = null;
  HTML.classList.remove("xlf-gated");
}

function loadLedger() {
  if (!alive()) return;
  chrome.storage.local.get({ ledger: null }, (r) => {
    const l = r.ledger;
    if (l && Array.isArray(l.home) && Array.isArray(l.search)) ledger = l;
  });
}

function saveLedger() {
  if (!ledgerDirty || !alive()) return;
  ledgerDirty = false;
  try { chrome.storage.local.set({ ledger }); } catch { /* preview degrades, nothing else */ }
}

function addRecords(records) {
  if (!records || !records.length) return;
  const pool = ledger[modeOf(cfg)];
  if (!pool) return;
  pool.push(...records);
  if (pool.length > LEDGER_CAP) pool.splice(0, pool.length - LEDGER_CAP);
  ledgerDirty = true;
}

const short = (n) =>
  n >= 1000000 ? `${Math.round(n / 100000) / 10}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

const reasonLabel = (reason, c) =>
  reason === "views" ? `below ${short(c.minViews)} views`
  : reason === "account size" ? "account too big"
  : reason;

// Re-scores everything seen this session against a candidate config. This is
// what makes tuning legible: the traps in these settings (reach against
// engagement rate, reach against audience size) become visible as you create
// them, on real posts, before committing to a reload.
function forecast(c) {
  const pool = ledger[modeOf(c)] || [];
  const counts = new Map();
  let kept = 0;
  for (const r of pool) {
    const v = rejudge(r, c);
    if (v.keep) kept++;
    else counts.set(v.reason, (counts.get(v.reason) || 0) + 1);
  }
  const reasons = [...counts.entries()]
    .map(([reason, n]) => ({ label: reasonLabel(reason, c), n }))
    .sort((a, b) => b.n - a.n);
  return { total: pool.length, kept, reasons };
}

/* ---------- the pill ---------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const clock = (ms) => {
  const m = Math.floor(ms / 60000);
  return m >= 1 ? `${m}m` : `${Math.max(0, Math.floor(ms / 1000))}s`;
};

function pillState() {
  if (!filterOn()) return { tone: "paused", text: `Paused · ${clock(pausedFor())} left` };
  const mode = cfg.searchFeed ? "Search" : "Home";
  if (!tally.judged) return { tone: "on", text: `${mode} · watching…` };
  if (!tally.kept) return { tone: "warn", text: `Nothing passed · ${tally.judged} hidden` };
  let text = `${mode} · ${tally.kept} of ${tally.judged}`;
  if (tally.rescued) text += ` · ${tally.rescued} below bar`;
  return { tone: "on", text };
}

function setHud() {
  const show = cfg.showHud && ourSurface() && !gatedHere();
  if (!show) {
    hudEl?.remove();
    hudEl = null;
    closePanel();
    return;
  }
  if (!hudEl || !hudEl.isConnected) {
    if (!document.body) return;
    hudEl = el("div");
    hudEl.id = "xlf-hud";
    hudEl.appendChild(el("span", "xlf-dot"));
    hudEl.appendChild(el("span", "xlf-hud-text"));
    hudEl.setAttribute("role", "button");
    hudEl.tabIndex = 0;
    hudEl.setAttribute("aria-expanded", "false");
    hudEl.addEventListener("click", (e) => { e.stopPropagation(); togglePanel(); });
    hudEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePanel(); }
    });
    document.body.appendChild(hudEl);
  }
  const s = pillState();
  hudEl.dataset.tone = s.tone;
  hudEl.querySelector(".xlf-hud-text").textContent = s.text;
  hudEl.setAttribute("aria-label", `Launch filter: ${s.text}. Opens filter settings.`);
}

// The page world reports what it judged; detail is a string so it survives the
// world boundary intact.
document.addEventListener("xlf:stats", (e) => {
  try {
    const s = JSON.parse(e.detail);
    tally.kept += s.kept || 0;
    tally.judged += s.judged || 0;
    tally.rescued += s.rescued || 0;
    tally.reseen += s.reseen || 0;
    addRecords(s.records);
    noteDelivered(s.delivered);
    setHud();
    if (panelEl) refreshForecast();
  } catch { /* cosmetic */ }
});

/* ---------- the panel ---------- */

const VIEW_STEPS = [
  [0, "no floor"], [5000, "5k"], [10000, "10k"], [25000, "25k"], [50000, "50k"],
  [100000, "100k"], [250000, "250k"], [500000, "500k"], [1000000, "1M"],
];
const FOLLOWER_STEPS = [
  [0, "any size"], [1000, "under 1k"], [5000, "under 5k"], [10000, "under 10k"],
  [25000, "under 25k"], [50000, "under 50k"], [100000, "under 100k"],
  [500000, "under 500k"], [1000000, "under 1M"],
];
const LIKE_STEPS = [[0, "off"], [0.25, "0.25%"], [0.5, "0.5%"], [1, "1%"], [2, "2%"], [3, "3%"]];
const BOOKMARK_STEPS = [[0, "off"], [0.05, "0.05%"], [0.1, "0.1%"], [0.25, "0.25%"], [0.5, "0.5%"]];
const KEEPALIVE_STEPS = [[0, "off"], [1, "1 post"], [2, "2 posts"], [3, "3 posts"]];
const SORT_STEPS = [["top", "Top"], ["live", "Latest"]];
const PAUSES = [15, 30, 60];

function select(steps, current) {
  const s = document.createElement("select");
  for (const [value, label] of steps) {
    const o = document.createElement("option");
    o.value = String(value);
    o.textContent = label;
    if (String(current) === String(value)) o.selected = true;
    s.appendChild(o);
  }
  return s;
}

function row(text, control) {
  const r = el("div", "xlf-row");
  r.append(el("label", null, text), control);
  return r;
}

function check(labelText, checked, hint) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  const wrap = el("label", "xlf-check");
  const body = el("span");
  body.appendChild(el("span", null, labelText));
  if (hint) body.appendChild(el("em", null, hint));
  wrap.append(input, body);
  return { input, wrap };
}

// The config the panel would save, as opposed to the one in force.
function candidate() {
  return {
    ...cfg,
    searchFeed: controls.mode === "search",
    minViews: Number(controls.views.value),
    maxFollowers: Number(controls.followers.value),
    requireLaunch: controls.launch.checked,
    searchLatest: controls.sort.value === "live",
    searchVideoOnly: controls.video.checked,
    minLikeRate: Number(controls.likeRate.value),
    minBookmarkRate: Number(controls.bookmarkRate.value),
    minPerPage: Number(controls.keepAlive.value),
  };
}

// The tuned keys, so "did anything change" is a real comparison rather than a
// guess from counts.
const TUNED = ["searchFeed", "minViews", "maxFollowers", "requireLaunch",
  "searchLatest", "searchVideoOnly", "minLikeRate", "minBookmarkRate", "minPerPage"];
const sameBar = (a, b) => TUNED.every((k) => String(a[k]) === String(b[k]));

function refreshForecast() {
  if (!controls) return;
  const c = candidate();
  const f = forecast(c);

  controls.searchRows.forEach((r) => (r.hidden = !c.searchFeed));
  controls.keepAliveRow.hidden = !!c.searchFeed;
  controls.caption.textContent = c.searchFeed
    ? "X search does the coarse cut; your gates trim what arrives."
    : "Everything the algorithm sends gets judged here. Expect a strict cut.";
  controls.query.textContent = c.searchFeed ? buildSearchQuery(c) : "";
  controls.query.hidden = !c.searchFeed;

  if (!f.total) {
    controls.summary.textContent =
      `No data from the ${modeOf(c)} feed yet — apply once and it starts measuring.`;
  } else if (sameBar(c, cfg)) {
    controls.summary.textContent = `Keeping ${f.kept} of ${f.total} seen`;
  } else {
    // Both numbers must come from the same pool, or the comparison is noise:
    // the session tally counts this page load, the ledger spans the session.
    const now = forecast(cfg).kept;
    controls.summary.textContent = `Would keep ${f.kept} of ${f.total} seen · now ${now}`;
  }

  controls.bars.replaceChildren();
  const max = f.reasons.reduce((m, r) => Math.max(m, r.n), 0) || 1;
  for (const r of f.reasons.slice(0, 6)) {
    const line = el("div", "xlf-bar");
    line.append(el("span", "xlf-bar-label", r.label));
    const track = el("span", "xlf-bar-track");
    const fill = el("span", "xlf-bar-fill");
    fill.style.width = Math.round((r.n / max) * 100) + "%";
    track.appendChild(fill);
    line.append(track, el("span", "xlf-bar-n", String(r.n)));
    controls.bars.appendChild(line);
  }

  // Empirical beats heuristic: once there is real data, say what it says.
  let warning = "";
  if (f.total >= 20 && f.kept === 0) {
    warning = "Nothing you've seen this session would pass. Loosen something before you commit.";
  } else if (!f.total && c.minViews > 0 && c.maxFollowers > 0 && c.minViews >= c.maxFollowers) {
    const label = FOLLOWER_STEPS.find(([v]) => v === c.maxFollowers)?.[1] || "";
    warning = `${short(c.minViews)} views from an account ${label} means every post outruns ` +
      `its audience ${Math.round(c.minViews / c.maxFollowers)}x. Expect near-nothing.`;
  }
  controls.warn.textContent = warning;
  controls.warn.hidden = !warning;
}

function buildPanel() {
  const p = el("div");
  p.id = "xlf-panel";
  p.setAttribute("role", "dialog");
  p.setAttribute("aria-label", "Filter settings");
  p.addEventListener("click", (e) => e.stopPropagation());

  const head = el("div", "xlf-head");
  head.append(el("div", "xlf-title", "LAUNCH FILTER"));
  const pauseWrap = el("div", "xlf-pause");
  head.appendChild(pauseWrap);

  const mode = el("div", "xlf-seg");
  mode.setAttribute("role", "radiogroup");
  mode.setAttribute("aria-label", "Feed source");
  const segs = {};
  for (const [key, label] of [["search", "Search"], ["home", "Home"]]) {
    const b = el("button", "xlf-seg-btn", label);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => {
      controls.mode = key;
      for (const k in segs) {
        segs[k].classList.toggle("on", k === controls.mode);
        segs[k].setAttribute("aria-checked", String(k === controls.mode));
      }
      refreshForecast();
    });
    segs[key] = b;
    mode.appendChild(b);
  }

  const caption = el("p", "xlf-caption");
  const views = select(VIEW_STEPS, cfg.minViews);
  const followers = select(FOLLOWER_STEPS, cfg.maxFollowers);
  const sort = select(SORT_STEPS, cfg.searchLatest ? "live" : "top");
  const launch = check("Launch content only", cfg.requireLaunch !== false,
    "a launch keyword, or a demo video that links out");
  const video = check("Video only", !!cfg.searchVideoOnly);
  const query = el("div", "xlf-query");
  const sortRow = row("Sort", sort);

  const likeRate = select(LIKE_STEPS, cfg.minLikeRate);
  const bookmarkRate = select(BOOKMARK_STEPS, cfg.minBookmarkRate);
  const keepAlive = select(KEEPALIVE_STEPS, cfg.minPerPage);
  const keepAliveRow = row("Keep-alive", keepAlive);

  const more = document.createElement("details");
  more.className = "xlf-more";
  const sum = document.createElement("summary");
  sum.textContent = "More gates";
  more.append(sum, row("Like rate at least", likeRate),
    row("Bookmark rate at least", bookmarkRate), keepAliveRow);

  const summary = el("div", "xlf-summary");
  const bars = el("div", "xlf-bars");
  const warn = el("div", "xlf-warn");
  warn.hidden = true;
  const readout = el("div", "xlf-readout");
  readout.setAttribute("aria-live", "polite");
  readout.append(summary, bars);

  const apply = el("button", "xlf-apply", "Apply and reload");
  apply.type = "button";
  const cancel = el("button", "xlf-ghost", "Cancel");
  cancel.type = "button";
  const actions = el("div", "xlf-actions");
  actions.append(apply, cancel);
  const note = el("p", "xlf-note", "Applying reloads — posts on screen can't be re-judged.");
  const all = el("button", "xlf-link", "All settings");
  all.type = "button";

  controls = {
    mode: modeOf(cfg), views, followers, sort, launch: launch.input,
    video: video.input, likeRate, bookmarkRate, keepAlive, keepAliveRow,
    searchRows: [sortRow, video.wrap], caption, query, summary, bars, warn,
  };
  for (const k in segs) {
    segs[k].classList.toggle("on", k === controls.mode);
    segs[k].setAttribute("aria-checked", String(k === controls.mode));
  }
  [views, followers, sort, likeRate, bookmarkRate, keepAlive, launch.input, video.input]
    .forEach((n) => n.addEventListener("change", refreshForecast));

  apply.addEventListener("click", () => {
    apply.disabled = true;
    apply.textContent = "Applying…";
    const c = candidate();
    chrome.storage.local.set({
      searchFeed: c.searchFeed, minViews: c.minViews, maxFollowers: c.maxFollowers,
      requireLaunch: c.requireLaunch, searchLatest: c.searchLatest,
      searchVideoOnly: c.searchVideoOnly, minLikeRate: c.minLikeRate,
      minBookmarkRate: c.minBookmarkRate, minPerPage: c.minPerPage,
    }, () => location.reload());
  });
  cancel.addEventListener("click", closePanel);
  all.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "openOptions" });
    closePanel();
  });

  // Pause is the whole discipline mechanism now: a lease that re-arms itself.
  // Collapsed to one control because three duration chips plus the title do not
  // fit 280px, and the durations are only wanted at the moment of pausing.
  if (filterOn()) {
    const open = el("button", "xlf-chip", "Pause");
    open.type = "button";
    open.setAttribute("aria-expanded", "false");
    open.addEventListener("click", () => {
      pauseWrap.replaceChildren();
      for (const m of PAUSES) {
        const b = el("button", "xlf-chip", `${m}m`);
        b.type = "button";
        b.addEventListener("click", () => {
          chrome.runtime.sendMessage({ type: "unlock", minutes: m }, () => location.reload());
        });
        pauseWrap.appendChild(b);
      }
      pauseWrap.firstChild?.focus();
    });
    pauseWrap.appendChild(open);
  } else {
    const resume = el("button", "xlf-chip on", "Resume now");
    resume.type = "button";
    resume.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "relock" }, () => location.reload());
    });
    pauseWrap.appendChild(resume);
  }

  p.append(head, mode, caption, row("Minimum views", views), row("From accounts", followers),
    launch.wrap, sortRow, video.wrap, query, more, readout, warn, actions, note, all);
  refreshForecast();
  return p;
}

const onPanelKey = (e) => { if (e.key === "Escape") closePanel(); };

function openPanel() {
  if (!document.body) return;
  closePanel();
  panelEl = buildPanel();
  document.body.appendChild(panelEl);
  hudEl?.setAttribute("aria-expanded", "true");
  document.addEventListener("click", closePanel);
  document.addEventListener("keydown", onPanelKey);
  panelEl.querySelector(".xlf-seg-btn")?.focus();
}

function closePanel() {
  if (!panelEl) return;
  panelEl.remove();
  panelEl = null;
  controls = null;
  hudEl?.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", closePanel);
  document.removeEventListener("keydown", onPanelKey);
}

const togglePanel = () => (panelEl ? closePanel() : openPanel());

/* ---------- explore gate ---------- */

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
    gateEl.append(el("div", "xlf-mark", "▽"), el("h1", null, "Explore is off."),
      el("p", null, "Trending is the most random surface on this site. You came for launch content — search for it, or head back to the feed."),
      form);
    document.body.appendChild(gateEl);
  }
  HTML.classList.add("xlf-gated");
  document.querySelectorAll("video").forEach((v) => v.pause());
}

function apply() {
  if (!alive()) return teardown();
  detectTheme();
  if (maybeRedirectHome()) return;
  if (gatedHere()) { renderGate(); setHud(); return; }
  HTML.classList.remove("xlf-gated");
  setHud();
}

/* ---------- wiring ---------- */

loadLedger();
loadSeen();
timers.push(setInterval(saveLedger, 4000));
timers.push(setInterval(saveSeen, 5000));

chrome.storage.local.get(null, (all) => {
  stored = all || {};
  delete stored.ledger;
  delete stored.seen;
  cfg = { ...LOCAL, ...stored };
  publishConfig();
  apply();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const noise = ["ledger", "seen"];
  if (Object.keys(changes).every((k) => noise.includes(k))) return;
  for (const [k, { newValue }] of Object.entries(changes)) {
    if (noise.includes(k)) continue;
    stored[k] = newValue;
    cfg[k] = newValue;
  }
  publishConfig();
  apply();
});

let lastHref = location.href;
timers.push(setInterval(() => {
  if (!alive()) return teardown();
  detectTheme();
  if (location.href !== lastHref) {
    lastHref = location.href;
    tally = { kept: 0, judged: 0, rescued: 0, reseen: 0 };
    closePanel();
    apply();
  }
}, 400));

// A pause can expire while the tab sits open.
timers.push(setInterval(apply, 2000));
window.addEventListener("beforeunload", () => { saveLedger(); saveSeen(); });

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", apply, { once: true });
} else {
  apply();
}
