const stage = document.getElementById("stage");
const statusEl = document.getElementById("status");

// One deliberate action, not a gauntlet. X is a work surface here, and the
// failure mode this guards against is a reflex, not a binge — a press-and-hold
// is enough to make turning it off a decision rather than a twitch.
const HOLD_MS = 1500;
const DURATIONS = [15, 30, 60];

// X search has no min_views operator, so min_faves is the closest server-side
// proxy for reach. These run the search the feed was supposed to replace.
const RADAR = [
  {
    label: "Launch videos",
    hint: "shipped / launched, with native video",
    q: '(launching OR launched OR "just shipped" OR introducing) filter:native_video min_faves:1000 -filter:replies lang:en',
  },
  {
    label: "Product demos",
    hint: "people showing the thing working",
    q: '(demo OR "built this" OR "watch this") filter:native_video min_faves:500 -filter:replies lang:en',
  },
  {
    label: "Built in public",
    hint: "indie launches with media",
    q: '("build in public" OR "built in public" OR "my new" OR "side project") filter:media min_faves:500 -filter:replies lang:en',
  },
  {
    label: "Product Hunt",
    hint: "today's launch chatter",
    q: '("product hunt" OR producthunt) min_faves:200 -filter:replies lang:en',
  },
];

let timers = [];
let chosen = DURATIONS[0];

const clearTimers = () => {
  timers.forEach(clearInterval);
  timers = [];
};

function render(html, wire) {
  clearTimers();
  stage.innerHTML = html;
  if (wire) wire();
}

const on = (sel, evt, fn) => stage.querySelector(sel)?.addEventListener(evt, fn);
const fmt = (ms) => {
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
};

const radarHtml = () =>
  `<div class="radar">${RADAR.map(
    (r, i) =>
      `<button class="ghost" data-radar="${i}">${r.label}<span class="q">${r.hint}</span></button>`
  ).join("")}</div>`;

function wireRadar() {
  stage.querySelectorAll("[data-radar]").forEach((b) =>
    b.addEventListener("click", () => {
      const r = RADAR[Number(b.dataset.radar)];
      chrome.tabs.create({
        url: "https://x.com/search?q=" + encodeURIComponent(r.q) + "&f=top",
      });
      window.close();
    })
  );
}

/* ---------- screens ---------- */

async function showStatus() {
  const { unlockUntil = 0, history = [], minViews = 50000, minLikeRate = 0,
          minBookmarkRate = 0 } = await chrome.storage.local.get({
    unlockUntil: 0, history: [], minViews: 50000, minLikeRate: 0, minBookmarkRate: 0,
  });
  const left = unlockUntil - Date.now();

  if (left > 0) {
    statusEl.textContent = "off";
    render(
      `<h2>The raw feed is open.</h2>
       <div class="count" id="left">${fmt(left)}</div>
       <p class="tiny">It filters itself back on when this runs out.</p>
       <button class="danger" id="relock">Turn the filter back on</button>`,
      () => {
        const el = stage.querySelector("#left");
        timers.push(
          setInterval(() => {
            const rem = unlockUntil - Date.now();
            if (rem <= 0) return showStatus();
            el.textContent = fmt(rem);
          }, 1000)
        );
        on("#relock", "click", async () => {
          await chrome.runtime.sendMessage({ type: "relock" });
          showStatus();
        });
      }
    );
    return;
  }

  statusEl.textContent = "on";
  const today = history.filter((h) => Date.now() - h.at < 86_400_000).length;
  const bars = [`${Math.round(minViews / 1000)}k+ views`];
  if (minLikeRate > 0) bars.push(`${minLikeRate}%+ likes`);
  if (minBookmarkRate > 0) bars.push(`${minBookmarkRate}%+ bookmarks`);

  render(
    `<h2>Filtering to launch posts.</h2>
     <p>${bars.join(" · ")}. Failing posts are dropped from the response before X renders them.</p>
     ${today ? `<p class="tiny"><span class="badge">${today} unlock${today > 1 ? "s" : ""} today</span></p>` : ""}
     <p class="tiny">Go straight to the good stuff:</p>
     ${radarHtml()}
     <button class="link" id="start">Turn the filter off for a bit</button>`,
    () => {
      wireRadar();
      on("#start", "click", showUnlock);
    }
  );
}

function showUnlock() {
  render(
    `<h2>How long?</h2>
     <p>It turns itself back on when the time is up.</p>
     <div class="row" id="durations">
       ${DURATIONS.map(
         (m) =>
           `<button class="ghost${m === chosen ? " on" : ""}" data-min="${m}">${m}m</button>`
       ).join("")}
     </div>
     <button class="hold" id="hold"><span class="fill"></span><span>Hold to turn off</span></button>
     <button class="link" id="cancel">Never mind</button>`,
    () => {
      stage.querySelectorAll("[data-min]").forEach((b) =>
        b.addEventListener("click", () => {
          chosen = Number(b.dataset.min);
          stage.querySelectorAll("[data-min]").forEach((x) =>
            x.classList.toggle("on", Number(x.dataset.min) === chosen)
          );
        })
      );

      const btn = stage.querySelector("#hold");
      const fill = btn.querySelector(".fill");
      const label = btn.querySelectorAll("span")[1];
      let start = 0;
      let raf = 0;

      const step = () => {
        const pct = Math.min(100, ((Date.now() - start) / HOLD_MS) * 100);
        fill.style.width = pct + "%";
        if (pct >= 100) return finish();
        raf = requestAnimationFrame(step);
      };
      const begin = (e) => {
        e.preventDefault();
        start = Date.now();
        label.textContent = "Keep holding…";
        raf = requestAnimationFrame(step);
      };
      const abort = () => {
        cancelAnimationFrame(raf);
        fill.style.width = "0%";
        label.textContent = "Hold to turn off";
      };
      const finish = async () => {
        cancelAnimationFrame(raf);
        label.textContent = "Opening…";
        await chrome.runtime.sendMessage({ type: "unlock", minutes: chosen });
        showStatus();
      };

      btn.addEventListener("mousedown", begin);
      btn.addEventListener("mouseup", abort);
      btn.addEventListener("mouseleave", abort);
      on("#cancel", "click", showStatus);
    }
  );
}

document.getElementById("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

showStatus();
