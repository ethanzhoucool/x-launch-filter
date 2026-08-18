// Runs in the page's own world at document_start, before X's bundle loads, and
// filters timeline posts out of the API response before X ever renders them.
//
// Why here and not in the DOM: X's timeline is virtualised, and every post's
// position is a coordinate cached at mount. Hiding a rendered post does not
// reflow the list, so it leaves a permanent hole, and the reserved scroll space
// never shrinks. Deleting the post from the response sidesteps all of that.
//
// The hard part is not filtering, it is that filtering starves the feed. X's
// "load more" is driven by rendered content, so a page filtered down to nothing
// is a dead end — measured: with an empty timeline, scrolling to the bottom
// eight times produced zero further requests. The answer is to read ahead:
// while X renders one page, this quietly pulls the next few over the same
// cursor, keeps the posts that qualify, and hands them to X on its next
// request. X stays fed with posts that actually pass the bar.
//
// Everything here was verified against live traffic: transport is XHR, the
// request is a GET, entries live at
//   data.home.home_timeline_urt.instructions[<n>].entries
// and replaying X's own signed headers on a cursor URL returns 200 with a
// further cursor. The walk finds entries structurally rather than by that path.
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

  // Captured before we patch anything, so read-ahead requests never run back
  // through our own filter.
  const rawFetch = self.fetch ? self.fetch.bind(self) : null;

  const opOf = (url) => {
    if (!url || url.indexOf("/graphql/") === -1) return null;
    const m = /\/graphql\/[^/]+\/([A-Za-z]+)/.exec(url);
    return m && OPS[m[1]] ? m[1] : null;
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

    // No bridge means no settings, and critically no way for the popup to turn
    // this off — the off switch travels through that same attribute. Absence is
    // therefore treated as off: worst case is an unfiltered timeline and a
    // working browser, rather than a modified one with no escape.
    if (!stored) {
      cfg.filterOn = false;
      return cfg;
    }
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
      return { keep: v.keep, judged: 1, views: v.stats?.views || 0 };
    }

    // A conversation module is a post plus its replies. Judge the root and take
    // the thread with it, rather than leaving a thread full of holes.
    if (Array.isArray(content.items)) {
      for (const it of content.items) {
        const r = it?.item?.itemContent?.tweet_results?.result;
        if (!r) continue;
        const promoted = !!it.item.itemContent.promotedMetadata;
        const v = self.XLF.judge(self.XLF.fromApi(r, { promoted }), cfg);
        return { keep: v.keep, judged: 1, views: v.stats?.views || 0 };
      }
    }

    // Prompts, who-to-follow carousels: not posts, leave them alone.
    return { keep: true, judged: 0 };
  }

  /* ---------- read-ahead ---------- */

  // What X's own request looked like, so the read-ahead can replay it.
  let lastUrl = null;
  let lastHeaders = null;
  // How far ahead we have already read. X's cursor is rewritten to match, so it
  // never refetches ground we covered.
  let readCursor = null;
  let bank = [];
  let banking = false;
  const delivered = new Set();

  function urlWithCursor(url, cursor) {
    const u = new URL(url, location.origin);
    const vars = JSON.parse(u.searchParams.get("variables") || "{}");
    vars.cursor = cursor;
    u.searchParams.set("variables", JSON.stringify(vars));
    return u.toString();
  }

  function remember(entries) {
    for (const e of entries) {
      if (!isCursor(e)) delivered.add(e.entryId);
    }
    if (delivered.size > 1500) delivered.clear();
  }

  // Pulls pages over the cursor until there are enough qualifying posts banked
  // to fill X's next request. Runs in the background; nothing waits on it.
  async function readAhead(cfg) {
    if (banking || !rawFetch || !lastUrl || !lastHeaders || !readCursor) return;
    const target = Math.max(1, cfg.pageTarget || 8);
    if (bank.length >= target) return;

    banking = true;
    try {
      let rounds = 0;
      const maxRounds = Math.max(0, cfg.maxTopUps ?? 5);
      while (bank.length < target && rounds < maxRounds && readCursor) {
        rounds++;
        const res = await rawFetch(urlWithCursor(lastUrl, readCursor), {
          method: "GET",
          headers: lastHeaders,
          credentials: "include",
          referrer: location.href,
        });
        if (!res.ok) break;

        const entries = findEntries(await res.json());
        if (!entries || !entries.length) break;

        for (const e of entries) {
          if (isCursor(e) || delivered.has(e.entryId)) continue;
          const v = entryVerdict(e, cfg);
          if (v.judged && v.keep) bank.push(e);
        }

        const next = bottomCursor(entries)?.content?.value;
        if (!next || next === readCursor) break;
        readCursor = next;
      }
    } catch {
      /* read-ahead is best effort */
    } finally {
      banking = false;
    }
  }

  /* ---------- filtering a payload ---------- */

  function filterPayload(root, opName) {
    const cfg = config();
    if (!cfg.filterOn || !appliesTo(opName, cfg)) return null;

    const entries = findEntries(root);
    if (!entries) return null;

    let judged = 0;
    let dropped = 0;
    const cut = [];

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      // Read-ahead means X can be handed posts before it asks for them, so the
      // same post can come round again. Drop the repeat.
      if (!isCursor(entry) && delivered.has(entry.entryId)) {
        entries.splice(i, 1);
        continue;
      }
      const v = entryVerdict(entry, cfg);
      judged += v.judged;
      if (!v.keep) {
        dropped++;
        cut.push({ at: i, entry, views: v.views || 0 });
        entries.splice(i, 1);
      }
    }

    const bottom = bottomCursor(entries);
    if (!readCursor) readCursor = bottom?.content?.value || null;

    let survivors = entries.filter((e) => !isCursor(e)).length;

    // Spend the bank first: these already passed the bar on an earlier page.
    const target = Math.max(1, cfg.pageTarget || 8);
    let banked = 0;
    if (bank.length && survivors < target) {
      const take = bank.splice(0, target - survivors);
      const at = bottom ? entries.indexOf(bottom) : entries.length;
      entries.splice(at < 0 ? entries.length : at, 0, ...take);
      banked = take.length;
      survivors += take.length;
    }

    // Last resort. X stops paginating on an empty page, so rather than let the
    // feed die, put the strongest rejects back. Every post this returns is below
    // your bar, which is why the bank above exists to make it unnecessary.
    let rescued = 0;
    const floor = Math.max(0, cfg.minPerPage ?? 2);
    if (judged && survivors < floor && cut.length) {
      const picks = cut
        .filter((c) => c.views > 0)
        .sort((a, b) => b.views - a.views)
        .slice(0, floor - survivors)
        .sort((a, b) => a.at - b.at);
      for (const p of picks) {
        entries.splice(Math.min(p.at, entries.length), 0, p.entry);
        dropped--;
        rescued++;
      }
    }

    // Keep X's cursor level with how far the read-ahead got, so it does not
    // refetch pages already mined.
    if (bottom && readCursor) bottom.content.value = readCursor;

    remember(entries);
    if (!judged && !banked) return null;

    readAhead(cfg);

    try {
      document.dispatchEvent(
        new CustomEvent("xlf:stats", {
          detail: JSON.stringify({
            op: opName,
            judged,
            dropped,
            kept: Math.max(0, judged - dropped),
            banked,
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
  const origSetHeader = proto.setRequestHeader;
  const textDesc = Object.getOwnPropertyDescriptor(proto, "responseText");
  const respDesc = Object.getOwnPropertyDescriptor(proto, "response");

  proto.open = function (method, url, ...rest) {
    try {
      const full = new URL(String(url), location.origin).toString();
      this.__xlfOp = opOf(full);
      if (this.__xlfOp) {
        this.__xlfHeaders = {};
        lastUrl = full;
      }
    } catch {
      this.__xlfOp = null;
    }
    return origOpen.call(this, method, url, ...rest);
  };

  // X signs each request; replaying its own headers is what makes the
  // read-ahead acceptable to the server.
  proto.setRequestHeader = function (name, value) {
    try {
      if (this.__xlfHeaders) {
        this.__xlfHeaders[name] = value;
        lastHeaders = this.__xlfHeaders;
      }
    } catch {
      /* ignore */
    }
    return origSetHeader.call(this, name, value);
  };

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
          // Filter exactly once. The browser hands back the same parsed object
          // on every read, and filtering is no longer idempotent: a second pass
          // would find every entry already marked delivered and strip the page
          // to nothing.
          if (this.__xlfJsonDone) return raw;
          this.__xlfJsonDone = true;
          try {
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

  if (rawFetch) {
    self.fetch = async function (...args) {
      const res = await rawFetch.apply(this, args);
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
