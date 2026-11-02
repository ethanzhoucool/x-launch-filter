// Runs in the page's own world at document_start, before X's bundle loads, and
// filters timeline posts out of the API response before X ever renders them.
//
// Why here and not in the DOM: X's timeline is virtualised, and every post's
// position is a coordinate cached at mount. Hiding a rendered post does not
// reflow the list, so it leaves a permanent hole, and the reserved scroll space
// never shrinks. Deleting the post from the response sidesteps all of that.
//
// This file does ONE thing: filter what X asked for. It does not fetch, it does
// not rewrite cursors, it does not reorder. That restraint is deliberate and was
// learned expensively — an earlier version read ahead over the cursor and banked
// posts for later, and every part of that machinery broke pagination:
//
//   * the read-ahead replayed the home cursor against whatever endpoint X had
//     opened last, so it failed silently on essentially every request;
//   * with it failing, the read position never advanced, so every response had
//     its Bottom cursor rewritten to the same stale value and X refetched the
//     page it already had;
//   * the dedupe then stripped that page as "already delivered", so X received
//     an empty page and concluded the timeline had ended.
//
// Infinite scroll is worth more than a full page. X owns pagination; we only
// decide what survives.
//
// Verified against live traffic: transport is XHR, the request is a GET,
// entries live at data.home.home_timeline_urt.instructions[<n>].entries, and the
// walk finds them structurally rather than by that path.
//
// Every failure path returns the untouched response. An unfiltered feed is a
// bad day; a broken timeline is a bug report.

(() => {
  const OPS = {
    HomeTimeline: "home",
    HomeLatestTimeline: "home",
    SearchTimeline: "search",
    UserTweets: "profile",
    UserTweetsAndReplies: "profile",
  };

  const opOf = (url) => {
    if (!url || url.indexOf("/graphql/") === -1) return null;
    const m = /\/graphql\/[^/]+\/([A-Za-z]+)/.exec(url);
    return m && OPS[m[1]] ? m[1] : null;
  };

  let debugOn = false;
  const log = (...args) => {
    if (debugOn) console.debug("%c[xlf]", "color:#1d9bf0", ...args);
  };

  function config() {
    let stored = null;
    try {
      const raw = document.documentElement.getAttribute("data-xlf");
      if (raw) stored = JSON.parse(raw);
    } catch {
      stored = null;
    }

    const cfg = self.XLF.buildConfig(stored || {});
    debugOn = !!cfg.debug;

    // No bridge means no settings, and critically no way for the popup to turn
    // this off — the off switch travels through that same attribute. Absence is
    // treated as off: worst case is an unfiltered timeline and a working
    // browser, rather than a modified one with no escape.
    if (!stored) {
      cfg.filterOn = false;
      log("no config bridge yet — passing this response through untouched");
      return cfg;
    }
    cfg.filterOn = cfg.enabled !== false && Date.now() >= (cfg.unlockUntil || 0);
    cfg.hidden = cfg.hideSeenAfter > 0 ? hiddenIds() : null;
    return cfg;
  }

  // Only the queries the isolated world generates for the feed, since the query
  // is built over there. Without this, turning the search feed on quietly
  // filtered every search you typed as well — and the pill did not appear to
  // say so, because it uses a stricter test. That was survivable while the only
  // consequence was a high bar. It is not now: a post retires once you have
  // read it, so searching for something you read yesterday would come back
  // empty and look like X had lost it.
  // Compared with the date window stripped off both sides. The window is
  // rebuilt from the clock, so comparing whole queries meant that at UTC
  // midnight a tab sitting on the feed stopped recognising itself and quietly
  // served everything unfiltered for the rest of its life.
  const stripWindow = (q) =>
    String(q || "").replace(/\s*\b(?:since|until)(?:_time)?:\S+/gi, "").replace(/\s+/g, " ").trim();

  function onFeedQuery(cfg) {
    if (!cfg.feedQueryBase) return false;
    try {
      const q = (new URLSearchParams(location.search).get("q") || "").trim();
      return !!q && stripWindow(q) === cfg.feedQueryBase;
    } catch {
      return false;
    }
  }

  const appliesTo = (opName, cfg) => {
    const surface = OPS[opName];
    if (surface === "home") return true;
    if (surface === "search") return !!cfg.filterSearch || (!!cfg.searchFeed && onFeedQuery(cfg));
    if (surface === "profile") return !!cfg.filterProfiles;
    return false;
  };

  /* ---------- entries ---------- */

  const isCursor = (e) => (e?.entryId || "").startsWith("cursor-");

  function findEntries(root) {
    let found = null;
    const seen = new Set();
    (function walk(node) {
      if (found || !node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        if (node.length && node[0] && typeof node[0] === "object" && "entryId" in node[0]) {
          found = node;
          return;
        }
        for (const v of node) walk(v);
        return;
      }
      for (const k in node) walk(node[k]);
    })(root);
    return found;
  }

  const bottomCursor = (entries) =>
    entries.find((e) => isCursor(e) && e.content?.cursorType === "Bottom");

  function entryVerdict(entry, cfg) {
    if (isCursor(entry)) return { keep: true, judged: 0 };
    const content = entry?.content || {};

    const single = content.itemContent?.tweet_results?.result;
    if (single) {
      const promoted = !!content.itemContent?.promotedMetadata;
      const post = self.XLF.fromApi(single, { promoted });
      // Before the bars, and before the record: a post you have already read is
      // not worth the slot whatever else it scores, and it must not come back
      // as filler either.
      if (alreadySeen(post, cfg)) {
        return { keep: false, judged: 1, reason: "seen", seen: true, views: post.views || 0 };
      }
      const v = self.XLF.judge(post, cfg);
      return {
        keep: v.keep, judged: 1, reason: v.reason, views: v.stats?.views || 0,
        record: self.XLF.record(post, cfg),
      };
    }

    // A conversation module is a post plus its replies. Keep the thread if any
    // post in it qualifies, rather than judging one item and taking the rest
    // along blind — X uses these for "A replied to B", where the first item can
    // belong to someone you do not follow.
    if (Array.isArray(content.items)) {
      let judged = 0;
      let best = 0;
      let rec = null;
      let root = true;
      for (const it of content.items) {
        const r = it?.item?.itemContent?.tweet_results?.result;
        if (!r) continue;
        judged = 1;
        const promoted = !!it.item.itemContent.promotedMetadata;
        const post = self.XLF.fromApi(r, { promoted });
        // A withheld or tombstoned item parses to nothing and tells us nothing.
        // Skipping it before the root check matters: otherwise it consumes the
        // check, and a thread whose first item is a tombstone can never retire.
        if (!post) continue;
        // A thread is kept or dropped whole, so it is also retired whole, on
        // the root post — the one you actually read.
        if (root && alreadySeen(post, cfg)) {
          return { keep: false, judged: 1, reason: "seen", seen: true, views: post.views || 0 };
        }
        root = false;
        const v = self.XLF.judge(post, cfg);
        best = Math.max(best, v.stats?.views || 0);
        if (!rec) rec = self.XLF.record(post, cfg);
        if (v.keep) {
          return { keep: true, judged: 1, reason: "thread", views: best, record: rec };
        }
      }
      if (judged) return { keep: false, judged: 1, reason: "thread", views: best, record: rec };
    }

    // Prompts, who-to-follow carousels: not posts, leave them alone.
    return { keep: true, judged: 0 };
  }

  /* ---------- posts already seen ---------- */

  // The isolated world watches which posts actually reach the viewport and
  // writes the ids that have had their turn here. localStorage rather than a
  // DOM attribute because that side reads its ledger out of chrome.storage,
  // which is async, while this side reads inside a synchronous getter — the
  // first response of a page load always won that race, so a reload always
  // served its repeats. localStorage is shared with this world and readable
  // synchronously, so the list is in place before the first response lands.
  //
  // Re-parsed only when the string changes: it runs to thousands of ids and is
  // read on every response.
  let seenRaw = null;
  let seenSet = new Set();
  function hiddenIds() {
    let raw = "";
    try { raw = localStorage.getItem("xlf.hidden") || ""; } catch { raw = ""; }
    if (raw !== seenRaw) {
      seenRaw = raw;
      seenSet = new Set(raw ? raw.split(",") : []);
    }
    return seenSet;
  }

  // Keyed on the post's own id. Entry ids looked like an easy handle and are
  // not one: a conversation module mints a fresh one per response, and the same
  // post carries different ones on home and in search.
  const alreadySeen = (post, cfg) =>
    !!(cfg.hidden && post && post.id && cfg.hidden.has(post.id));

  /* ---------- breaking the deadlock ---------- */

  // X's loader fires on a *transition* into the trigger zone, not on being in
  // it. Unfiltered, a fetch adds 20 posts and shoves the sentinel far below the
  // fold, so the next scroll re-enters the zone and fires again. Filter a page
  // down to nothing and the sentinel never moves: no transition, no next fetch,
  // and if nothing survives at all the page is not even scrollable, so the user
  // cannot break the deadlock either. Measured: docH equal to the viewport
  // height, zero posts, no way out.
  //
  // Triggering X's loader from script is not possible. Measured across eight
  // approaches — scrollTo to the true bottom, scrollBy, a full excursion up and
  // back, scrollTo(0) then bottom, smooth scroll, synthetic WheelEvent,
  // synthetic scroll events, and translating the sentinel out of the viewport
  // and back — every one produced zero requests, while a single real wheel
  // gesture fired immediately. X wants trusted input and script cannot forge it.
  //
  // So do not trigger the loader. Remove the need for it: when a page is
  // starved, fetch the next page ourselves and hand X a response worth
  // rendering. The response getter is synchronous, so this fetch has to be too.
  // That blocks the main thread, which is why it runs ONLY on a starved page —
  // the case that would otherwise dead-end the feed permanently.
  // A page that keeps nothing is not merely thin, it is dead: there is nothing
  // to render, so the document is no taller than the viewport, so there is no
  // scroll gesture available and X will never be asked again. That once made
  // the empty case unconditional; it is opt-in now, with the thin case, for
  // the reason given in filterPayload(): X rejects the replayed request.
  const TOPUP_PAGES_EMPTY = 3;
  const TOPUP_PAGES_THIN = 2;

  // These fetches are synchronous, so each failure costs a blocked main thread
  // for a whole round trip. One is a diagnosis; three per page is a frozen tab.
  let topUpOff = false;

  function syncFetch(url, headers) {
    const x = new XMLHttpRequest();
    x.open("GET", url, false); // synchronous: the getter cannot await
    for (const k in headers) {
      try { x.setRequestHeader(k, headers[k]); } catch { /* forbidden header */ }
    }
    x.send(null);
    if (x.status !== 200) throw new Error("top-up " + x.status);
    return JSON.parse(x.responseText);
  }

  function urlWithCursor(url, cursor) {
    const u = new URL(url, location.origin);
    const vars = JSON.parse(u.searchParams.get("variables") || "{}");
    vars.cursor = cursor;
    u.searchParams.set("variables", JSON.stringify(vars));
    return u.toString();
  }

  // Pulls further pages until the page is worth rendering. Returns the keepers
  // and the cursor we actually consumed up to, so X carries on from the right
  // place rather than refetching ground we already mined.
  function topUp(req, cursor, cfg, want, maxPages) {
    const gained = [];
    let at = cursor;
    let judged = 0;
    let dropped = 0;
    for (let round = 0; round < maxPages && gained.length < want && at; round++) {
      const page = findEntries(
        syncFetch(inflatePage(urlWithCursor(req.__xlfUrl, at), cfg), req.__xlfHeaders)
      );
      if (!page || !page.length) break;
      for (const entry of page) {
        if (isCursor(entry)) continue;
        const v = entryVerdict(entry, cfg);
        judged += v.judged;
        if (v.keep) gained.push(entry);
        else if (v.judged) dropped++;
      }
      const next = bottomCursor(page)?.content?.value;
      if (!next || next === at) break;
      at = next;
    }
    return { gained, cursor: at, judged, dropped };
  }

  /* ---------- filtering a payload ---------- */

  function filterPayload(root, opName, req) {
    const cfg = config();
    if (!cfg.filterOn || !appliesTo(opName, cfg)) return null;

    const entries = findEntries(root);
    if (!entries) {
      log(opName, "no entries array found — passing through");
      return null;
    }

    const before = entries.length;
    let judged = 0;
    let dropped = 0;
    let reseen = 0;
    const cut = [];
    // Repeats are held separately. They are not filler — putting one back is the
    // thing the user asked to stop — but a page whose every post was a repeat
    // has nothing else to give X, and a page with nothing on it cannot be
    // scrolled, which ends the feed for good. One repeat beats a dead timeline.
    const repeats = [];
    // Every judgement is kept, not just the counts. The panel re-scores these
    // against candidate settings so tuning does not need a reload to be legible.
    const records = [];

    for (let i = entries.length - 1; i >= 0; i--) {
      const v = entryVerdict(entries[i], cfg);
      judged += v.judged;
      if (v.record) records.push(v.record);
      if (v.keep) continue;
      dropped++;
      // The filler puts the strongest rejects back to keep a starved page
      // scrollable. A repeat is never one of them: putting it back is exactly
      // the thing that was asked not to happen.
      if (v.seen) {
        reseen++;
        repeats.push({ entry: entries[i], views: v.views || 0 });
      } else {
        cut.push({ entry: entries[i], views: v.views || 0 });
      }
      entries.splice(i, 1);
    }

    if (!judged) {
      log(opName, "nothing judged (", before, "entries ) — passing through");
      return null;
    }

    // A starved page is the deadlock case, and the only one worth blocking for.
    let toppedUp = 0;
    const bottom = bottomCursor(entries);
    const survivorsBefore = judged - dropped;
    const empty = judged > 0 && survivorsBefore === 0;
    const thin = survivorsBefore < 2;
    // req is the XHR itself, and an XHR has no `url` or `headers` — it carries
    // the ones stashed in open(). Reading the DOM-standard names here meant this
    // whole rescue was unreachable from the day it was written, which went
    // unnoticed because every failure path in this file is silent. It matters
    // more now: dropping repeats empties pages that used to merely thin out.
    // Opt-in for both cases now, where the empty one used to be unconditional.
    // The reasoning that made it unconditional — blocking briefly beats a feed
    // that has stopped — assumed the fetch could work. Measured 2026-08-21 it
    // cannot: X requires a single-use x-client-transaction-id, so a replay is a
    // 404. What is left is a synchronous XHR on the main thread that buys
    // nothing, and a synchronous XHR cannot be given a timeout, so a hung
    // request is a hung tab. The filler below keeps the page alive instead,
    // without touching the network.
    if (
      !topUpOff && cfg.topUp === true && (empty || thin) && judged &&
      req?.__xlfUrl && req?.__xlfHeaders && bottom?.content?.value
    ) {
      try {
        const r = topUp(req, bottom.content.value, cfg, 4,
          empty ? TOPUP_PAGES_EMPTY : TOPUP_PAGES_THIN);
        if (r.gained.length) {
          const at = entries.indexOf(bottom);
          entries.splice(at < 0 ? entries.length : at, 0, ...r.gained);
          toppedUp = r.gained.length;
          judged += r.judged;
          dropped += r.dropped;
        }
        // Only ever advance to a cursor whose page we actually consumed.
        if (r.cursor && r.cursor !== bottom.content.value) bottom.content.value = r.cursor;
      } catch (e) {
        topUpOff = true;
        log("top-up failed, not trying again this session:", e);
      }
    }

    // Last resort. A page filtered to nothing gives X nothing to render and
    // nothing to scroll, and it stops asking for more. Rather than let the feed
    // end, put the strongest rejects back. Every post this returns is below the
    // bar, which is why the counter names them separately.
    let rescued = 0;
    let repeated = 0;
    let survivors = judged - dropped;
    // Keep-alive off means "accept the occasional thin page". It cannot mean
    // accept an empty one: a page with no posts is shorter than the viewport,
    // so there is no scroll gesture to make, X is never asked for more, and the
    // feed is over until you reload by hand. That is not a preference anyone
    // expressed. One post is the difference between a thin feed and no feed.
    const floor = survivors === 0
      ? Math.max(1, cfg.minPerPage ?? 2)
      : Math.max(0, cfg.minPerPage ?? 2);
    // Below-bar rejects first. Repeats are reached for only when there are no
    // rejects AND the page would otherwise render nothing at all — every post
    // on it was one you had already read. A thin page still scrolls, and a
    // repeat put back into one is just the bug again.
    let pool = cut;
    if (!pool.length && survivors === 0) pool = repeats;
    if (survivors < floor && pool.length) {
      // Insert ahead of the Bottom cursor: the indices recorded during removal
      // are stale the moment anything else is spliced.
      const at = bottom ? entries.indexOf(bottom) : entries.length;
      const picks = pool
        .filter((c) => c.views > 0)
        .sort((a, b) => b.views - a.views)
        .slice(0, floor - survivors);
      for (const p of picks) {
        entries.splice(at < 0 ? entries.length : at, 0, p.entry);
        rescued++;
      }
      if (pool === repeats) { repeated = rescued; reseen -= rescued; }
    }

    log(
      opName,
      `${before} entries -> ${entries.length}`,
      `| judged ${judged}, kept ${survivors}, dropped ${dropped - rescued},`,
      `topped up ${toppedUp}, filler ${rescued - repeated},`,
      `already read ${reseen}, repeats put back ${repeated}`
    );

    try {
      document.dispatchEvent(
        new CustomEvent("xlf:stats", {
          detail: JSON.stringify({
            op: opName,
            judged,
            // Rescues are below the bar, so they are never counted as kept.
            kept: survivors,
            dropped: dropped - rescued,
            rescued: rescued - repeated,
            repeated,
            toppedUp,
            reseen,
            records,
          }),
        })
      );
    } catch {
      /* stats are cosmetic */
    }
    return root;
  }

  const filterText = (raw, opName, req) => {
    if (!raw || raw.charCodeAt(0) !== 123 /* { */) return raw;
    const out = filterPayload(JSON.parse(raw), opName, req);
    return out ? JSON.stringify(out) : raw;
  };

  /* ---------- XHR ---------- */

  // Patching the prototype getters rather than adding a load listener means it
  // does not matter whether X registered its own handlers first: the body is
  // filtered on read, whenever that read happens.

  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const textDesc = Object.getOwnPropertyDescriptor(proto, "responseText");
  const respDesc = Object.getOwnPropertyDescriptor(proto, "response");

  const origSetHeader = proto.setRequestHeader;

  // Ask for a bigger page. Starvation is arithmetic: X sends 20 posts, a strict
  // bar keeps one or two, the sentinel never moves and the feed dead-ends. Ask
  // for 60 and the same bar keeps three times as many, which is usually enough
  // to keep the page growing on its own.
  //
  // Rewriting the outgoing `variables` is safe and well-precedented — Control
  // Panel for Twitter does exactly this in production to force reply sorting —
  // and it leaves method and path untouched, so X's request signature, which
  // covers those and not the query string, stays valid.
  // Asking for a bigger page is unverified against X's server: it may cap the
  // count silently (harmless), ignore it (harmless), or reject the request
  // (not harmless). So it backs itself out. The first inflated request that
  // comes back unusable disables inflation for the rest of the session, and
  // every later request goes out exactly as X wrote it.
  let inflationOff = false;

  function inflatePage(url, cfg) {
    if (!cfg.pageSize || inflationOff) return url;
    const u = new URL(url, location.origin);
    const raw = u.searchParams.get("variables");
    if (!raw) return url;
    const vars = JSON.parse(raw);
    if (typeof vars.count !== "number" || vars.count >= cfg.pageSize) return url;
    vars.count = cfg.pageSize;
    u.searchParams.set("variables", JSON.stringify(vars));
    return u.toString();
  }

  proto.open = function (method, url, ...rest) {
    let target = url;
    // XHR objects get reused, and stale caches would serve the previous
    // response. This has to happen before the inflation branch below returns:
    // inflation is on by default and rewrites every filtered request, so
    // resetting after it meant never resetting at all.
    this.__xlfCached = undefined;
    this.__xlfRaw = undefined;
    this.__xlfJsonDone = false;
    this.__xlfInflated = false;
    try {
      this.__xlfUrl = new URL(String(url), location.origin).toString();
      this.__xlfOp = opOf(this.__xlfUrl);
      this.__xlfHeaders = {};
      if (this.__xlfOp) {
        const cfg = config();
        if (cfg.filterOn && appliesTo(this.__xlfOp, cfg)) {
          const bigger = inflatePage(this.__xlfUrl, cfg);
          if (bigger !== this.__xlfUrl) {
            this.__xlfUrl = bigger;
            this.__xlfInflated = true;
            target = bigger;
            log(this.__xlfOp, "asking for", cfg.pageSize, "posts");
          }
        }
      }
    } catch {
      this.__xlfOp = null;
    }
    return origOpen.call(this, method, target === url ? url : target, ...rest);
  };

  // Captured so the rescue can replay them. Measured 2026-08-21: this no longer
  // buys a second request. X now requires x-client-transaction-id and treats it
  // as single-use — the exact captured URL returns 200 once and 404 on every
  // replay after that, and omitting the header is a 404 outright. The rescue is
  // kept because it fails open and X's requirements move, but it now stands
  // itself down after one failure rather than blocking the main thread on a
  // synchronous request that cannot succeed.
  proto.setRequestHeader = function (name, value) {
    try { if (this.__xlfHeaders) this.__xlfHeaders[name] = value; } catch { /* ignore */ }
    return origSetHeader.call(this, name, value);
  };

  function cachedText(xhr, raw) {
    if (xhr.__xlfCached !== undefined && xhr.__xlfRaw === raw) return xhr.__xlfCached;
    // The back-out: an inflated request that did not come back clean means the
    // server did not like it, so stop asking. X's own retry then goes out
    // unmodified rather than failing the same way twice.
    if (xhr.__xlfInflated && !inflationOff) {
      const bad = xhr.status !== 200 || !raw || raw.charCodeAt(0) !== 123;
      if (bad) {
        inflationOff = true;
        log("bigger pages rejected (status", xhr.status + "), asking normally from now on");
      }
    }
    xhr.__xlfRaw = raw;
    try {
      xhr.__xlfCached = filterText(raw, xhr.__xlfOp, xhr);
    } catch (e) {
      log("filter threw, passing raw through:", e);
      xhr.__xlfCached = raw;
    }
    return xhr.__xlfCached;
  }

  if (textDesc?.get) {
    Object.defineProperty(proto, "responseText", {
      configurable: true,
      enumerable: textDesc.enumerable,
      get() {
        const raw = textDesc.get.call(this);
        if (!this.__xlfOp || this.readyState !== 4) return raw;
        return cachedText(this, raw);
      },
    });
  }

  if (respDesc?.get) {
    Object.defineProperty(proto, "response", {
      configurable: true,
      enumerable: respDesc.enumerable,
      get() {
        const raw = respDesc.get.call(this);
        if (!this.__xlfOp || this.readyState !== 4) return raw;
        const type = this.responseType;
        if (type === "" || type === "text") {
          return typeof raw === "string" ? cachedText(this, raw) : raw;
        }
        if (type === "json" && raw && typeof raw === "object") {
          // Filter once: the browser hands back the same parsed object on every
          // read, and a second pass would re-run the filler.
          if (this.__xlfJsonDone) return raw;
          this.__xlfJsonDone = true;
          try {
            return filterPayload(raw, this.__xlfOp) || raw;
          } catch (e) {
            log("json filter threw, passing raw through:", e);
            return raw;
          }
        }
        return raw;
      },
    });
  }

  /* ---------- fetch, in case X moves ---------- */

  const origFetch = self.fetch;
  if (typeof origFetch === "function") {
    self.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      let op = null;
      try {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url || res.url;
        op = opOf(String(url));
      } catch {
        /* not ours */
      }
      if (!op) return res;
      try {
        const raw = await res.clone().text();
        const out = filterText(raw, op);
        if (out === raw) return res;
        // The body was re-serialised, so the original length and encoding
        // headers no longer describe it.
        const headers = new Headers(res.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        return new Response(out, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      } catch (e) {
        log("fetch filter threw, passing through:", e);
        return res;
      }
    };
  }
})();
