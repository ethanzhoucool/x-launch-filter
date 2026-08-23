// Isolated-world half of the extension. It does not filter anything — posts are
// removed from the API response by src/intercept.js before X renders them. This
// file is the interface: it bridges settings into the page world, draws the pill
// and its panel, keeps the judgement ledger, and gates Explore.
//
// Deliberately self-contained: it must not depend on src/scoring.js. Chrome
// injects a script file once even when two content_scripts entries list it, so
// scoring.js lands in the MAIN world for the interceptor and never arrives here.

const HTML = document.documentElement;

// Fallbacks for a key that has never been written to storage. This list has to
// agree with XLF.DEFAULTS key for key, and test/defaults.test.js fails if it
// does not — a key present there and missing here reads as undefined, which is
// falsy, which silently turns its feature off. That is exactly how hiding
// repeats came to be dead code: the default lived in scoring.js, this file
// cannot import scoring.js, and nothing ever wrote the key.
const LOCAL = {
  enabled: true, unlockUntil: 0, minViews: 50000, minLikeRate: 0,
  minBookmarkRate: 0, maxFollowers: 0, requireLaunch: true, hideAds: true,
  hideReplies: true, hideReposts: false, minPerPage: 2, topUp: false, pageSize: 60,
  hideSeenAfter: 2, searchRotate: true, searchRotation: 0, searchFeed: false,
  searchLatest: false, searchVideoOnly: false, searchQuery: "",
  blockExplore: true, showHud: true, filterSearch: false, filterProfiles: false,
  extraInclude: "", extraExclude: "", debug: false,
};

let stored = {};
let cfg = { ...LOCAL };
let gateEl = null, hudEl = null, panelEl = null, controls = null;
let tally = { kept: 0, judged: 0, rescued: 0, reseen: 0, repeated: 0 };
let redirecting = false;
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
  // What counts as the feed, so the page world can tell it apart from a search
  // you typed. Window stripped, so it survives midnight and a restored tab.
  if (cfg.searchFeed) payload.feedQueryBase = feedQueryBase(cfg);
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
  "built", "build", "building", "made", "shipped", "launched", "launching",
  "introducing", '"it\'s called"', "demo",
];

// ANDed against the action words, and this is what makes the query usable.
// "built" alone matches half of X; alongside a product word it does not,
// because news copy almost never carries product vocabulary. Measured live,
// adding this group took the news share of a page from 3-in-5 to none.
//
// Both groups were rebuilt from 3,219 scraped viral demo posts. The hand-
// written originals covered 2.7% of them; these cover 21.3%. The corpus skews
// toward AI and dev-tool demos, which is the intended target, so terms like
// "agent" and "model" are deliberate rather than accidental.
const PRODUCT_TERMS = [
  "app", "agent", "tool", "product", "API", "SaaS", "startup", "website",
  "feature", '"open source"', "model", "coding", "iOS", "Android",
];

// Hiding repeats and a fixed query work against each other. One query sorted by
// Top is a nearly static ranking: it returns the same page every visit, the
// ledger correctly hides all of it, and the feed goes blank. So the query has to
// move, and the date window is the lever that moves it furthest — Top of the
// last two days and Top of a fortnight ago are disjoint sets by construction,
// where rewording the terms mostly reshuffles the same posts.
//
// Ordered freshest first, ending with the unwindowed query, which is the one
// that repeats the most and so is worth the fewest visits.
const WINDOWS = [
  { from: 2, to: 0 },
  { from: 5, to: 2 },
  { from: 10, to: 5 },
  { from: 21, to: 10 },
  null,
];

const dayStamp = (daysAgo) =>
  new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

// Identifying the feed by its whole query was a bug with a clock in it. The
// window is rebuilt from Date.now() on every call, so at UTC midnight every
// generated query changed while the tab kept the one it was opened with: no
// window matched, the surface stopped counting as the feed, filtering stopped
// silently and the pill vanished. A restored session tab had the same problem
// from the moment it opened. What identifies the feed is everything except the
// window, so that is what gets compared.
const withoutWindow = (q) =>
  String(q || "").replace(/\s*\b(?:since|until)(?:_time)?:\S+/gi, "").replace(/\s+/g, " ").trim();

// A hand-written query is the user's, untouched. Rotation only applies to the
// one this file generates.
function windowFor(c) {
  if (!c.searchRotate || (c.searchQuery && c.searchQuery.trim())) return null;
  return WINDOWS[((c.searchRotation || 0) % WINDOWS.length + WINDOWS.length) % WINDOWS.length];
}

function buildSearchQuery(c, win) {
  if (c.searchQuery && c.searchQuery.trim()) return c.searchQuery.trim();
  const parts = [`(${SEARCH_TERMS.join(" OR ")})`, `(${PRODUCT_TERMS.join(" OR ")})`];
  const faves = Math.min(MIN_FAVES_CAP, Math.round((c.minViews || 0) * LIKES_PER_VIEW));
  if (faves >= MIN_FAVES_FLOOR) parts.push(`min_faves:${faves}`);
  if (c.searchVideoOnly) parts.push("filter:native_video");
  const w = win === undefined ? windowFor(c) : win;
  if (w) {
    parts.push(`since:${dayStamp(w.from)}`);
    if (w.to > 0) parts.push(`until:${dayStamp(w.to)}`);
  }
  parts.push("-filter:replies", "lang:en");
  return parts.join(" ");
}

const searchFeedUrl = (c) =>
  "/search?q=" + encodeURIComponent(buildSearchQuery(c)) +
  "&f=" + (c.searchLatest ? "live" : "top");

// Only ever fires on the home path, so it cannot loop: the destination is
// /search, which is not a redirect source.
function maybeRedirectHome() {
  if (!filterOn() || !cfg.searchFeed || redirecting) return false;
  const p = location.pathname;
  if (p !== "/" && p !== "/home") return false;
  const url = searchFeedUrl(cfg);
  redirecting = true;
  if (!cfg.searchRotate || !alive()) {
    location.replace(url);
    return true;
  }
  // Advance before leaving. Storage is the only thing that survives the
  // navigation, and writing after location.replace() is a race with it. But the
  // navigation cannot be left hostage to that callback: if the extension is
  // reloaded in the gap, it never fires, and the latch above then strands the
  // tab on a home timeline it will not filter and will not leave.
  const next = ((cfg.searchRotation || 0) + 1) % WINDOWS.length;
  cfg.searchRotation = next;
  let gone = false;
  const go = () => { if (!gone) { gone = true; location.replace(url); } };
  try {
    chrome.storage.local.set({ searchRotation: next }, go);
  } catch {
    go();
  }
  setTimeout(go, 400);
  return true;
}

// The query that identifies the feed, window stripped. Published to the page
// world, which cannot build it: the query is assembled here.
const feedQueryBase = (c) => withoutWindow(buildSearchQuery(c, null));

// True for any window of the generated feed query, whatever day it was built
// on. A manual search is the user's own business and keeps its own setting,
// otherwise the pill would appear on unrelated searches and claim to be the
// feed.
function isFeedSearch() {
  if (!cfg.searchFeed) return false;
  try {
    const q = (new URLSearchParams(location.search).get("q") || "").trim();
    return !!q && withoutWindow(q) === feedQueryBase(cfg);
  } catch {
    return false;
  }
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

/* ---------- the repeat ledger ---------- */

// Two things were wrong with the first version of this, and the second is why
// repeats survived the one gesture where you notice them.
//
// It counted deliveries. A post X handed over was marked seen whether or not it
// ever reached the viewport, and a post you scrolled past ten times counted
// once. Seen now means what the word means: the article was on screen, half of
// it or more, long enough to read. The observer is further down this file.
//
// And it published the suppression list on a DOM attribute written after an
// async chrome.storage read. The interceptor reads that list synchronously,
// inside an XHR getter, and the first timeline response of a page load lands
// before any async read can finish — so on a reload the list was still empty
// and the first page came through unfiltered. That first page is the whole
// complaint. The ledger now lives in localStorage, which the page world and
// this one share and both read synchronously, so it is already in place when
// the first response arrives. chrome.storage.local keeps the durable copy:
// x.com can clear its own storage, and twitter.com is a separate origin with a
// separate one.

const SEEN_KEY = "xlf.seen";       // id -> [impressions, day], owned here
const HIDDEN_KEY = "xlf.hidden";   // ids at or over the bar; the page world reads this
const CLEARED_KEY = "xlf.cleared"; // when the ledger was last emptied, ms
const SEEN_CAP = 8000;             // ids remembered, the stalest evicted first
const SEEN_DAYS = 45;              // and forgotten this long after the last sighting
const DAY = 86400000;
const today = () => Math.floor(Date.now() / DAY);

let seen = Object.create(null);
let seenDirty = false;
let hiddenDirty = false;
// When this tab believes the ledger was last emptied. Forgetting has to reach
// two places this tab does not control: another open tab, which holds the whole
// map in memory and would merge it back over the empty file within seconds, and
// the settings page, which usually runs with no x.com tab open at all and can
// only clear the backup. So a clear is recorded as a time, both copies carry
// it, and whoever sees a newer one drops what they were holding.
let clearedAt = 0;

const readLocal = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLocal = (k, v) => { try { localStorage.setItem(k, v); } catch { /* quota, private mode */ } };

function parseSeen(raw) {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

// Two x.com tabs share one localStorage and neither knows what the other
// counted, so a write merges instead of overwriting. Taking the larger count
// under-counts when both tabs saw the same post independently, which costs one
// more sighting before it is hidden. The other direction would hide posts you
// never saw, so this is the side to err on.
function mergeSeen(into, from) {
  for (const id in from) {
    const b = from[id];
    // Anything not in the current shape is from the delivery-counting version,
    // keyed by entry id rather than post id. It cannot be translated: drop it.
    if (!Array.isArray(b) || b.length !== 2) continue;
    const a = into[id];
    into[id] = a ? [Math.max(a[0], b[0]), Math.max(a[1], b[1])] : [b[0], b[1]];
  }
  return into;
}

function pruneSeen() {
  const cutoff = today() - SEEN_DAYS;
  for (const id in seen) {
    const e = seen[id];
    if (!Array.isArray(e) || e[1] < cutoff) delete seen[id];
  }
  const live = Object.keys(seen);
  if (live.length > SEEN_CAP) {
    // Stalest first. A post still being re-served is worth remembering; one you
    // last saw a month ago is not what is clogging the feed today.
    live.sort((a, b) => seen[a][1] - seen[b][1]);
    for (const id of live.slice(0, live.length - SEEN_CAP)) delete seen[id];
  }
}

// The only thing that crosses into the page world, and only the ids that
// actually change a decision. Seeded from what is already on disk so that a
// page load does not rewrite an identical string, and — more importantly — does
// not overwrite a list computed with the user's real bar using one computed
// with this file's default. That default is 2; at a bar of 3 the first response
// of every page load would retire posts a read early, and the first response is
// the whole reason this list lives on disk.
let hiddenPublished = null;
function publishHidden() {
  const bar = Number(cfg.hideSeenAfter) || 0;
  let out = "";
  if (bar > 0) {
    const ids = [];
    for (const id in seen) if (seen[id][0] >= bar) ids.push(id);
    out = ids.join(",");
  }
  if (out === hiddenPublished) return;
  hiddenPublished = out;
  // Deferred to the save tick. At a bar of 1 every post read changes
  // membership, and this string runs to thousands of ids: writing it
  // synchronously on each one puts a six-figure setItem in the middle of a
  // scroll. The interceptor only needs it by the next response, and the flush
  // on the way out covers a reload.
  hiddenDirty = true;
}

function flushHidden() {
  if (!hiddenDirty) return;
  hiddenDirty = false;
  writeLocal(HIDDEN_KEY, hiddenPublished || "");
}

function noteImpression(id) {
  if (!id || !cfg.hideSeenAfter) return;
  const e = seen[id];
  if (e) { e[0]++; e[1] = today(); } else { seen[id] = [1, today()]; }
  seenDirty = true;
  publishHidden();
}

const seenSize = () => Object.keys(seen).length;

function loadSeen() {
  const local = parseSeen(readLocal(SEEN_KEY));
  if (local) seen = mergeSeen(Object.create(null), local);
  clearedAt = Number(readLocal(CLEARED_KEY)) || 0;
  // Deliberately no publishHidden() here. cfg is still this file's defaults —
  // the real one arrives in an async callback — so publishing now would
  // overwrite a correct list with one computed at the wrong bar. What is
  // already on disk was written by the last page load, at the right bar, and is
  // exactly what the first response should be judged against.
  hiddenPublished = readLocal(HIDDEN_KEY);
  if (!alive()) return;
  // The durable copy fills in whatever this origin has lost: cleared site data,
  // or a first visit to x.com after a stretch on twitter.com.
  chrome.storage.local.get({ seen: null, seenClearedAt: 0 }, (r) => {
    // A clear from the settings page, which had no tab to talk to.
    if ((r.seenClearedAt || 0) > clearedAt) {
      forgetSeen(r.seenClearedAt);
      return;
    }
    if (!r.seen || typeof r.seen !== "object") return;
    seen = mergeSeen(mergeSeen(Object.create(null), r.seen), seen);
    pruneSeen();
    publishHidden();
    seenDirty = true;
  });
}

// Two clocks, because the two copies cost different amounts. localStorage is
// the working copy, is what the page world actually reads, and is cheap. The
// chrome.storage backup is a quarter of a megabyte that wakes the service
// worker and every onChanged listener, so it goes at a minute's cadence and on
// the way out.
const BACKUP_EVERY = 60000;
let lastBackup = 0;
let backupDirty = false;

function saveSeen(force) {
  // Another tab may have emptied the ledger since the last save. Merging our
  // copy over the top would put it straight back, and the panel's forget button
  // has no way to reach that tab.
  const stamp = Number(readLocal(CLEARED_KEY)) || 0;
  if (stamp > clearedAt) {
    clearedAt = stamp;
    seen = Object.create(null);
    seenDirty = false;
    publishHidden();
  }
  if (seenDirty) {
    seenDirty = false;
    backupDirty = true;
    seen = mergeSeen(mergeSeen(Object.create(null), parseSeen(readLocal(SEEN_KEY)) || {}), seen);
    pruneSeen();
    writeLocal(SEEN_KEY, JSON.stringify(seen));
    publishHidden();
  }
  flushHidden();
  if (!backupDirty || !alive()) return;
  if (!force && Date.now() - lastBackup < BACKUP_EVERY) return;
  backupDirty = false;
  lastBackup = Date.now();
  try { chrome.storage.local.set({ seen }); } catch { /* the ledger degrades, nothing else */ }
}

function forgetSeen(at) {
  clearedAt = at || Date.now();
  seen = Object.create(null);
  seenDirty = false;
  backupDirty = false;
  countedThisLoad = new Set();
  writeLocal(SEEN_KEY, "{}");
  writeLocal(CLEARED_KEY, String(clearedAt));
  hiddenPublished = null;
  publishHidden();
  flushHidden();   // this one is worth writing straight away
  if (!alive()) return;
  try {
    chrome.storage.local.set({ seen: {}, seenClearedAt: clearedAt });
  } catch { /* ignore */ }
}

/* ---------- what counts as seen ---------- */

const DWELL_MS = 800;    // on screen this long before it counts
const VISIBLE = 0.5;     // and at least half of it showing
const FILLS = 0.6;       // or enough of it to fill the screen

// Half of a post is the wrong test on its own, because a post taller than the
// window can never reach it: a 2,000px demo video in an 800px viewport peaks at
// 0.4 and would never retire. Those are precisely the posts this feed is made
// of. So either half the post is showing, or the part that is showing fills
// most of the window — which is what reading a tall post looks like.
function readable(e) {
  if (e.intersectionRatio >= VISIBLE) return true;
  const root = e.rootBounds;
  return !!root && root.height > 0 && e.intersectionRect.height >= root.height * FILLS;
}

// The permalink is the anchor wrapping the timestamp — the only /status/ link
// in a post that is reliably the post's own. The other two candidates, the
// /analytics link and a /photo/N link, carry no <time>.
//
// The parentElement step is load-bearing and was measured, not assumed. X puts
// role="link" on the anchor itself, so closest() called on the anchor always
// matches the anchor, and a check written the obvious way rejects every post on
// the page. What it is actually looking for is a quoted post's container, which
// wraps the anchor — so the walk has to start above it.
function tweetIdOf(art) {
  for (const a of art.querySelectorAll('a[href*="/status/"]')) {
    if (!a.querySelector("time")) continue;
    if (a.parentElement && a.parentElement.closest('[role="link"]')) continue;
    const m = /\/status\/(\d+)/.exec(a.getAttribute("href") || "");
    if (m) return m[1];
  }
  return null;
}

let watcher = null;
const watched = new WeakSet();
const dwelling = new WeakMap();
// One count per post per page load. Scrolling back up to something is not
// seeing it a second time; reloading and being served it again is, and that is
// the case this whole feature exists for.
let countedThisLoad = new Set();

function onScreen(entries) {
  for (const e of entries) {
    const art = e.target;
    if (e.isIntersecting && readable(e)) {
      if (dwelling.has(art)) continue;
      dwelling.set(art, setTimeout(() => {
        dwelling.delete(art);
        // Read the id when the dwell completes, not when it started: X recycles
        // these elements, and the one in front of you now is what you saw.
        const id = tweetIdOf(art);
        if (!id || countedThisLoad.has(id)) return;
        countedThisLoad.add(id);
        noteImpression(id);
      }, DWELL_MS));
    } else {
      const t = dwelling.get(art);
      if (t) { clearTimeout(t); dwelling.delete(art); }
    }
  }
}

// X virtualises the timeline: a handful of articles exist at a time and they are
// recycled constantly. A sweep on the tick this file already runs is cheaper and
// far quieter than a MutationObserver over a page that mutates this much.
function watchPosts() {
  // Deliberately not gated on the filter being on. A pause shows you the raw
  // feed, and posts read during one have been read; not counting them would
  // make pausing a way to quietly reset the ledger.
  if (!cfg.hideSeenAfter || !ourSurface()) return;
  // Several thresholds, not two: a tall post's ratio may top out below 0.5, so
  // the callback has to fire on the way up for readable() to get a look at it.
  if (!watcher) {
    watcher = new IntersectionObserver(onScreen, { threshold: [0, 0.1, 0.25, 0.5, 0.75] });
  }
  for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
    if (watched.has(art)) continue;
    watched.add(art);
    watcher.observe(art);
  }
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
  watcher?.disconnect();
  watcher = null;
  // The page world reads its config from this attribute and treats absence as
  // off. Leaving it behind would strand a filtered timeline with a dead bridge
  // and no way to switch it off — the exact thing that design is meant to
  // prevent.
  HTML.removeAttribute("data-xlf");
  closePanel();
  gateEl?.remove();
  gateEl = null;
  HTML.classList.remove("xlf-gated");

  // The pill stays, and says what happened. An orphan means the extension was
  // reloaded under a live tab: filtering has just stopped, the ledger has
  // stopped recording, and nothing here can talk to storage again. A pill that
  // simply vanishes reads as a crash — which is exactly how it read the first
  // time this happened. Cloned rather than relabelled, because the clone drops
  // the listeners that would open a panel with no extension behind it.
  if (hudEl?.isConnected) {
    const dead = hudEl.cloneNode(true);
    dead.dataset.tone = "warn";
    const text = dead.querySelector(".xlf-hud-text");
    if (text) text.textContent = "Extension reloaded · refresh";
    dead.setAttribute("aria-label", "The extension was reloaded. Refresh the page to resume filtering.");
    dead.addEventListener("click", () => location.reload());
    hudEl.replaceWith(dead);
  }
  hudEl = null;
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
  const bar = Number(c.hideSeenAfter) || 0;
  let kept = 0;
  for (const r of pool) {
    // Repeats are not a bar, so rejudge() cannot see them. They are counted
    // here so the panel's arithmetic adds up when you move the repeat dial.
    const v = bar && r.id && (seen[r.id]?.[0] || 0) >= bar
      ? { keep: false, reason: "already read" }
      : rejudge(r, c);
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
  if (!tally.kept) {
    return { tone: "warn", text: `Nothing passed · ${tally.judged} hidden` };
  }
  let text = `${mode} · ${tally.kept} of ${tally.judged}`;
  if (tally.rescued) text += ` · ${tally.rescued} below bar`;
  // Worth its own words. A feed that suddenly shows less is alarming unless it
  // says why, and "you have read these already" is a different fact from
  // "these were under the bar".
  if (tally.reseen) text += ` · ${tally.reseen} read`;
  // Rare, and worth admitting when it happens: the page had nothing left on it
  // but posts you had read, so one went back rather than end the feed.
  if (tally.repeated) text += ` · ${tally.repeated} repeat back`;
  return { tone: "on", text };
}

function setHud() {
  if (torn) return;
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
    tally.repeated += s.repeated || 0;
    addRecords(s.records);
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
const REPEAT_STEPS = [
  [0, "never"], [1, "after 1 read"], [2, "after 2 reads"], [3, "after 3 reads"],
];
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
    hideSeenAfter: Number(controls.repeats.value),
  };
}

// The tuned keys, so "did anything change" is a real comparison rather than a
// guess from counts.
const TUNED = ["searchFeed", "minViews", "maxFollowers", "requireLaunch",
  "searchLatest", "searchVideoOnly", "minLikeRate", "minBookmarkRate", "minPerPage",
  "hideSeenAfter"];
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
  // The rotation advances on the way in, so cfg already points at the *next*
  // window. What belongs on screen is the question this page actually asked.
  const asked = isFeedSearch()
    ? (new URLSearchParams(location.search).get("q") || "").trim() : "";
  controls.query.textContent = c.searchFeed ? (asked || buildSearchQuery(c)) : "";
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
  const repeats = select(REPEAT_STEPS, cfg.hideSeenAfter);
  const forget = el("button", "xlf-link", `Forget ${seenSize()} read posts`);
  forget.type = "button";
  forget.addEventListener("click", () => {
    forgetSeen();
    forget.textContent = "Forgotten";
    forget.disabled = true;
    refreshForecast();
  });

  const more = document.createElement("details");
  more.className = "xlf-more";
  const sum = document.createElement("summary");
  sum.textContent = "More gates";
  more.append(sum, row("Retire a post", repeats), row("Like rate at least", likeRate),
    row("Bookmark rate at least", bookmarkRate), keepAliveRow, forget);

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
    video: video.input, likeRate, bookmarkRate, keepAlive, keepAliveRow, repeats,
    searchRows: [sortRow, video.wrap], caption, query, summary, bars, warn,
  };
  for (const k in segs) {
    segs[k].classList.toggle("on", k === controls.mode);
    segs[k].setAttribute("aria-checked", String(k === controls.mode));
  }
  [views, followers, sort, likeRate, bookmarkRate, keepAlive, repeats, launch.input,
    video.input].forEach((n) => n.addEventListener("change", refreshForecast));

  apply.addEventListener("click", () => {
    apply.disabled = true;
    apply.textContent = "Applying…";
    const c = candidate();
    chrome.storage.local.set({
      searchFeed: c.searchFeed, minViews: c.minViews, maxFollowers: c.maxFollowers,
      requireLaunch: c.requireLaunch, searchLatest: c.searchLatest,
      searchVideoOnly: c.searchVideoOnly, minLikeRate: c.minLikeRate,
      minBookmarkRate: c.minBookmarkRate, minPerPage: c.minPerPage,
      hideSeenAfter: c.hideSeenAfter,
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
timers.push(setInterval(saveSeen, 3000));

chrome.storage.local.get(null, (all) => {
  stored = all || {};
  delete stored.ledger;
  delete stored.seen;
  cfg = { ...LOCAL, ...stored };
  publishConfig();
  publishHidden();
  apply();
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === "forgetSeen") {
    forgetSeen();
    tally.reseen = 0;
    setHud();
    respond({ ok: true });
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const noise = ["ledger", "seen"];
  if (Object.keys(changes).every((k) => noise.includes(k))) return;
  for (const [k, { newValue }] of Object.entries(changes)) {
    if (noise.includes(k)) continue;
    // A removed key arrives as undefined. Falling back to the default keeps a
    // feature switched on rather than silently off, and keeps this side
    // agreeing with the interceptor, which always re-defaults.
    stored[k] = newValue;
    cfg[k] = newValue === undefined ? LOCAL[k] : newValue;
  }
  publishConfig();
  publishHidden();
  apply();
});

let lastHref = location.href;
timers.push(setInterval(() => {
  if (!alive()) return teardown();
  detectTheme();
  if (location.href !== lastHref) {
    lastHref = location.href;
    tally = { kept: 0, judged: 0, rescued: 0, reseen: 0, repeated: 0 };
    // A new surface is a new sitting. Seeing the same post on home and then in
    // search is being served it twice, and should count twice.
    countedThisLoad = new Set();
    closePanel();
    publishConfig();
    apply();
  }
  watchPosts();
}, 400));

// A pause can expire while the tab sits open.
timers.push(setInterval(apply, 2000));
const flush = (force) => { saveLedger(); saveSeen(force); };
// beforeunload alone is not enough: a reload from the keyboard fires it, but a
// backgrounded tab that Chrome later discards does not, and an impression
// counted seconds before a reload is exactly the one that matters.
window.addEventListener("beforeunload", () => flush(true));
window.addEventListener("pagehide", () => flush(true));
// Not forced. Hiding a tab is an alt-tab, not a departure, and forcing the
// durable write here would push a quarter of a megabyte into chrome.storage on
// every window switch — waking the service worker to do nothing. The
// localStorage copy, which is the one that matters for the next response, is
// written either way.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush(false);
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", apply, { once: true });
} else {
  apply();
}
