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
4. Open `x.com/home`. A counter in the bottom-left corner reports how many posts
   were kept and how many were dropped.

Click that counter to change the view floor and the engagement rates without
leaving the page. Saving reloads the tab, because the posts already on screen
were filtered on the way in and cannot be re-judged without refetching them.

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

## Where it applies

- **Home timeline**: always filtered, both For You and Following.
- **Explore and Trending**: blocked outright, behind a search box.
- **Search and profiles**: untouched by default. Searching is the deliberate
  behaviour this is trying to push you back toward. Both can be filtered from
  settings.

The popup also carries four one-click launch searches built from X's advanced
operators. X search has no `min_views` operator, so those queries use
`min_faves:` as the reach proxy.

## Turning it off

Pick a duration and hold a button for a second and a half. That is the whole
thing. The unlock is a fixed-length lease: the filter turns itself back on when
the time is up, and the badge counts down the minutes.

The friction is deliberately light. This is a work surface, and the failure mode
it guards against is a reflex rather than a binge.

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

**The feed is fed by reading ahead.** X's "load more" is driven by rendered
content, so a page filtered down to nothing is a dead end. Measured: with an
empty timeline, scrolling to the bottom eight times produced zero further
timeline requests, and the feed simply ended.

So while X renders one page, the interceptor quietly pulls the next few over the
same cursor, keeps the posts that qualify, and banks them for X's next request.
X's own cursor is rewritten to match how far the read-ahead got, so it never
refetches ground already covered, and delivered posts are tracked so nothing
appears twice. Replaying X's own signed headers on a cursor URL is what makes
this possible: verified live, it returns 200 with a further cursor.

**Below-bar filler, when even that is not enough.** If a page still comes up
empty, `minPerPage` (default 2) puts the highest-view rejects back rather than
let the feed die. These are genuinely below your bar, so the counter names them:
"2 below bar". Set the dial to none if you would rather have the dead end than
the dilution. At a strict setting — a 50k floor plus a 1% like rate plus launch
signals — expect this to fire, because on a measured page only about one post in
eight clears 50k views before the other gates apply.

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

## Files

```
manifest.json
src/scoring.js       the classifier: keyword lists, the bars, the verdict
src/intercept.js     page world: filters posts out of the API response
src/content.js       isolated world: config bridge, counter, Explore gate
src/filter.css       the counter and the Explore gate
src/background.js    lock state, relock alarm, badge
popup/               status, launch searches, hold-to-unlock
options/             view floor, engagement rates, keywords
icons/make_icons.py  regenerates the PNGs, no dependencies
```

## License

MIT. See [LICENSE](LICENSE).
