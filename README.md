# X Launch Filter

X Launch Filter is an unpacked MV3 Chrome extension that reduces the X home
timeline to high-reach launch and product posts. It is for people who open X for
product news and lose an hour to the feed instead.

Failing posts are removed from X's API response before its renderer ever sees
them, so the timeline it lays out is simply shorter. Nothing is hidden with CSS
and no layout is overridden.

## Install

1. Clone or download this folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the folder.
4. Open `x.com/home`. A pill in the bottom-left corner reports what is running.

## The pill and the panel

The pill is the only thing visible in normal use and the only entry point. It
reports outcomes, never settings:

```
Search · 31 of 38                 filtering the search feed
Home · 12 of 96 · 2 below bar     filtering home, with keep-alive filler
Home · watching…                  nothing judged yet
Nothing passed · 96 hidden        the bar is higher than anything that arrived
Paused · 12m left                 paused, and it re-arms itself
```

Clicking it opens the tuning panel, which is the **only** place the bar is set.
Every control there re-scores the posts already seen this session as you change
it, so the panel tells you what a setting *would* keep before you commit:

```
Would keep 9 of 96 seen · now 12
below 50k views   ████████████ 52
no launch signal  ████         17
muted topics      ██            8
```

That readout is the point of the whole interface. These thresholds interact in
ways nobody would guess — reach fights engagement rate, and a follower ceiling
fights a view floor — and the bars make a trap visible as you create it rather
than after a reload turns the feed blank. Applying still reloads, because posts
already on screen were judged on the way in and cannot be re-judged; but the
reload is now a single commit rather than a guess in a loop.

## How a post is judged

Dropped before anything is scored: promoted posts, replies, and anything
matching a built-in noise list (politics, engagement bait, crypto, assorted time
sinks).

What survives has to clear the bars you set.

**A view floor.** 50,000 by default, adjustable from none to 1M.

**Engagement rates, both optional and both off by default.** Likes as a
percentage of views, and bookmarks as a percentage of views. Bookmark rate is
the best available "someone thought this was worth keeping" signal.

**A follower ceiling, off by default.** Drops posts from accounts above a
follower count, to surface indie builders shipping things rather than megaphone
accounts whose reach says little about whether the thing is interesting. It
pairs naturally with a *lower* view floor: a 20k-view post from someone with
3,000 followers travelled much further than its author's audience, which is
usually the interesting case.

An author whose follower count cannot be read is never dropped by this gate.
The DOM path cannot see follower counts at all, so it never applies there.

**Do not stack it against a high view floor.** A follower ceiling caps reach and
a view floor demands it, so together they ask for posts that outran their
author's entire audience. 100k views from an account under 50k followers means
every post must reach twice everyone who follows it. That is rare enough to
empty the feed, and with the filler off X will decide you have no timeline and
show its new-user welcome screen. The panel warns when the two dials are set
against each other. Pair a follower ceiling with a *low* view floor: 10k to 25k
is where breakout posts from small accounts actually live.

**A launch score,** which has to reach 2:

| signal | weight |
| --- | --- |
| launch or product keyword | 2 |
| native video | 1 |
| link card | 1 |
| photo | 0.5 |

A keyword alone passes. So does a wordless demo video that links out to the
product. A video with nothing else does not.

Both keyword lists are editable in the settings page, and your terms are added
to the built-ins rather than replacing them.

### Picking thresholds

Measured across one live page of a real home timeline (81 posts):

| metric | value |
| --- | --- |
| median views | 942 |
| posts at or above 50k views | 10 of 81 |
| median like rate | 0.59% |
| median bookmark rate | 0.01% |
| a 1.98M-view post | 0.5% likes, 0.19% bookmarks |

The last row is the important one. **Reach and engagement rate pull against each
other** — the biggest posts have lower like and bookmark rates than small ones,
because reach outruns engagement. Stacking a high view floor on top of a high
rate floor returns nothing at all. Lead with one or the other. On these numbers
a 5% like-rate gate is unreachable, 1% is already above the median, and a 0.1%
bookmark rate is strong.

## Search as the feed

The algorithmic timeline is roughly 88% below any useful bar, which is what made
everything else here hard: a filter strict enough to be useful empties the page,
and an empty page is what ends infinite scroll.

Turning on **Use search as the feed** redirects `x.com/home` to one of X's own
search queries instead. The server does the coarse filtering and paginates
natively, so what arrives is already mostly relevant and the gates trim it
rather than gut it. Nothing else on X is touched.

X search has no `min_views`, so the view floor is converted to `min_faves:`
using the like rate measured on a live feed — about 0.6% of views, so roughly
views divided by 170. Checked against live results, `min_faves:150` lands around
a 25k-view median. The exact view floor and follower ceiling are still enforced
on the results, so the conversion only has to be approximately right.

The query ANDs two groups: launch phrasing, and product vocabulary. The second
group is what makes it work. "launch" has senses no search operator separates,
and the first live test returned a ballistic-missile report as its top hit;
requiring a product word alongside it fixes that, because news copy almost never
carries product vocabulary.

Tuned against live results, in order:

| query | result on a live page |
| --- | --- |
| bare `launch` terms, Latest | top hit was a ballistic missile report |
| phrases only, Latest | 3 of 5 were Iran/Syria news |
| phrases AND product terms, Top | 1 of 5 news, 3 of 5 kept at a 10k floor |
| the shipped query, Top | **4 of 5 kept, no news at all** |

That last run returned 452k, 98k, 75k, 29k and 5.1k view posts, led by
"Introducing OpenSEO, the open source alternative" — against a home feed where
roughly one post in eight clears even 50k views.

Sorting defaults to Top rather than Latest. Latest gets flooded by whatever news
cycle is running, which is how the Iran stories got in.

## Where it applies

- **Home timeline**: always filtered, both For You and Following.
- **Explore and Trending**: blocked outright, behind a search box.
- **Search and profiles**: untouched by default. Searching is the deliberate
  behaviour this is trying to push you back toward. Both can be filtered from
  settings.

The popup also carries four one-click launch searches built from X's advanced
operators. X search has no `min_views` operator, so those queries use
`min_faves:` as the reach proxy.

## Pausing

Pause for 15, 30 or 60 minutes from the panel or the popup. It always re-arms
itself, and the badge counts down.

There used to be a hold-to-unlock ceremony here, inherited from a YouTube
blocker. It is gone. This became a research tool that gets tuned constantly, and
the ceremony only taxed the tuning; the lease is what actually defeats a reflex,
and it does so without asking for a performance.

## How the filtering works

The interesting problem here is that you cannot usefully hide a post in X's
timeline after it renders.

X's timeline is a virtualised list. Each post wrapper
(`div[data-testid="cellInnerDiv"]`) is `position: absolute` with a cached
`transform: translateY(...)`, and only five to ten of them exist in the DOM at a
time. Those offsets are computed once at mount. They are not derived from
layout. Three measurements on a live timeline:

- Hiding one wrapper with `display: none` left every sibling's `translateY`
  byte-for-byte identical. The list does not reflow, so a hidden post leaves a
  permanent hole.
- Collapsing a wrapper's contents to zero height did not move siblings either.
  Its own height went from 645px to 0px and nothing around it shifted.
- The parent reserves scroll space with `min-height` (observed at 11497.5px),
  not a fixed `height`, and hiding posts never shrinks it.

Together those mean any DOM-level approach either leaves holes or has to seize
layout from the component whose entire job is layout. An earlier version of this
extension did the latter, forcing the wrappers into normal flow. It closed the
gaps and created worse problems: the reserved scroll space stayed, so a heavily
filtered feed became a short column above thousands of pixels of nothing.

So the filtering moved upstream, into the response itself.

`src/intercept.js` runs in the page's own world at `document_start`, before X's
bundle loads, and patches the `responseText` and `response` getters on
`XMLHttpRequest.prototype`. Patching the getters rather than adding a load
listener means it does not matter whether X registered its own handlers first —
the body is filtered on read, whenever that happens. `fetch` is patched too, in
case X moves.

Verified against a live `HomeTimeline` response:

- Transport is XHR and the request is a GET, with `count: 20` in the query
  string.
- Entries live at `data.home.home_timeline_urt.instructions[n].entries`. The
  walk finds them structurally, by looking for an array of objects carrying an
  `entryId`, so a reshuffle upstream does not break it.
- Entry ids are prefixed `cursor-`, `tweet-` and `home-conversation-`.
- A single post sits at `content.itemContent.tweet_results.result`; a
  conversation module carries `content.items[].item.itemContent.tweet_results.result`
  and is judged by its root post, so a thread is kept or dropped whole.
- `views.count` is a string; likes and bookmarks are `legacy.favorite_count` and
  `legacy.bookmark_count`. Long posts truncate `full_text`, so `note_tweet`
  carries the real text.

**Cursor entries are never touched.** They are how pagination continues, and
dropping one ends the timeline permanently.

On a live response this reduced 37 entries to 7 — 35 posts judged, 30 dropped,
both the Top and Bottom cursors preserved, survivors at 3.5M, 1.4M, 157k, 98k
and 84k views.

Every failure path returns the response untouched. An unfiltered feed is a bad
day; a broken timeline is a bug report.

### If X changes

- **Posts stop being filtered** → the operation names and entry paths in
  `src/intercept.js`, and the field names in `XLF.fromApi()`.
- **The timeline breaks entirely** → disable the extension and check whether
  `filterPayload` is dropping cursor entries.

## Known limitations

**Very little survives, by design.** The gates multiply. In one live sample the
filter kept 5 posts out of 35 judged, and with the launch-keyword requirement on
top it has kept as few as 1 out of 21. An empty column is a real outcome, not a
bug. Lower the view floor in settings.

**Infinite scroll is worth more than a full page.** An earlier version read
ahead over the pagination cursor, banked qualifying posts, and spliced them into
X's next response. Every part of that broke scrolling, and it is worth recording
why, because the idea is tempting:

- the read-ahead replayed the home cursor against whatever timeline endpoint X
  had opened last, because the captured URL and headers lived in single globals.
  It failed on essentially every request, silently;
- with it failing, the read position never advanced, so every response had its
  Bottom cursor rewritten to the same stale value and X refetched the page it
  already had;
- the dedupe then stripped that page as already delivered, so X received an
  empty page and concluded the timeline had ended.

The interceptor now only decides what survives. It does not fetch, rewrite
cursors, or reorder. X owns pagination.

**The dead-end, and the one thing that fixes it.** X's loader fires on a
*transition* into the trigger zone, not on being in it. Unfiltered, a fetch adds
20 posts and shoves the loading sentinel far below the fold, so the next scroll
re-enters the zone and fires again. Filter a page down to nothing and the
sentinel never moves: no transition, no next fetch. Scrolling up and back down
fixes it by hand, because that re-creates the transition. If nothing survives at
all, the page is not even scrollable and there is no way out.

Triggering that loader from script is not possible. Measured across eight
approaches — `scrollTo` to the true bottom, `scrollBy`, a full excursion up and
back, `scrollTo(0)` then bottom, smooth scroll, a synthetic `WheelEvent`,
synthetic `scroll` events, and translating the sentinel out of the viewport and
back — every one produced **zero** requests, while a single real wheel gesture
fired immediately. X wants trusted input and script cannot forge it.

So this does not try to fake a gesture. Two defences instead, cheapest first.

**Ask for a bigger page.** Starvation is arithmetic: X sends 20 posts, a strict
bar keeps one, the sentinel never moves. The outgoing request's `variables.count`
is rewritten to 60, so the same bar keeps roughly three times as many and the
page usually keeps growing on its own. Rewriting `variables` is well precedented
— Control Panel for Twitter does exactly this in production to force reply
sorting — and it leaves method and path alone, so X's request signature stays
valid. It is unverified against X's server, so it backs itself out: the first
inflated request that returns anything unusable disables inflation for the rest
of the session and every later request goes out exactly as X wrote it.

**Rescue a dead-ended feed.** When a page still keeps nothing, the interceptor
fetches the next page itself and hands X a response worth rendering. That case
is unconditional, because a page with no posts is not merely thin: the document
is no taller than the viewport, so there is no scroll gesture available and X
will never be asked again. Blocking briefly beats a feed that has stopped. The
response getter is synchronous so the fetch is a synchronous XHR, capped at
three extra pages, failing open on any error, and it only ever advances X's
cursor to a page it actually consumed. Extending the same rescue to thin-but-
scrollable pages is opt-in, since you can scroll your way out of those.

The cheaper fix is yield: at a 25k floor with an under-50k follower ceiling this
feed kept 22 of 300, and dropping the ceiling alone took it to 74. Above roughly
a quarter, pages stay full enough that the sentinel keeps moving on its own and
the dead-end stops happening.

**Below-bar filler.** A page filtered to nothing gives X nothing to render and
nothing to scroll, so it stops asking for more. `minPerPage` (default 2) puts
the highest-view rejects back rather than let the feed end. These are genuinely
below your bar, so the counter names them separately: "2 below bar". Set the
dial to none for a strict feed, accepting the occasional dead end.

**Turn on logging when something looks wrong.** The settings page has a debug
toggle; with it on, every timeline response prints what it contained and what
survived, prefixed `[xlf]`, in the DevTools console on x.com. Every failure path
in this extension is silent by design, which makes an unfiltered feed and a
crashed filter look identical without it.

**Counts are per-surface.** The corner counter resets on route changes.

## Testing the classifier without a browser

The classifier hangs off `self.XLF` in `src/scoring.js`, is shared by both the
API and DOM paths, and has no dependency on `chrome.*` or on a real DOM:

```js
global.self = global;
require("./src/scoring.js");
const cfg = self.XLF.buildConfig({});

self.XLF.judge(self.XLF.fromApi({
  __typename: "Tweet",
  views: { count: "120000" },
  legacy: { full_text: "Introducing our editor. Launching today", favorite_count: 900,
            bookmark_count: 40, extended_entities: { media: [{ type: "video" }] } },
}), cfg);   // → { keep: true, reason: "keep", stats: { ... } }
```

## Interface notes

The extension reads X's body background to pick between X's light, dim and
lights-out themes, since X exposes no theme class, and styles itself from tokens
scoped to that. It deliberately avoids X's own blue: extension chrome should be
identifiable at a glance rather than cosplaying as the site's UI.

The settings page holds only what you set once — keywords, what counts as a
post, where it runs, the query override, debugging. Anything you tune while
looking at results lives on the pill.

## Files

```
manifest.json
src/scoring.js       the classifier: keyword lists, the bars, the verdict
src/intercept.js     page world: filters posts out of the API response
src/content.js       isolated world: config bridge, pill, panel, ledger, gate
src/filter.css       the counter and the Explore gate
src/background.js    lock state, relock alarm, badge
popup/               status, launch searches, hold-to-unlock
options/             view floor, engagement rates, keywords
icons/make_icons.py  regenerates the PNGs, no dependencies
```

## License

MIT. See [LICENSE](LICENSE).
