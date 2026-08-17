// Decides whether one post survives the filter. Kept free of DOM-mutation and
// storage concerns so the options page can reuse the keyword lists verbatim.

self.XLF = (() => {
  const DEFAULTS = {
    enabled: true,
    unlockUntil: 0,
    minViews: 50000,
    requireLaunch: true,
    hideAds: true,
    hideReplies: true,
    hideReposts: false,
    filterSearch: false,
    filterProfiles: false,
    blockExplore: true,
    showHud: true,
    extraInclude: "",
    extraExclude: "",
    history: [],
  };

  // Launch/product signals. Deliberately phrase-heavy: single generic words
  // ("users", "api") let too much noise through even above the view floor.
  const INCLUDE = [
    "launch", "launches", "launching", "launched", "relaunch",
    "shipped", "shipping", "ship it",
    "introducing", "announcing", "announcement",
    "now live", "went live", "we're live", "we are live", "is live",
    "now available", "generally available", "now in",
    "early access", "public beta", "in beta", "waitlist",
    "product hunt", "producthunt",
    "open source", "open-source",
    "released", "new release", "changelog", "new feature",
    "built this", "i built", "we built", "just built", "built a",
    "made this", "i made", "we made",
    "my new", "our new", "presenting", "unveiling",
    "demo", "prototype", "mvp",
    "side project", "indie hacker", "build in public", "building in public",
    "built in public",
    "testflight", "app store", "play store",
    "saas", "startup",
    "mrr", "arr", "paying customers",
    "y combinator", "raised", "seed round", "series a",
    "try it", "sign up", "get started", "free trial",
    "v1", "v2", "v3",
  ];

  // Anything here is dropped before the view count is even read.
  const EXCLUDE = [
    // politics / news cycle
    "trump", "biden", "election", "democrat", "republican", "congress",
    "senate", "liberal", "conservative", "woke", "maga",
    "left wing", "right wing", "israel", "palestine", "gaza", "ukraine",
    // engagement bait
    "hot take", "unpopular opinion", "am i the only one", "who else",
    "change my mind", "prove me wrong", "like and retweet", "retweet to",
    "drop your", "comment below", "tag someone", "follow me", "follow back",
    "giveaway", "reply with", "rt if", "like if",
    // crypto spam
    "airdrop", "memecoin", "presale", "to the moon", "nft", "pump.fun",
    "bitcoin", "ethereum", "solana",
    // misc time sinks
    "astrology", "zodiac", "horoscope", "onlyfans", "super bowl",
  ];

  // Word-boundary the alphanumeric terms so "v1" does not match "v10"; leave
  // phrases as plain substrings.
  function toMatcher(terms) {
    const clean = terms.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    if (!clean.length) return null;
    const parts = clean.map((t) => {
      const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return /^[a-z0-9]+$/.test(t) ? `\\b${esc}\\b` : esc;
    });
    try {
      return new RegExp(parts.join("|"), "i");
    } catch {
      return null;
    }
  }

  const parseList = (s) =>
    String(s || "")
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter(Boolean);

  function buildConfig(stored) {
    const cfg = { ...DEFAULTS, ...stored };
    cfg.includeRe = toMatcher(INCLUDE.concat(parseList(cfg.extraInclude)));
    cfg.excludeRe = toMatcher(EXCLUDE.concat(parseList(cfg.extraExclude)));
    return cfg;
  }

  /* ---------- reading one post ---------- */

  // The engagement bar's aria-label carries exact counts, e.g.
  // "7 replies, 15 likes, 1 bookmark, 396 views" — far more reliable than the
  // abbreviated "396" rendered on screen.
  function parseViews(label) {
    if (!label) return null;
    let m = /([\d.]+)\s*([KMB])\s+views?/i.exec(label);
    if (m) {
      const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()];
      return Math.round(parseFloat(m[1]) * mult);
    }
    m = /([\d][\d,. \s]*)\s+views?/i.exec(label);
    if (m) return parseInt(m[1].replace(/\D/g, ""), 10);
    return null;
  }

  function readViews(art) {
    const g = art.querySelector('[role="group"][aria-label]');
    const fromGroup = g && parseViews(g.getAttribute("aria-label"));
    if (fromGroup != null) return fromGroup;
    const a = art.querySelector('a[href$="/analytics"]');
    if (a) return parseViews(a.getAttribute("aria-label") || a.textContent);
    return null;
  }

  function tweetText(art) {
    let s = "";
    art.querySelectorAll('[data-testid="tweetText"]').forEach((n) => {
      s += " " + n.textContent;
    });
    const card = art.querySelector('[data-testid="card.wrapper"]');
    if (card) s += " " + card.textContent;
    return s;
  }

  function media(art) {
    return {
      video: !!art.querySelector(
        '[data-testid="videoPlayer"], [data-testid="videoComponent"], video'
      ),
      photo: !!art.querySelector('[data-testid="tweetPhoto"]'),
      card: !!art.querySelector('[data-testid="card.wrapper"]'),
    };
  }

  function isPromoted(art) {
    if (art.querySelector('[data-testid="promotedIndicator"]')) return true;
    const spans = art.querySelectorAll("span");
    const n = Math.min(spans.length, 60);
    for (let i = 0; i < n; i++) {
      const t = spans[i].textContent;
      if (t === "Promoted" || t === "Ad") return true;
    }
    return false;
  }

  function isRepost(art) {
    const ctx = art.querySelector('[data-testid="socialContext"]');
    return !!ctx && /reposted/i.test(ctx.textContent || "");
  }

  function isReply(art) {
    const nodes = art.querySelectorAll('div[dir="ltr"], div[dir="auto"]');
    const n = Math.min(nodes.length, 15);
    for (let i = 0; i < n; i++) {
      const t = (nodes[i].textContent || "").trim();
      if (t.length < 200 && /^Replying to\b/.test(t)) return true;
    }
    return false;
  }

  /* ---------- the decision ---------- */

  // Weighted so a keyword alone clears the bar, and a wordless video that links
  // out to the product does too. Anything weaker does not.
  const WEIGHTS = { keyword: 2, video: 1, card: 1, photo: 0.5 };
  const LAUNCH_BAR = 2;

  function decide(art, cfg) {
    if (cfg.hideAds && isPromoted(art)) return { keep: false, reason: "ad" };
    if (cfg.hideReposts && isRepost(art)) return { keep: false, reason: "repost" };
    if (cfg.hideReplies && isReply(art)) return { keep: false, reason: "reply" };

    const text = tweetText(art);
    if (cfg.excludeRe && cfg.excludeRe.test(text)) {
      return { keep: false, reason: "noise" };
    }

    const views = readViews(art);
    // Counts mount a beat after the post does; let the caller retry before
    // judging a post that simply has not rendered its numbers yet.
    if (views == null) return { keep: false, reason: "measuring", retry: true };
    if (views < cfg.minViews) return { keep: false, reason: "low views", views };

    if (cfg.requireLaunch) {
      const m = media(art);
      const score =
        (cfg.includeRe && cfg.includeRe.test(text) ? WEIGHTS.keyword : 0) +
        (m.video ? WEIGHTS.video : 0) +
        (m.card ? WEIGHTS.card : 0) +
        (m.photo ? WEIGHTS.photo : 0);
      if (score < LAUNCH_BAR) return { keep: false, reason: "off-topic", views };
    }
    return { keep: true, reason: "keep", views };
  }

  return { DEFAULTS, INCLUDE, EXCLUDE, buildConfig, decide, readViews, parseViews };
})();
