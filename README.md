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
Home · 9 of 96 · 14 read          14 of them you had already read
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

**Whether you have already read it.** Covered on its own below, because it is
the gate that behaves least like the others.

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

## Posts you have already read

X re-serves the same posts relentlessly, and a bar that admits one post in eight
makes it worse: the survivors are the same handful of big posts every time.
Measured on a live feed, reloading the identical URL returned **100% the same
posts** — 4 of 4 on Top, 3 of 3 on Latest, and a third load later in the session
returned the same four again. The judged counts were identical too, so this is
X's own caching rather than the filter concentrating on the same survivors. So a
post retires. Two readings by default, adjustable from the panel, and after that
it is dropped from the response like anything else that fails a gate.

**Read means read.** The post's own article has to be at least half on screen
for 800ms, or — for a post taller than the window, which can never reach half —
showing enough of itself to fill 60% of the window. Measured on a live feed,
posts ran 204px to 684px against a 589px window, so the tallest topped out at a
0.86 ratio and the second rule is a guard rather than a fix for something seen
failing. It cannot cost anything: it only adds a way to qualify.
Not delivered, not rendered — on your screen, long enough to take in.
The first version of this counted deliveries instead, and that was wrong in both
directions at once: X hands over posts you never scroll to, while a post you
stare at for a minute counts once. Scrolling back up to something in the same
sitting is not a second reading either. Reloading and being served it again is,
which is the case the feature exists for.

Counting continues while the filter is paused. A pause shows you the raw feed,
and posts read during one have been read; not counting them would make pausing a
way to quietly reset the ledger.

**Identity is the post's id**, taken from `rest_id`, never the entry id. Entry
ids are a property of the response rather than the post: a conversation module
mints a fresh one per page, a promoted slot carries its own prefix, and the same
post arrives under different ids on home and in search. Keying on them split one
post's exposure across several counters, none of which ever reached two.

**The ledger lives in `localStorage`**, which is the only part of this worth
explaining. The interceptor runs in the page's world, inside a synchronous XHR
getter, and cannot await `chrome.storage`. The first timeline response of a page
load arrives before any async read can finish — so with the list published from
a storage callback, the top of the feed on a reload was always judged against an
empty list. That is precisely the page where repeats are noticed. `localStorage`
is shared with the page's origin and readable synchronously from both worlds, so
the list is in place before the first response lands. `chrome.storage.local`
still holds the durable copy, because x.com can clear its own storage and
twitter.com is a separate origin with a separate one.

Eight thousand posts are remembered, forgotten 45 days after their last
sighting, and the stalest go first when the cap is reached. The settings page
says roughly how many are held and clears them, and so does the panel.

**Clearing is recorded as a time, not an absence**, because emptying a map is
not enough to make a ledger go away. Another open tab is holding the whole thing
in memory and would merge it back over the emptied file within seconds; the
settings page usually opens with no x.com tab to talk to at all, and can only
reach the backup, which the next page load would load straight back. So a clear
writes a timestamp everywhere it can reach, and every ledger drops whatever it
holds when it sees one newer than its own. The count on the settings page is
labelled as approximate for the same reason — it reads the backup, which lags by
up to a minute — and the button is never disabled on the strength of it, since a
stale zero must not take away the only way to clear a ledger that is actually
holding hundreds.

**It can empty a page, and that is handled twice.** A page whose every post you
had already read has nothing to give X, and a page with nothing on it cannot be
scrolled, which ends the feed permanently. First the interceptor fetches the
next page itself. If that fails too, the strongest single repeat goes back — not
as filler, which is reserved for below-bar posts, but because one repeat beats a
timeline that has stopped.

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

Both keyword groups were rebuilt from **3,219 scraped viral demo posts** rather
than written from imagination, using the corpus in `~/projects/tooling/x-demo-scraper`.
The hand-written originals did not survive contact with the data:

| | coverage of 3,219 viral demo posts |
| --- | --- |
| original launch phrases (any match) | 8.0% |
| original query (phrases AND product) | 2.7% |
| **rebuilt query** | **21.3%** |

`"launching today"` matched **one** post out of 3,219. `"just shipped"` added
nothing at all. Meanwhile the words these posts actually use — `built` (397
hits), `build` (297), `made` (118), `"it's called"` (33) — were missing
entirely. The same was true of the client-side launch list: eleven of its
seventy terms matched nothing, and rebuilding took its coverage from 30% to 43%.

The corpus skews toward AI and dev-tool demos, which is the intended target, so
terms like `agent` and `model` are deliberate.

The query ANDs two groups: action words, and product vocabulary. The second
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
| corpus-rebuilt query, Top | **5 of 5 kept**, at 341k–7.9M views |

That last run returned 452k, 98k, 75k, 29k and 5.1k view posts, led by
"Introducing OpenSEO, the open source alternative" — against a home feed where
roughly one post in eight clears even 50k views.

Sorting defaults to Top rather than Latest. Latest gets flooded by whatever news
cycle is running, which is how the Iran stories got in.

### The window moves

Retiring posts and a fixed query work against each other. One query sorted by
Top is a nearly static ranking: it returns the same page every visit, the ledger
correctly retires all of it, and the feed goes blank. Dedupe alone converts a
repetitive feed into an empty one.

So each trip into the feed asks for a different stretch of days — the last two,
then two to five back, five to ten, ten to twenty-one, then no window at all —
rotating in that order and persisting across visits.

The window is the only lever that was measured to work. Against the base query's
results on a live page:

| variant | overlap with the base query |
| --- | --- |
| `since:` / `until:` over a three-day window | **0 of 4** |
| `since_time:` / `until_time:`, same window | **0 of 4** |
| `min_faves` dropped from 400 to 50 | 4 of 4 |
| `min_faves` removed entirely | 4 of 4 |
| Latest instead of Top | 2 of 3 |

Both date forms are honoured and both return a completely disjoint set. Moving
`min_faves` does nothing visible, because the view floor selects the same top
posts regardless of where the like floor sits. Rewording the terms reshuffles.
Only the calendar actually moves the feed.

The unwindowed query, which repeats the most, comes round least often.

The shipped rotation was then checked as it is generated, against live results:
three consecutive windows returned four posts each, none of them empty, and
**11 of the 12 were distinct**. The one duplicate sat on the boundary between
two adjacent windows — and the ledger catches that one, which is the point of
having both.

Off with a single checkbox, and ignored entirely when you write your own query.

## Where it applies

- **Home timeline**: always filtered, both For You and Following.
- **Explore and Trending**: blocked outright, behind a search box.
- **Search and profiles**: untouched by default. Searching is the deliberate
  behaviour this is trying to push you back toward. Both can be filtered from
  settings.
- **A search you typed**: never filtered by the feed setting alone. Turning the
  search feed on used to filter every search invisibly, and the pill did not
  appear to say so because it used a stricter test than the filter did. That was
  survivable when the only consequence was a high bar. It is not once posts
  retire — looking up something you read yesterday would come back empty and
  look like X had lost it. The page world is now handed the exact queries that
  count as the feed, so the two tests agree.

**The feed is identified with the date window stripped off.** Comparing whole
queries put a clock inside the test: the window is rebuilt from `Date.now()`, so
at UTC midnight every generated query changed while an open tab kept the one it
was loaded with. Nothing matched, the surface stopped counting as the feed, and
that tab quietly served everything unfiltered for the rest of its life, with no
pill to say so. A tab restored by Chrome from a previous session had the same
problem from the moment it opened. What identifies the feed is everything except
the window.

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
  and is kept or dropped whole: kept if any post in it qualifies, and retired
  on its root post, the one you actually read.
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
- **Repeats come back** → first check whether `localStorage["xlf.seen"]` is
  growing at all. If it is empty after a session, `tweetIdOf()` has stopped
  resolving posts: **X sets `role="link"` on the permalink anchor itself**, so
  `a.closest('[role="link"]')` matches the anchor and rejects every post on the
  page. The walk has to start at `a.parentElement`. That exact mistake shipped
  once and recorded zero impressions while looking perfectly healthy, because
  the pill counts what the API sent, not what you read. Then check whether
  `rest_id` still sits at
  `content.itemContent.tweet_results.result.rest_id`. Note that a conversation
  module's entry id is derived from its **last** item, not its root, so it
  changes when a different reply is attached — which is why nothing here keys on
  entry ids.
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
page usually keeps growing on its own. This works on home, where a page came
back with 35 entries; **search appears to cap it at 20** regardless of what is
asked for, so inflation does not relieve starvation on the surface that needs it
most. Rewriting `variables` is well precedented
— Control Panel for Twitter does exactly this in production to force reply
sorting — and it leaves method and path alone, so X's request signature stays
valid. It is unverified against X's server, so it backs itself out: the first
inflated request that returns anything unusable disables inflation for the rest
of the session and every later request goes out exactly as X wrote it.

**Rescue a dead-ended feed.** When a page still keeps nothing, the interceptor
fetches the next page itself and hands X a response worth rendering. This was
unreachable for its whole life until 1.1.0 — it read `url` and `headers` off the
XHR, which has neither — and nothing noticed, because every failure path in that
file is silent by design.

**It is now opt-in, and off by default.** Fixing it revealed that **X has since
closed the door it walked through**.
Replaying a captured request now needs `x-client-transaction-id`, and that
header is effectively single-use: measured live, the exact captured URL returns
200 once and 404 on every replay after it, while omitting the header is a 404
outright. The reasoning that once made the empty-page case unconditional — blocking
briefly beats a feed that has stopped — assumed the fetch could work. It cannot,
so what is left is a synchronous request that buys nothing, and a synchronous
XHR cannot be given a timeout: a hung request is a hung tab. The code is kept,
behind the same switch as the thin-page case, because X's requirements move. It
also stands itself down after a single failure.

**A page is never handed back empty**, whatever keep-alive is set to. Keep-alive
off means "accept the occasional thin page"; it cannot mean accept an empty one,
because a page with no posts is shorter than the viewport, so there is no scroll
gesture to make, X is never asked for more, and the feed is over until you
reload by hand. Nobody expressed that preference. One post is the difference
between a thin feed and no feed, and it costs nothing on the network.

So the anti-starvation story rests on the rotation and the filler rather than on
fetching ahead. With the rescue switched on, it covers both an empty page and a
thin one (fewer than two posts kept). The response getter is synchronous, so the
fetch is a synchronous XHR, capped at three extra pages for an empty page and
two for a thin one, failing open on any error, and it only ever advances X's
cursor to a page it actually consumed.

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

**Reloading the extension stops open tabs.** Chrome orphans content scripts
already running, so filtering stops, the ledger stops recording, and nothing in
that tab can reach storage again. The pill stays put and says
`Extension reloaded · refresh` rather than vanishing, because a pill that simply
disappears reads as a crash. Clicking it reloads the page.

**Two tabs under-count rather than over-count.** They share one `localStorage`
and merge on write by taking the larger count, so a post both tabs saw
independently registers one reading, not two. The other direction would retire
posts you never read, which is the worse failure.

## Tests

```
node test/run.js
```

They run in Node with no browser and no dependencies.
`test/harness.js` builds enough of x.com to load both halves of the extension
into separate `vm` contexts that share one document and one `localStorage` —
which is how Chrome arranges them, and where every bug in the repeat feature
lived. The suite drives real timeline payloads through the patched XHR getter
and real viewport events through the impression observer, so it covers the
handoff rather than each side's arithmetic.

One of them just compares the three default tables — `scoring.js`,
`background.js` and the fallbacks in `content.js` — key by key. That is not
ceremony: `content.js` cannot import `scoring.js`, because Chrome injects a file
into one world only, so its defaults are a hand copy. A key present in one and
missing in the other reads as `undefined`, which is falsy, which silently
disables whatever it gates. That is exactly how retiring posts came to be dead
code for its entire life.

## Testing the classifier without a browser

The classifier hangs off `self.XLF` in `src/scoring.js` and has no dependency on
`chrome.*` or on a real DOM:

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
src/content.js       isolated world: config bridge, pill, panel, ledgers, gate
src/filter.css       the counter and the Explore gate
src/background.js    lock state, relock alarm, badge
popup/               status, launch searches, pause
options/             keywords, where it runs, the search query, the read ledger
test/                a fake x.com, both worlds, no dependencies
icons/make_icons.py  regenerates the PNGs, no dependencies
```

## License

MIT. See [LICENSE](LICENSE).
