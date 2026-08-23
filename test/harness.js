// A fake x.com, just real enough to run both halves of the extension against
// each other. The point is the boundary between them: the interceptor runs in
// the page's world and the ledger runs in the isolated one, they share only the
// DOM and localStorage, and every bug this file exists to catch lived in that
// gap. So the two are loaded into separate vm contexts that share one document
// and one localStorage, exactly as Chrome arranges them.

const vm = require("vm");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function fakeNode(tag = "div") {
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    attrs: {},
    textContent: "",
    hidden: false,
    isConnected: true,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    replaceChildren(...c) { this.children = c; },
    remove() { this.isConnected = false; },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    // The pill builds itself and then reaches back into what it built, so a
    // node has to answer with a node rather than null.
    querySelector() { return fakeNode(); },
    querySelectorAll() { return []; },
    closest() { return null; },
  };
  return node;
}

// A rendered post, as the impression observer sees it. Measured off a live
// timeline on 2026-08-22, because the first version of this fixture was guessed
// and the guess was wrong in the one way that mattered: **X sets role="link" on
// the permalink anchor itself**, so `a.closest('[role="link"]')` matches the
// anchor rather than telling you anything about a quote. The fixture said
// otherwise, so it happily passed an implementation that resolved no post at
// all on the real site. Only the parent chain distinguishes a quote.
function fakeArticle(id, opts = {}) {
  const anchor = (postId, inQuote) => {
    const a = {
      getAttribute: () => `/someone/status/${postId}`,
      querySelector: (s) => (s === "time" ? {} : null),
      parentElement: { closest: (s) => (s === '[role="link"]' && inQuote ? {} : null) },
    };
    a.closest = (s) => (s === '[role="link"]' ? a : null);
    return a;
  };
  const anchors = [];
  if (opts.quoted) anchors.push(anchor(opts.quoted, true));
  anchors.push(anchor(id, false));
  // The analytics link is a /status/ link with no timestamp, and is how the
  // real DOM most often tempts a wrong answer.
  anchors.push({
    getAttribute: () => `/someone/status/${id}/analytics`,
    querySelector: () => null,
    closest: () => null,
    parentElement: { closest: () => null },
  });
  const art = fakeNode("article");
  art.attrs["data-testid"] = "tweet";
  art.tweetId = id;
  art.querySelectorAll = (sel) => (sel.includes("/status/") ? anchors : []);
  return art;
}

function makePage(opts = {}) {
  const store = opts.sharedStore || Object.assign({}, opts.localStorage);
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };

  const documentElement = fakeNode("html");
  const body = fakeNode("body");
  let articles = [];

  const docListeners = {};
  const document = {
    documentElement,
    body,
    readyState: "complete",
    createElement: (t) => fakeNode(t),
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatchEvent(e) {
      for (const fn of docListeners[e.type] || []) fn(e);
      return true;
    },
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.includes("article") ? articles : []),
  };

  const location = {
    origin: "https://x.com",
    pathname: opts.pathname || "/search",
    // The page world only filters a search whose query is one the feed
    // generated, so the default here has to be one of those.
    search: opts.search === undefined ? "?q=FEEDQ&f=top" : opts.search,
    href: "https://x.com" + (opts.pathname || "/search") + (opts.search || ""),
    replace(url) { this.replaced = url; },
    reload() { this.reloaded = true; },
  };

  // Storage callbacks are deferred on purpose: the original bug was that the
  // first timeline response is filtered before any of them have run, and a test
  // that resolves them eagerly cannot see it.
  const pending = [];
  const storage = Object.assign({}, opts.storage);
  const chrome = {
    runtime: { id: "test", sendMessage() {}, onMessage: { addListener() {} } },
    storage: {
      local: {
        get(keys, cb) {
          const out = keys === null ? { ...storage }
            : Object.fromEntries(Object.keys(keys).map((k) =>
                [k, k in storage ? storage[k] : keys[k]]));
          pending.push(() => cb(out));
        },
        set(obj, cb) {
          Object.assign(storage, obj);
          if (cb) pending.push(cb);
        },
      },
      onChanged: { addListener() {} },
    },
  };

  const timers = [];
  const intervals = [];
  const observers = [];
  const shared = {
    localStorage, document, location, chrome, console,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    getComputedStyle: () => ({ backgroundColor: "rgb(0, 0, 0)" }),
    addEventListener() {},
    removeEventListener() {},
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    IntersectionObserver: class {
      constructor(cb) { this.cb = cb; this.seen = []; observers.push(this); }
      observe(el) { this.seen.push(el); }
      disconnect() { this.seen = []; }
    },
    URL, URLSearchParams, JSON, Math, Date, Object, Array, String, Number,
    Boolean, RegExp, Set, Map, WeakSet, WeakMap, Error, Promise,
  };

  // Two worlds, one page. Nothing but `document` and `localStorage` crosses.
  const main = vm.createContext({ ...shared });
  main.self = main;
  main.window = main;
  delete main.chrome;                      // the page world has no chrome.*
  const isolated = vm.createContext({ ...shared });
  isolated.self = isolated;
  isolated.window = isolated;

  const page = {
    store, storage, documentElement, document, location, chrome, main, isolated,
    articles: (list) => { articles = list; },
    flushStorage() { while (pending.length) pending.shift()(); },
    // One turn of every interval the extension registered. The sweep that finds
    // new posts to watch lives on one of them, so tests that skip this are
    // testing nothing.
    pump() { for (const i of intervals) i.fn(); },
    // Runs every pending dwell timer, which is what "the user kept it on
    // screen" means to the observer.
    tick() {
      const due = timers.splice(0, timers.length);
      for (const t of due) if (!t.cancelled) t.fn();
    },
    // ratio/rect model how much of the post is showing. The default is a post
    // that fits on screen; pass a low ratio with a tall intersection to model
    // one that does not.
    onScreen(list, opts = {}) {
      const ratio = opts.ratio ?? 1;
      const rect = { height: opts.visiblePx ?? 800 };
      for (const o of observers) {
        const entries = list
          .filter((el) => o.seen.includes(el))
          .map((el) => ({
            target: el, isIntersecting: true, intersectionRatio: ratio,
            intersectionRect: rect, rootBounds: { height: 800 },
          }));
        if (entries.length) o.cb(entries);
      }
    },
    offScreen(list) {
      for (const o of observers) {
        const entries = list
          .filter((el) => o.seen.includes(el))
          .map((el) => ({
            target: el, isIntersecting: false, intersectionRatio: 0,
            intersectionRect: { height: 0 }, rootBounds: { height: 800 },
          }));
        if (entries.length) o.cb(entries);
      }
    },
  };

  return page;
}

// The page world: scoring.js then intercept.js, with an XHR stub whose
// prototype carries the same accessors the real one does, since patching those
// getters is the entire mechanism.
function loadPageWorld(page, opts = {}) {
  const ctx = page.main;
  ctx.XMLHttpRequest = class {
    open(method, url) { this.method = method; this.url_ = url; }
    setRequestHeader() {}
    send() {}
  };
  Object.defineProperty(ctx.XMLHttpRequest.prototype, "responseText", {
    configurable: true,
    get() { return this.__body; },
  });
  Object.defineProperty(ctx.XMLHttpRequest.prototype, "response", {
    configurable: true,
    get() { return this.__body; },
  });
  ctx.fetch = undefined;
  if (opts.syncFetch) ctx.__testFetch = opts.syncFetch;
  vm.runInContext(read("src/scoring.js"), ctx, { filename: "scoring.js" });
  vm.runInContext(read("src/intercept.js"), ctx, { filename: "intercept.js" });
  return ctx;
}

function loadIsolated(page) {
  const ctx = page.isolated;
  vm.runInContext(read("src/content.js"), ctx, { filename: "content.js" });
  return ctx;
}

// Drives one timeline response through the patched getter, the way X does.
function respond(page, payload, url) {
  const ctx = page.main;
  const xhr = new ctx.XMLHttpRequest();
  xhr.open("GET", url || "https://x.com/i/api/graphql/abc/SearchTimeline?variables=" +
    encodeURIComponent(JSON.stringify({ rawQuery: "x", count: 20 })));
  xhr.readyState = 4;
  xhr.status = 200;
  xhr.__body = JSON.stringify(payload);
  return JSON.parse(xhr.responseText);
}

module.exports = { makePage, loadPageWorld, loadIsolated, respond, fakeArticle, read, ROOT };
