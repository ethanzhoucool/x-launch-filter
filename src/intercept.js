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
    return cfg;
  }

  const appliesTo = (opName, cfg) => {
    const surface = OPS[opName];
    if (surface === "home") return true;
    if (surface === "search") return !!cfg.filterSearch || !!cfg.searchFeed;
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
      const v = self.XLF.judge(self.XLF.fromApi(single, { promoted }), cfg);
      return { keep: v.keep, judged: 1, reason: v.reason, views: v.stats?.views || 0 };
    }

    // A conversation module is a post plus its replies. Keep the thread if any
    // post in it qualifies, rather than judging one item and taking the rest
    // along blind — X uses these for "A replied to B", where the first item can
    // belong to someone you do not follow.
    if (Array.isArray(content.items)) {
      let judged = 0;
      let best = 0;
      for (const it of content.items) {
        const r = it?.item?.itemContent?.tweet_results?.result;
        if (!r) continue;
        judged = 1;
        const promoted = !!it.item.itemContent.promotedMetadata;
        const v = self.XLF.judge(self.XLF.fromApi(r, { promoted }), cfg);
        best = Math.max(best, v.stats?.views || 0);
        if (v.keep) return { keep: true, judged: 1, reason: "thread", views: best };
      }
      if (judged) return { keep: false, judged: 1, reason: "thread", views: best };
    }

    // Prompts, who-to-follow carousels: not posts, leave them alone.
    return { keep: true, judged: 0 };
  }

  /* ---------- filtering a payload ---------- */

  function filterPayload(root, opName) {
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
    const cut = [];

    for (let i = entries.length - 1; i >= 0; i--) {
      const v = entryVerdict(entries[i], cfg);
      judged += v.judged;
      if (!v.keep) {
        dropped++;
        cut.push({ entry: entries[i], views: v.views || 0 });
        entries.splice(i, 1);
      }
    }

    if (!judged) {
      log(opName, "nothing judged (", before, "entries ) — passing through");
      return null;
    }

    // Last resort. A page filtered to nothing gives X nothing to render and
    // nothing to scroll, and it stops asking for more. Rather than let the feed
    // end, put the strongest rejects back. Every post this returns is below the
    // bar, which is why the counter names them separately.
    let rescued = 0;
    const floor = Math.max(0, cfg.minPerPage ?? 2);
    let survivors = judged - dropped;
    if (survivors < floor && cut.length) {
      const bottom = bottomCursor(entries);
      // Insert ahead of the Bottom cursor: the indices recorded during removal
      // are stale the moment anything else is spliced.
      const at = bottom ? entries.indexOf(bottom) : entries.length;
      const picks = cut
        .filter((c) => c.views > 0)
        .sort((a, b) => b.views - a.views)
        .slice(0, floor - survivors);
      for (const p of picks) {
        entries.splice(at < 0 ? entries.length : at, 0, p.entry);
        rescued++;
      }
    }

    log(
      opName,
      `${before} entries -> ${entries.length}`,
      `| judged ${judged}, kept ${survivors}, dropped ${dropped - rescued}, filler ${rescued}`
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
            rescued,
          }),
        })
      );
    } catch {
      /* stats are cosmetic */
    }
    return root;
  }

  const filterText = (raw, opName) => {
    if (!raw || raw.charCodeAt(0) !== 123 /* { */) return raw;
    const out = filterPayload(JSON.parse(raw), opName);
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

  proto.open = function (method, url, ...rest) {
    try {
      this.__xlfOp = opOf(String(url));
    } catch {
      this.__xlfOp = null;
    }
    // XHR objects get reused. Stale caches would serve the previous response.
    this.__xlfCached = undefined;
    this.__xlfRaw = undefined;
    this.__xlfJsonDone = false;
    return origOpen.call(this, method, url, ...rest);
  };

  function cachedText(xhr, raw) {
    if (xhr.__xlfCached !== undefined && xhr.__xlfRaw === raw) return xhr.__xlfCached;
    xhr.__xlfRaw = raw;
    try {
      xhr.__xlfCached = filterText(raw, xhr.__xlfOp);
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
