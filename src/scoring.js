// Decides whether one post survives the filter.
//
// Loaded into BOTH worlds: the isolated content script (for the HUD and the
// Explore gate) and the MAIN-world interceptor (which judges posts straight off
// the API response, before X's renderer ever sees them). So this file must stay
// free of chrome.* and of anything DOM-only.
//
// Both paths normalise into the same record shape and call judge().

self.XLF = (() => {
  const DEFAULTS = {
    enabled: true,
    unlockUntil: 0,
    minViews: 50000,
    // Engagement rates, as a percentage of views. 0 disables the gate.
    // Measured on a live feed: median like rate 0.59%, median bookmark rate
    // 0.01%, and the biggest posts run LOWER (a 2M-view post landed at 0.5%
    // likes / 0.19% bookmarks). Reach and rate pull against each other, so
    // these default off — stacking them with a high view floor empties the feed.
    minLikeRate: 0,
    minBookmarkRate: 0,
    // Follower ceiling. 0 is off. Aimed at finding indie builders shipping
    // things rather than megaphone accounts, whose reach says little about
    // whether the thing itself is interesting.
    maxFollowers: 0,
    // Last-resort filler. A page filtered to nothing stops X paginating, so
    // this many below-bar posts go back in rather than let the feed die. The
    // read-ahead bank in intercept.js exists to make it unnecessary; 0 turns it
    // off and accepts the occasional dead end.
    minPerPage: 2,
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
    debug: false,
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

  // Anything here is dropped before the numbers are even read.
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
    // Nullish values must not override defaults. `post.views < null` is false,
    // so a stray null minViews would silently disable the view floor.
    const clean = {};
    for (const k in stored || {}) {
      if (stored[k] !== null && stored[k] !== undefined) clean[k] = stored[k];
    }
    const cfg = { ...DEFAULTS, ...clean };
    cfg.includeRe = toMatcher(INCLUDE.concat(parseList(cfg.extraInclude)));
    cfg.excludeRe = toMatcher(EXCLUDE.concat(parseList(cfg.extraExclude)));
    return cfg;
  }

  /* ---------- the verdict ---------- */

  // Weighted so a keyword alone clears the bar, and a wordless video that links
  // out to the product does too. Anything weaker does not.
  const WEIGHTS = { keyword: 2, video: 1, card: 1, photo: 0.5 };
  const LAUNCH_BAR = 2;

  const rate = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);

  // post: { views, likes, bookmarks, text, hasVideo, hasPhoto, hasCard,
  //         isReply, isRepost, isAd }
  function judge(post, cfg) {
    if (!post) return { keep: false, reason: "unreadable" };
    if (cfg.hideAds && post.isAd) return { keep: false, reason: "ad" };
    if (cfg.hideReposts && post.isRepost) return { keep: false, reason: "repost" };
    if (cfg.hideReplies && post.isReply) return { keep: false, reason: "reply" };

    if (cfg.excludeRe && cfg.excludeRe.test(post.text)) {
      return { keep: false, reason: "noise" };
    }

    // The DOM path can see a post before its counts render; the API path never
    // can. Only the former sets views to null, and only it retries.
    if (post.views == null) return { keep: false, reason: "measuring", retry: true };

    const stats = {
      views: post.views,
      likeRate: rate(post.likes, post.views),
      bookmarkRate: rate(post.bookmarks, post.views),
    };

    if (post.views < cfg.minViews) return { keep: false, reason: "low views", stats };
    if (cfg.minLikeRate > 0 && stats.likeRate < cfg.minLikeRate) {
      return { keep: false, reason: "low like rate", stats };
    }
    if (cfg.minBookmarkRate > 0 && stats.bookmarkRate < cfg.minBookmarkRate) {
      return { keep: false, reason: "low bookmark rate", stats };
    }
    if (cfg.maxFollowers > 0 && post.followers != null &&
        post.followers > cfg.maxFollowers) {
      return { keep: false, reason: "too many followers", stats };
    }

    if (cfg.requireLaunch) {
      const score =
        (cfg.includeRe && cfg.includeRe.test(post.text) ? WEIGHTS.keyword : 0) +
        (post.hasVideo ? WEIGHTS.video : 0) +
        (post.hasCard ? WEIGHTS.card : 0) +
        (post.hasPhoto ? WEIGHTS.photo : 0);
      if (score < LAUNCH_BAR) return { keep: false, reason: "off-topic", stats };
    }
    return { keep: true, reason: "keep", stats };
  }

  /* ---------- path 1: straight off the API ---------- */

  // The author object has moved around across X's schema revisions, so try the
  // known shapes and return null rather than 0 when none match. null means
  // "unknown", and an unknown follower count is never filtered on — a wrong
  // guess here should cost a missed filter, not a blank feed.
  function followersOf(t) {
    const u = t?.core?.user_results?.result;
    if (!u) return null;
    const n =
      u.legacy?.followers_count ??
      u.followers_count ??
      u.core?.followers_count ??
      u.relationship_counts?.followers;
    return typeof n === "number" ? n : null;
  }

  // Verified against a live HomeTimeline response: views.count is a string,
  // counts live on .legacy, and TweetWithVisibilityResults wraps the real tweet
  // one level deeper.
  function fromApi(result, opts = {}) {
    const outer = result?.tweet || result;
    const isRepost = !!outer?.legacy?.retweeted_status_result;

    // A repost's own wrapper carries zero counts and a truncated "RT @user: …"
    // body, so judging it drops every repost regardless of the hideReposts
    // setting. Judge the post being shared instead.
    const shared = outer?.legacy?.retweeted_status_result?.result;
    const t = shared ? shared.tweet || shared : outer;

    const legacy = t?.legacy;
    if (!legacy) return null;

    // Long posts truncate full_text; note_tweet carries the whole thing.
    const note = t.note_tweet?.note_tweet_results?.result?.text;
    const card = t?.card || result?.card;
    const cardText = card
      ? (card.legacy?.binding_values || [])
          .filter((b) => b.key === "title" || b.key === "description")
          .map((b) => b.value?.string_value || "")
          .join(" ")
      : "";

    const media = legacy.extended_entities?.media || legacy.entities?.media || [];

    return {
      views: Number(t.views?.count) || 0,
      followers: followersOf(t),
      likes: legacy.favorite_count || 0,
      bookmarks: legacy.bookmark_count || 0,
      text: `${note || legacy.full_text || ""} ${cardText}`,
      hasVideo: media.some((m) => m.type === "video" || m.type === "animated_gif"),
      hasPhoto: media.some((m) => m.type === "photo"),
      hasCard: !!card,
      isReply: !!legacy.in_reply_to_status_id_str,
      isRepost,
      isAd: !!opts.promoted,
    };
  }

  /* ---------- path 2: scraped off the DOM ---------- */

  // The engagement bar's aria-label carries exact counts, e.g.
  // "7 replies, 15 likes, 1 bookmark, 396 views".
  // Two passes, because the two number formats need different character
  // classes. Abbreviated counts ("1.2M views") use a decimal point; exact ones
  // ("45,201 views") are comma-grouped, and a single pattern that allows both
  // will happily match the last group of an exact count and read 45,201 as 201.
  function parseCount(label, noun) {
    if (!label) return null;

    const compact = new RegExp(`([\\d.]+)\\s*([KMB])\\s+${noun}s?\\b`, "i");
    let m = compact.exec(label);
    if (m) {
      const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()];
      return Math.round(parseFloat(m[1]) * mult);
    }

    const exact = new RegExp(`(\\d[\\d,.\\s]*)\\s+${noun}s?\\b`, "i");
    m = exact.exec(label);
    if (!m) return null;
    return parseInt(m[1].replace(/\D/g, ""), 10);
  }

  const parseViews = (label) => parseCount(label, "view");

  function isPromotedEl(art) {
    if (art.querySelector('[data-testid="promotedIndicator"]')) return true;
    const spans = art.querySelectorAll("span");
    const n = Math.min(spans.length, 60);
    for (let i = 0; i < n; i++) {
      const t = spans[i].textContent;
      if (t === "Promoted" || t === "Ad") return true;
    }
    return false;
  }

  function isReplyEl(art) {
    const nodes = art.querySelectorAll('div[dir="ltr"], div[dir="auto"]');
    const n = Math.min(nodes.length, 15);
    for (let i = 0; i < n; i++) {
      const t = (nodes[i].textContent || "").trim();
      if (t.length < 200 && /^Replying to\b/.test(t)) return true;
    }
    return false;
  }

  function fromArticle(art) {
    const group = art.querySelector('[role="group"][aria-label]');
    const label = group?.getAttribute("aria-label") || "";
    const analytics = art.querySelector('a[href$="/analytics"]');
    const views =
      parseViews(label) ??
      parseViews(analytics?.getAttribute("aria-label") || analytics?.textContent);

    let text = "";
    art.querySelectorAll('[data-testid="tweetText"]').forEach((n) => {
      text += " " + n.textContent;
    });
    const card = art.querySelector('[data-testid="card.wrapper"]');
    if (card) text += " " + card.textContent;

    const ctx = art.querySelector('[data-testid="socialContext"]');

    return {
      // A timeline post does not render its author's follower count, so the DOM
      // path leaves this unknown and the ceiling simply does not apply there.
      followers: null,
      views,
      likes: parseCount(label, "like") || 0,
      bookmarks: parseCount(label, "bookmark") || 0,
      text,
      hasVideo: !!art.querySelector(
        '[data-testid="videoPlayer"], [data-testid="videoComponent"], video'
      ),
      hasPhoto: !!art.querySelector('[data-testid="tweetPhoto"]'),
      hasCard: !!card,
      isReply: isReplyEl(art),
      isRepost: !!ctx && /reposted/i.test(ctx.textContent || ""),
      isAd: isPromotedEl(art),
    };
  }

  const decide = (art, cfg) => judge(fromArticle(art), cfg);

  return {
    DEFAULTS, INCLUDE, EXCLUDE,
    buildConfig, judge, fromApi, fromArticle, decide,
    parseViews, parseCount,
  };
})();
