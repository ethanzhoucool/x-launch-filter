# X Launch Filter

X Launch Filter is an unpacked MV3 Chrome extension that reduces the X home
timeline to high-reach launch and product posts. Everything else in the feed is
hidden while it runs. It is for people who open X for product news and lose an
hour to the feed instead.

Turning the filter off is deliberately slow. There is no one-click switch.

## Install

1. Clone or download this folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the folder.
4. Open `x.com/home`. A counter in the bottom-left corner reports how many posts
   were kept and how many were hidden.

## How a post is judged

Three things are dropped before anything is scored: promoted posts, replies, and
anything matching a built-in noise list (politics, engagement bait, crypto,
assorted time sinks).

What survives has to clear two gates.

**A view floor.** 50,000 views by default, configurable from 10k to 500k. The
count is read from the engagement bar's `aria-label`, which carries the exact
number rather than the abbreviated one drawn on screen.

**A launch score.** A weighted score that has to reach 2:

| signal | weight |
| --- | --- |
| launch or product keyword | 2 |
| native video | 1 |
| link card | 1 |
| photo | 0.5 |

A keyword alone passes. So does a wordless demo video that links out to the
product. A video with nothing else does not.

Both keyword lists are editable in the settings page, and your terms are added to
the built-ins rather than replacing them.

## Where it applies

- **Home timeline**: always filtered.
- **Explore and Trending**: blocked outright, behind a search box.
- **Search and profiles**: untouched by default. Searching is the deliberate
  behaviour this is trying to push you back toward, so it stays out of the way.
  Both can be filtered from settings if you want them filtered.

The popup also carries four one-click launch searches built from X's advanced
operators. X search has no `min_views` operator, so those queries use
`min_faves:` as the reach proxy.

## Turning it off

The popup runs a gauntlet, in this order:

1. Three honesty questions. Each one has an answer that ends the run.
2. A typed reason, at least 30 characters.
3. A sentence typed out by hand. Pasting is blocked.
4. A 20-second cooldown.
5. A duration: 5, 15 or 30 minutes.
6. A four-second press and hold.

The unlock is a fixed-length lease, never a permanent switch. The filter relocks
itself on an alarm when the time is up. Progress through the gauntlet is saved,
so closing the popup partway through resumes rather than restarts.

Settings are read-only while the filter is on. Dropping the view floor to 10k
would otherwise be an unlock with none of the friction, so changing settings
takes the same route as any other unlock.

This is friction, not a prison. It can still be disabled from
`chrome://extensions`.

## The virtualised timeline problem

Hiding a post in X's timeline is not as simple as `display: none`. This is the
part that took measuring on a live x.com session, and the part to re-check if X
ships a timeline rewrite.

Each post wrapper (`div[data-testid="cellInnerDiv"]`) is `position: absolute`
with a cached `transform: translateY(...)`. Those offsets are computed once and
stored. They are not derived from layout.

Three measurements on a live timeline:

- Hiding one wrapper with `display: none` left every sibling's `translateY`
  byte-for-byte identical. The list does not reflow, so a hidden post leaves a
  permanent hole where it used to be.
- Collapsing a wrapper's contents to zero height did not move siblings either.
  The wrapper's own height went from 645px to 0px and nothing around it shifted.
- The parent sizer reserves scroll space with `min-height` (observed at
  11497.5px), not a fixed `height`.

The third measurement is the opening. Because the reserved scroll space is a
floor rather than a fixed number, the wrappers can be pulled out of absolute
positioning without starving the scroller. Forcing them to `position: relative`
with `transform: none` puts them into normal flow, where they close ranks
around a hidden sibling. Measured across eight cells, the gap was zero.

That is one rule in `src/filter.css`, gated on `html.xlf-flow`, and it is applied
only while the filter is actually running:

```css
html.xlf-flow [aria-label^="Timeline: "] > div > div[data-testid="cellInnerDiv"] {
  position: relative !important;
  transform: none !important;
  top: auto !important;
  left: auto !important;
}
```

If X changes and posts stop being filtered, look at the selectors in
`src/scoring.js` (`[role="group"][aria-label]` for views,
`[data-testid="tweetText"]`, `[data-testid="videoPlayer"]`). If gaps appear in
the feed instead, look at the layout takeover above and check whether the
wrappers' parent still sizes itself with `min-height`.

## Known limitations

**Very little survives.** The two gates multiply, and a normal feed is mostly
neither high-reach nor a launch. In one live sample, 0 of 5 posts passed. The
view counts read 29,468, 7,383, 20,338 and 7,758, all under the 50k floor before
the launch score even mattered. The column can legitimately go empty. Lowering
the floor in settings is the fix, and it is a real fix, not a workaround.

**Hidden posts do not give back their scroll space.** The parent's `min-height`
is what keeps the scroller alive, and nothing shrinks it when posts are hidden.
A heavily filtered feed therefore leaves a tall, mostly empty scroll region below
the posts that survived.

**The layout takeover fights the virtualiser.** Posts are put into normal flow
while X's virtualiser continues to recycle and reposition them. Content is
expected to shift upward as you scroll because of this. That is reasoned from the
measurements above, not something observed in a long scrolling session, so treat
it as a prediction rather than a report.

**Planned, not built:** filter X's timeline API response before its renderer ever
sees it, using a `world: "MAIN"` content script, and fetch extra pages when too
few posts survive a batch. That would remove the CSS layout takeover entirely and
take both limitations above with it. None of it exists yet.

## Testing the classifier without a browser

The classifier hangs off `self.XLF` in `src/scoring.js` and has no DOM dependency
beyond `querySelector`, so a stub object is enough to exercise `XLF.decide()` in
node:

```js
const fake = {
  querySelector: (sel) =>
    sel.includes("aria-label") ? { getAttribute: () => "12 replies, 40 likes, 84,000 views" } : null,
  querySelectorAll: () => [],
};
XLF.decide(fake, XLF.buildConfig({}));
```

## Files

```
manifest.json
src/scoring.js       the classifier: keyword lists, view parsing, the verdict
src/content.js       walks the timeline, hides cells, draws the counter and gate
src/filter.css       the layout takeover, the counter, the Explore gate
src/background.js    lock state, relock alarm, badge
popup/               status, launch searches, the unlock gauntlet
options/             thresholds and keywords, locked while the filter is on
icons/make_icons.py  regenerates the PNGs, no dependencies
```

## License

MIT. See [LICENSE](LICENSE).
