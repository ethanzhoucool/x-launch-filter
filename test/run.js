// node test/run.js
//
// Covers the seam between the two worlds. Every one of these fails against the
// version of this extension that shipped repeats.

const vm = require("vm");
const assert = require("assert");
const {
  makePage, loadPageWorld, loadIsolated, respond, fakeArticle, read,
} = require("./harness");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + e.message); }
}

/* ---------- fixtures ---------- */

const post = (id, over = {}) => ({
  __typename: "Tweet",
  rest_id: String(id),
  views: { count: String(over.views ?? 120000) },
  legacy: {
    full_text: over.text ?? "Introducing the thing we built",
    favorite_count: 900,
    bookmark_count: 40,
    extended_entities: { media: [{ type: "video" }] },
  },
});

const tweetEntry = (id, over) => ({
  entryId: `tweet-${id}`,
  content: { itemContent: { tweet_results: { result: post(id, over) } } },
});

// The same post as X delivers it inside a conversation module: a different
// entry id for identical content.
const moduleEntry = (id, moduleNo) => ({
  entryId: `home-conversation-${moduleNo}-1`,
  content: {
    items: [{ item: { itemContent: { tweet_results: { result: post(id) } } } }],
  },
});

const cursor = (value) => ({
  entryId: `cursor-bottom-${value}`,
  content: { cursorType: "Bottom", value },
});

const timeline = (entries) => ({
  data: { search_by_raw_query: { search_timeline: { timeline: {
    instructions: [{ type: "TimelineAddEntries", entries }],
  } } } },
});

const CFG = {
  enabled: true, unlockUntil: 0, searchFeed: true, minViews: 50000,
  feedQueryBase: "FEEDQ",
};
const idsIn = (payload) =>
  payload.data.search_by_raw_query.search_timeline.timeline.instructions[0].entries
    .map((e) => e.entryId);

/* ---------- the defaults, which is where this bug came from ---------- */

console.log("\ndefaults");

test("scoring, background and content agree on every shared key", () => {
  const s = vm.createContext({ self: {}, console });
  s.self = s;
  vm.runInContext(read("src/scoring.js"), s);
  const scoring = s.XLF.DEFAULTS;

  const b = vm.createContext({
    console,
    chrome: {
      runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} },
                 onMessage: { addListener() {} } },
      alarms: { onAlarm: { addListener() {} }, create() {}, clear() {} },
      storage: { onChanged: { addListener() {} },
                 local: { get: async () => ({}), set: async () => {} } },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    },
  });
  vm.runInContext(read("src/background.js"), b);
  const background = vm.runInContext("DEFAULTS", b);

  const page = makePage({ pathname: "/home" });
  const c = loadIsolated(page);
  const local = vm.runInContext("LOCAL", c);

  // content.js cannot import scoring.js — Chrome injects a file into one world
  // only — so its fallbacks are a hand copy. A key present in one and missing
  // in the other reads as undefined, which is falsy, which silently disables
  // whatever it gates. hideSeenAfter was exactly that for the whole life of the
  // feature.
  for (const k of Object.keys(local)) {
    assert.ok(k in scoring, `LOCAL.${k} is not in XLF.DEFAULTS`);
    assert.strictEqual(String(local[k]), String(scoring[k]),
      `LOCAL.${k} is ${local[k]}, XLF.DEFAULTS.${k} is ${scoring[k]}`);
  }
  for (const k of Object.keys(background)) {
    assert.ok(k in scoring, `background DEFAULTS.${k} is not in XLF.DEFAULTS`);
  }
  // Every key content.js reads off cfg has to have a fallback here.
  const src = read("src/content.js");
  const readKeys = new Set();
  for (const m of src.matchAll(/\bc(?:fg)?\.([a-zA-Z]+)/g)) readKeys.add(m[1]);
  for (const k of ["hideSeenAfter", "minViews", "requireLaunch", "searchRotate"]) {
    assert.ok(readKeys.has(k), `expected content.js to read ${k}`);
    assert.ok(k in local, `content.js reads cfg.${k} with no fallback in LOCAL`);
  }
});

/* ---------- suppression ---------- */

console.log("\nrepeats");

test("a read post is gone from the very first response of a page load", () => {
  // The ledger is already in localStorage from the previous session, and the
  // isolated world's async storage read has NOT resolved. This is a reload:
  // the case where the old build always served its repeats.
  const page = makePage({ localStorage: { "xlf.hidden": "111,222" } });
  page.documentElement.setAttribute("data-xlf", JSON.stringify(CFG));
  loadPageWorld(page);

  const out = respond(page, timeline([
    tweetEntry(111), tweetEntry(222), tweetEntry(333), cursor("C1"),
  ]));
  assert.deepStrictEqual(idsIn(out), ["tweet-333", "cursor-bottom-C1"]);
});

test("the same post is recognised under a different entry id", () => {
  const page = makePage({ localStorage: { "xlf.hidden": "444" } });
  page.documentElement.setAttribute("data-xlf", JSON.stringify(CFG));
  loadPageWorld(page);

  // Standalone once, then in a module with a fresh module id. Keying on the
  // entry id let this through; keying on the post id does not.
  const out = respond(page, timeline([
    moduleEntry(444, 9001), tweetEntry(555), cursor("C1"),
  ]));
  assert.deepStrictEqual(idsIn(out), ["tweet-555", "cursor-bottom-C1"]);
});

test("cursors survive a page where everything was a repeat", () => {
  const page = makePage({ localStorage: { "xlf.hidden": "111,222" } });
  page.documentElement.setAttribute("data-xlf",
    JSON.stringify({ ...CFG, minPerPage: 0 }));
  loadPageWorld(page);

  const out = idsIn(respond(page, timeline([
    tweetEntry(111), tweetEntry(222), cursor("C1"),
  ])));
  assert.ok(out.includes("cursor-bottom-C1"),
    "dropping a cursor ends pagination permanently");
  // Keep-alive is off here, and it still refuses to hand back a page with
  // nothing on it: an unscrollable page is never asked to grow again.
  assert.ok(out.length > 1, "an empty page ends the feed, whatever keep-alive says");
});

test("keep-alive off still thins a page rather than emptying it", () => {
  const page = makePage({ localStorage: { "xlf.hidden": "" } });
  page.documentElement.setAttribute("data-xlf",
    JSON.stringify({ ...CFG, minPerPage: 0 }));
  loadPageWorld(page);

  // One survivor is a thin page, which is what keep-alive off asks for: no
  // below-bar filler should appear alongside it.
  const out = idsIn(respond(page, timeline([
    tweetEntry(111), tweetEntry(999, { views: 10 }), cursor("C1"),
  ])));
  assert.deepStrictEqual(out, ["tweet-111", "cursor-bottom-C1"]);
});

test("a repeat is never used as below-bar filler while a reject exists", () => {
  const page = makePage({ localStorage: { "xlf.hidden": "111" } });
  page.documentElement.setAttribute("data-xlf",
    JSON.stringify({ ...CFG, minPerPage: 1 }));
  loadPageWorld(page);

  // 111 is a repeat; 999 is merely below the view bar. The filler must reach
  // for 999 — putting 111 back is the thing that was asked to stop.
  const out = respond(page, timeline([
    tweetEntry(111), tweetEntry(999, { views: 10 }), cursor("C1"),
  ]));
  assert.ok(idsIn(out).includes("tweet-999"));
  assert.ok(!idsIn(out).includes("tweet-111"));
});

test("an all-repeat page still hands X something to render", () => {
  const page = makePage({ localStorage: { "xlf.hidden": "111,222" } });
  page.documentElement.setAttribute("data-xlf",
    JSON.stringify({ ...CFG, minPerPage: 2 }));
  loadPageWorld(page);

  // Nothing but repeats and no cursor to fetch past: a page with no posts is
  // not scrollable, and X never asks for another. One repeat beats a feed that
  // has stopped.
  const out = respond(page, timeline([tweetEntry(111), tweetEntry(222)]));
  assert.ok(idsIn(out).length > 0, "an empty page ends the timeline for good");
});

test("a search you typed yourself is not filtered at all", () => {
  // Turning the search feed on used to filter every search, invisibly. Harmless
  // when the only effect was a high bar; not harmless once posts retire, because
  // looking up something you read yesterday would come back empty.
  const page = makePage({ search: "?q=" + encodeURIComponent("revyl") + "&f=top",
                          localStorage: { "xlf.hidden": "111" } });
  page.documentElement.setAttribute("data-xlf", JSON.stringify(CFG));
  loadPageWorld(page);

  const out = respond(page, timeline([tweetEntry(111), tweetEntry(999, { views: 10 })]));
  assert.deepStrictEqual(idsIn(out), ["tweet-111", "tweet-999"],
    "a manual search must come back exactly as X sent it");
});

/* ---------- what counts as seen ---------- */

console.log("\nimpressions");

function readingSession(page, ids) {
  vm.runInContext("countedThisLoad = new Set();", page.isolated);
  page.articles(ids.map((id) => fakeArticle(id)));
  page.pump();                       // the sweep that starts watching them
  page.onScreen(page.document.querySelectorAll("article"));
  page.tick();                       // the dwell completes
  page.pump();                       // the ledger is written
}

test("a post is counted when it reaches the viewport, not when it is delivered", () => {
  const page = makePage({ pathname: "/home" });
  loadIsolated(page);
  page.flushStorage();

  const arts = [fakeArticle("777")];
  page.articles(arts);
  page.pump();
  assert.strictEqual(page.store["xlf.hidden"] || "", "");

  // On screen, but scrolled away before the dwell elapsed: not read.
  page.onScreen(arts);
  page.offScreen(arts);
  page.tick();
  page.pump();
  const ledger = JSON.parse(page.store["xlf.seen"] || "{}");
  assert.ok(!ledger["777"], "a post scrolled past in an instant was not read");
});

test("twice read, then hidden — and not before", () => {
  const page = makePage({ pathname: "/home" });
  loadIsolated(page);
  page.flushStorage();

  readingSession(page, ["777", "888"]);
  assert.strictEqual(page.store["xlf.hidden"], "", "one sighting is not a repeat");
  assert.strictEqual(JSON.parse(page.store["xlf.seen"])["777"][0], 1);

  // Scrolling back to it in the same sitting is not seeing it twice.
  page.onScreen(page.document.querySelectorAll("article"));
  page.tick();
  page.pump();
  assert.strictEqual(JSON.parse(page.store["xlf.seen"])["777"][0], 1);

  readingSession(page, ["777", "888"]);
  const hidden = (page.store["xlf.hidden"] || "").split(",");
  assert.ok(hidden.includes("777") && hidden.includes("888"));
});

test("a post taller than the window still counts as read", () => {
  const page = makePage({ pathname: "/home" });
  loadIsolated(page);
  page.flushStorage();

  // A 2,000px demo video in an 800px window: ratio peaks at 0.4, so a
  // half-the-post test would never retire it, and this feed is made of them.
  for (let i = 0; i < 2; i++) {
    vm.runInContext("countedThisLoad = new Set();", page.isolated);
    page.articles([fakeArticle("3000")]);
    page.pump();
    page.onScreen(page.document.querySelectorAll("article"), { ratio: 0.4, visiblePx: 800 });
    page.tick();
    page.pump();
  }
  assert.ok((page.store["xlf.hidden"] || "").split(",").includes("3000"));
});

test("a sliver of a tall post is not a reading", () => {
  const page = makePage({ pathname: "/home" });
  loadIsolated(page);
  page.flushStorage();

  page.articles([fakeArticle("4000")]);
  page.pump();
  page.onScreen(page.document.querySelectorAll("article"), { ratio: 0.1, visiblePx: 200 });
  page.tick();
  page.pump();
  assert.ok(!JSON.parse(page.store["xlf.seen"] || "{}")["4000"]);
});

test("a quoted post is not retired by the post quoting it", () => {
  const page = makePage({ pathname: "/home" });
  loadIsolated(page);
  page.flushStorage();

  for (let i = 0; i < 2; i++) {
    vm.runInContext("countedThisLoad = new Set();", page.isolated);
    page.articles([fakeArticle("1000", { quoted: "2000" })]);
    page.pump();
    page.onScreen(page.document.querySelectorAll("article"));
    page.tick();
    page.pump();
  }
  const ledger = JSON.parse(page.store["xlf.seen"]);
  assert.ok(ledger["1000"], "the post itself was read");
  assert.ok(!ledger["2000"], "the post it quoted was not");
});

test("what the ledger writes is what the interceptor reads", () => {
  // The two halves, one page. This is the whole loop the user is asking for.
  const page = makePage({ pathname: "/home" });
  page.documentElement.setAttribute("data-xlf", JSON.stringify(CFG));
  loadIsolated(page);
  page.flushStorage();
  loadPageWorld(page);

  const url = "https://x.com/i/api/graphql/abc/HomeTimeline?variables=" +
    encodeURIComponent(JSON.stringify({ count: 20 }));
  const page1 = timeline([tweetEntry(777), tweetEntry(888), cursor("C1")]);
  assert.ok(idsIn(respond(page, page1, url)).includes("tweet-777"),
    "an unread post is served");

  readingSession(page, ["777"]);
  readingSession(page, ["777"]);

  // 888 keeps the page alive, so the last-resort repeat filler stays out of it.
  const page2 = idsIn(respond(page, timeline([
    tweetEntry(777), tweetEntry(888), cursor("C1"),
  ]), url));
  assert.ok(!page2.includes("tweet-777"), "after two readings it is gone");
  assert.ok(page2.includes("tweet-888"), "and the post you have not read stays");
});

test("a feed tab still recognises itself after the date rolls over", () => {
  // The window is rebuilt from the clock. A tab opened yesterday, or restored
  // by Chrome, carries yesterday's dates in its URL — and used to stop being
  // the feed at UTC midnight, which silently unfiltered it for good.
  const page = makePage({
    search: "?q=" + encodeURIComponent("FEEDQ since:1999-01-01 until:1999-01-04") + "&f=top",
    localStorage: { "xlf.hidden": "111" },
  });
  page.documentElement.setAttribute("data-xlf", JSON.stringify(CFG));
  loadPageWorld(page);

  const out = idsIn(respond(page, timeline([tweetEntry(111), tweetEntry(222), cursor("C1")])));
  assert.ok(!out.includes("tweet-111"), "an old window must still count as the feed");
  assert.ok(out.includes("tweet-222"));
});

test("a thread whose first item is a tombstone still retires", () => {
  const page = makePage({ localStorage: { "xlf.hidden": "777" } });
  page.documentElement.setAttribute("data-xlf", JSON.stringify(CFG));
  loadPageWorld(page);

  const withTombstone = {
    entryId: "home-conversation-1-2",
    content: { items: [
      { item: { itemContent: { tweet_results: { result: { __typename: "TweetTombstone" } } } } },
      { item: { itemContent: { tweet_results: { result: post(777) } } } },
    ] },
  };
  const out = idsIn(respond(page, timeline([withTombstone, tweetEntry(222), cursor("C1")])));
  assert.ok(!out.includes("home-conversation-1-2"),
    "an unreadable first item must not consume the root check");
});

/* ---------- forgetting ---------- */

console.log("\nforgetting");

test("forgetting in one tab is not undone by another", () => {
  const tabA = makePage({ pathname: "/home" });
  const a = loadIsolated(tabA);
  tabA.flushStorage();
  readingSession(tabA, ["555"]);
  readingSession(tabA, ["555"]);
  assert.ok((tabA.store["xlf.hidden"] || "").includes("555"));

  // A genuinely separate tab on the same origin: its own context and its own
  // in-memory copy of the ledger, sharing the one localStorage that Chrome
  // gives both of them.
  const tabB = makePage({ pathname: "/home", sharedStore: tabA.store });
  const b = loadIsolated(tabB);
  tabB.flushStorage();
  assert.ok(vm.runInContext("seenSize()", b) > 0, "tab B loaded the ledger");

  vm.runInContext("forgetSeen()", a);
  assert.strictEqual(tabA.store["xlf.seen"], "{}");

  // Tab B now saves what it is still holding. Without the stamp it merges its
  // whole copy back over the emptied file and the forget lasts three seconds.
  vm.runInContext("seenDirty = true; saveSeen(true);", b);
  assert.strictEqual(tabA.store["xlf.seen"], "{}", "the forget was undone by the other tab");
  assert.strictEqual(tabA.store["xlf.hidden"], "");
  assert.strictEqual(vm.runInContext("seenSize()", b), 0, "tab B kept a stale ledger");
});

test("a clear from the settings page reaches a tab that was not open", () => {
  const page = makePage({
    pathname: "/home",
    localStorage: { "xlf.seen": JSON.stringify({ "999": [3, 20000] }), "xlf.hidden": "999" },
    storage: { seen: {}, seenClearedAt: Date.now() },
  });
  loadIsolated(page);
  page.flushStorage();
  assert.strictEqual(page.store["xlf.seen"], "{}", "the stamp must win over the local copy");
  assert.strictEqual(page.store["xlf.hidden"], "");
});

/* ---------- variety ---------- */

console.log("\nrotation");

test("each visit asks a different question", () => {
  const page = makePage({ pathname: "/home" });
  const c = loadIsolated(page);
  page.flushStorage();

  const queries = new Set();
  for (let i = 0; i < 5; i++) {
    queries.add(vm.runInContext(
      `buildSearchQuery({ ...LOCAL, searchFeed: true, searchRotation: ${i} })`, c));
  }
  assert.strictEqual(queries.size, 5, "the rotation repeats itself");
  for (const q of queries) assert.ok(q.includes("-filter:replies"));
});

test("every rotation is still recognised as the feed", () => {
  const page = makePage({ pathname: "/home" });
  const c = loadIsolated(page);
  page.flushStorage();

  for (let i = 0; i < 5; i++) {
    const q = vm.runInContext(
      `buildSearchQuery({ ...LOCAL, searchFeed: true, searchRotation: ${i} })`, c);
    page.location.pathname = "/search";
    page.location.search = "?q=" + encodeURIComponent(q) + "&f=top";
    vm.runInContext("cfg.searchFeed = true; cfg.searchRotate = true;", c);
    assert.ok(vm.runInContext("isFeedSearch()", c),
      `rotation ${i} was not recognised, so the pill would vanish`);
  }
  page.location.search = "?q=" + encodeURIComponent("cats") + "&f=top";
  assert.ok(!vm.runInContext("isFeedSearch()", c), "a manual search is not the feed");
});

test("a hand-written query is left exactly alone", () => {
  const page = makePage({ pathname: "/home" });
  const c = loadIsolated(page);
  page.flushStorage();
  const q = vm.runInContext(
    `buildSearchQuery({ ...LOCAL, searchQuery: "  my own query  ", searchRotation: 3 })`, c);
  assert.strictEqual(q, "my own query");
});

/* ---------- the pause lease ---------- */

// The service worker against a chrome.* that keeps alarms, storage and the
// badge where a test can read them. Listeners are captured so a test can play
// the browser: fire onInstalled after a reload, onStartup after a restart.
function backgroundWorld(storage) {
  const alarms = new Map();
  const on = {};
  const listen = (name) => ({ addListener: (fn) => { on[name] = fn; } });
  const badge = { text: null };
  const chrome = {
    runtime: { onInstalled: listen("installed"), onStartup: listen("startup"),
               onMessage: listen("message"), openOptionsPage() {} },
    alarms: {
      onAlarm: listen("alarm"),
      create: (name, info) => { alarms.set(name, { name, ...info }); },
      clear: async (name) => alarms.delete(name),
      get: async (name) => alarms.get(name),
    },
    storage: {
      onChanged: listen("changed"),
      local: {
        get: async (keys) => Object.fromEntries(Object.keys(keys).map((k) =>
          [k, k in storage ? storage[k] : keys[k]])),
        set: async (obj) => { Object.assign(storage, obj); },
      },
    },
    action: { setBadgeText: ({ text }) => { badge.text = text; }, setBadgeBackgroundColor() {} },
  };
  const ctx = vm.createContext({ console, chrome, Date, Math, Object, String });
  vm.runInContext(read("src/background.js"), ctx, { filename: "background.js" });
  return { alarms, on, badge, storage };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

async function asyncTest(name, fn) {
  try { await fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + e.message); }
}

// The worker is all promises, so this section runs last and the summary waits
// for it.
(async () => {
  console.log("\npause");

  await asyncTest("a pause survives the extension being reloaded under it", async () => {
    // Reloading or updating the extension wipes its alarms; storage keeps the
    // lease. Without re-arming, nothing would ever relock or tick the badge.
    const until = Date.now() + 10 * 60000;
    const bg = backgroundWorld({ unlockUntil: until });
    await bg.on.installed({ reason: "update" });
    await settle();
    assert.strictEqual(bg.alarms.get("xlf-relock")?.when, until, "no relock alarm");
    assert.ok(bg.alarms.has("xlf-tick"), "no badge tick");
    assert.strictEqual(bg.badge.text, "10");
  });

  await asyncTest("a pause that ended while Chrome was closed is closed on startup", async () => {
    const bg = backgroundWorld({ unlockUntil: Date.now() - 60000 });
    await bg.on.startup();
    await settle();
    assert.strictEqual(bg.storage.unlockUntil, 0, "the stale lease was left in place");
    assert.strictEqual(bg.badge.text, "", "the badge still claims a pause");
    assert.strictEqual(bg.alarms.size, 0);
  });

  await asyncTest("a tick after the lease ran out stops ticking", async () => {
    const bg = backgroundWorld({ unlockUntil: Date.now() - 1000 });
    bg.alarms.set("xlf-tick", { name: "xlf-tick", periodInMinutes: 1 });
    await bg.on.alarm({ name: "xlf-tick" });
    await settle();
    assert.ok(!bg.alarms.has("xlf-tick"), "a tick that outlived its pause runs forever");
    assert.strictEqual(bg.badge.text, "");
  });

  await asyncTest("pausing and resuming update the badge without a storage listener", async () => {
    // Nothing in the worker listens to storage, so that a tab saving its
    // ledger does not start it. Each path that changes the lease has to
    // refresh the badge on its own.
    const bg = backgroundWorld({});
    assert.strictEqual(bg.on.changed, undefined,
      "a storage listener wakes the worker on every ledger write from every tab");
    await new Promise((done) => bg.on.message({ type: "unlock", minutes: 15 }, {}, done));
    await settle();
    assert.strictEqual(bg.badge.text, "15");
    await new Promise((done) => bg.on.message({ type: "relock" }, {}, done));
    await settle();
    assert.strictEqual(bg.badge.text, "");
    await new Promise((done) => bg.on.message({ type: "unlock", minutes: 15 }, {}, done));
    await bg.on.alarm({ name: "xlf-relock" });
    await settle();
    assert.strictEqual(bg.badge.text, "", "the lease ran out and the badge did not notice");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
