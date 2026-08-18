// Runs in the page's own world at document_start, before X's bundle loads, and
// filters timeline posts out of the API response before X ever renders them.
//
// Why here and not in the DOM: X's timeline is virtualised, and every post's
// position is a coordinate cached at mount. Hiding a rendered post does not
// reflow the list, so it leaves a permanent hole, and the reserved scroll space
// never shrinks. Deleting the post from the response sidesteps all of that:
// X lays out a shorter timeline that is correct by construction.
//
// What it does NOT fix, measured the hard way: X's pagination is driven by
// rendered content, so a page filtered down to nothing is a dead end. With an
// empty timeline, scrolling to the bottom eight times produced zero further
// requests. Hence the minPerPage floor below — a few of the strongest rejects
// go back in so there is something to scroll and X keeps asking for more.
//
// Verified against a live HomeTimeline response: transport is XHR, the request
// is a GET, and entries live at
//   data.home.home_timeline_urt.instructions[<n>].entries
// The walk below finds them structurally rather than by that path, so a
// reshuffle upstream does not break it.
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

  /* ---------- config, bridged from the isolated content script ---------- */

  function config() {
    let stored = {};
    try {
      const raw = document.documentElement.getAttribute("data-xlf");
      if (raw) stored = JSON.parse(raw);
    } catch {
      /* fall through to defaults */
    }
    const cfg = self.XLF.buildConfig(stored);
    // Absent config means the bridge has not landed yet. Default to filtering:
    // the protective state is the one the user asked for.
    cfg.filterOn = cfg.enabled !== false && Date.now() >= (cfg.unlockUntil || 0);
    return cfg;
  }

  const appliesTo = (opName, cfg) => {
    const surface = OPS[opName];
    if (surface === "home") return true;
    if (surface === "search") return !!cfg.filterSearch;
    if (surface === "profile") return !!cfg.filterProfiles;
    return false;
  };

  /* ---------- judging one timeline entry ---------- */

  function entryVerdict(entry, cfg) {
    const id = entry?.entryId || "";
    // Cursors are how pagination continues. Dropping one ends the timeline.
    if (id.startsWith("cursor-")) return { keep: true, judged: 0 };

    const content = entry?.content || {};

    const single = content.itemContent?.tweet_results?.result;
    if (single) {
      const promoted = !!content.itemContent?.promotedMetadata;
      const v = self.XLF.judge(self.XLF.fromApi(single, { promoted }), cfg);
      return { keep: v.keep, judged: 1, reason: v.reason, views: v.stats?.views || 0 };
    }

    // A conversation module is a post plus its replies. Judge the root and take
    // the thread with it, rather than leaving a thread with holes in it.
    if (Array.isArray(content.items)) {
      for (const it of content.items) {
        const r = it?.item?.itemContent?.tweet_results?.result;
        if (!r) continue;
        const promoted = !!it.item.itemContent.promotedMetadata;
        const v = self.XLF.judge(self.XLF.fromApi(r, { promoted }), cfg);
        return { keep: v.keep, judged: 1, reason: v.reason, views: v.stats?.views || 0 };
      }
    }

    // Prompts, who-to-follow carousels, anything else: not a post, leave it.
    return { keep: true, judged: 0 };
  }

  /* ---------- filtering a whole payload ---------- */

  function filterPayload(root, opName) {
    const cfg = config();
    if (!cfg.filterOn || !appliesTo(opName, cfg)) return null;

    let judged = 0;
    let dropped = 0;
    const seen = new Set();

    (function walk(node) {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        const isEntries =
          node.length && node[0] && typeof node[0] === "object" && "entryId" in node[0];
        if (isEntries) {
          // Filter in place, back to front. Do not descend: nested tweets are
          // quoted posts and thread replies, which belong to their parent's
          // verdict, not their own.
          const cut = [];
          let survivors = 0;
          for (let i = node.length - 1; i >= 0; i--) {
            const v = entryVerdict(node[i], cfg);
            judged += v.judged;
            if (!v.keep) {
              dropped++;
              cut.push({ at: i, entry: node[i], views: v.views || 0 });
              node.splice(i, 1);
            } else if (v.judged) {
              survivors++;
            }
          }

          // X's pagination is driven by rendered content, so a page filtered to
          // nothing is a dead end — measured: with an empty timeline, scrolling
          // to the bottom eight times produced zero further requests. Rather
          // than let the feed stop, put the strongest few rejects back so there
          // is something to scroll and X keeps asking for more.
          const floor = Math.max(0, cfg.minPerPage ?? 3);
          if (judged && survivors < floor && cut.length) {
            const rescued = cut
              .filter((c) => c.views > 0)
              .sort((a, b) => b.views - a.views)
              .slice(0, floor - survivors)
              .sort((a, b) => a.at - b.at);
            for (const r of rescued) {
              node.splice(Math.min(r.at, node.length), 0, r.entry);
              dropped--;
            }
          }
          return;
        }
        for (const v of node) walk(v);
        return;
      }
      for (const k in node) walk(node[k]);
    })(root);

    if (!judged) return null;

    try {
      document.dispatchEvent(
        new CustomEvent("xlf:stats", {
          detail: JSON.stringify({ op: opName, judged, dropped, kept: judged - dropped }),
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

  // X reads the body off XMLHttpRequest. Patching the prototype getters rather
  // than adding a load listener means it does not matter whether X registered
  // its own handlers before or after us — the body is filtered on read.

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
    return origOpen.call(this, method, url, ...rest);
  };

  // Filter once per request, then serve the cached result: X reads the body
  // more than once, and re-parsing a megabyte of JSON each time is wasteful.
  function cachedText(xhr, raw) {
    if (xhr.__xlfCached !== undefined && xhr.__xlfRaw === raw) return xhr.__xlfCached;
    xhr.__xlfRaw = raw;
    try {
      xhr.__xlfCached = filterText(raw, xhr.__xlfOp);
    } catch {
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
          try {
            // Parsed once by the browser and cached, so filtering in place is
            // both safe and idempotent-enough: a second pass finds nothing left
            // to drop.
            return filterPayload(raw, this.__xlfOp) || raw;
          } catch {
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
        return new Response(out, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      } catch {
        return res;
      }
    };
  }
})();
