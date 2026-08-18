// The off-site remote: the only surface reachable when you are not on x.com.
// It does not tune anything — that happens at the pill, next to the results it
// affects. Here you can see state, jump into the feed, and pause.
//
// The hold-to-unlock ceremony this used to run is gone. It began as a
// discipline gate borrowed from a YouTube blocker, but this became a research
// tool that gets tuned constantly, and the ceremony only taxed the tuning. What
// does the work is the lease: a pause always re-arms itself, which is enough to
// defeat a reflex without asking for a performance.

const stage = document.getElementById("stage");
const statusEl = document.getElementById("status");

const PAUSES = [15, 30, 60];

const RADAR = [
  { label: "Launch videos", hint: "shipped or launched, with native video",
    q: '(launching OR launched OR "just shipped" OR introducing) filter:native_video min_faves:1000 -filter:replies lang:en' },
  { label: "Product demos", hint: "people showing the thing working",
    q: '(demo OR "built this" OR "watch this") filter:native_video min_faves:500 -filter:replies lang:en' },
  { label: "Built in public", hint: "indie launches with media",
    q: '("build in public" OR "built in public" OR "my new" OR "side project") filter:media min_faves:500 -filter:replies lang:en' },
  { label: "Product Hunt", hint: "today's launch chatter",
    q: '("product hunt" OR producthunt) min_faves:200 -filter:replies lang:en' },
];

let timers = [];
const clearTimers = () => { timers.forEach(clearInterval); timers = []; };

function render(html, wire) {
  clearTimers();
  stage.innerHTML = html;
  if (wire) wire();
}
const on = (sel, evt, fn) => stage.querySelector(sel)?.addEventListener(evt, fn);

const clock = (ms) => {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
};

const radarHtml = () =>
  `<div class="radar">${RADAR.map((r, i) =>
    `<button class="ghost" data-radar="${i}">${r.label}<span class="q">${r.hint}</span></button>`
  ).join("")}</div>`;

function wireRadar() {
  stage.querySelectorAll("[data-radar]").forEach((b) =>
    b.addEventListener("click", () => {
      chrome.tabs.create({
        url: "https://x.com/search?q=" + encodeURIComponent(RADAR[Number(b.dataset.radar)].q) + "&f=top",
      });
      window.close();
    })
  );
}

async function show() {
  const { unlockUntil = 0, searchFeed = false } =
    await chrome.storage.local.get({ unlockUntil: 0, searchFeed: false });
  const left = unlockUntil - Date.now();

  if (left > 0) {
    statusEl.textContent = "paused";
    render(
      `<h2>Paused</h2>
       <div class="count" id="left">${clock(left)}</div>
       <p class="tiny">It starts filtering again on its own.</p>
       <button class="primary" id="resume">Resume now</button>
       <p class="tiny">Go direct:</p>
       ${radarHtml()}`,
      () => {
        const elLeft = stage.querySelector("#left");
        timers.push(setInterval(() => {
          const rem = unlockUntil - Date.now();
          if (rem <= 0) return show();
          elLeft.textContent = clock(rem);
        }, 1000));
        on("#resume", "click", async () => {
          await chrome.runtime.sendMessage({ type: "relock" });
          show();
        });
        wireRadar();
      }
    );
    return;
  }

  statusEl.textContent = searchFeed ? "search feed" : "home feed";
  render(
    `<h2>Filtering the ${searchFeed ? "search" : "home"} feed.</h2>
     <p>Set the bar from the pill on x.com, where you can see what each change would keep.</p>
     <button class="primary" id="open">Open the feed</button>
     <p class="tiny">Go direct:</p>
     ${radarHtml()}
     <div class="pause">
       <span class="tiny">Pause</span>
       ${PAUSES.map((m) => `<button class="chip" data-min="${m}">${m}m</button>`).join("")}
     </div>`,
    () => {
      on("#open", "click", () => {
        chrome.tabs.create({ url: "https://x.com/home" });
        window.close();
      });
      wireRadar();
      stage.querySelectorAll("[data-min]").forEach((b) =>
        b.addEventListener("click", async () => {
          await chrome.runtime.sendMessage({ type: "unlock", minutes: Number(b.dataset.min) });
          show();
        })
      );
    }
  );
}

document.getElementById("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

show();
