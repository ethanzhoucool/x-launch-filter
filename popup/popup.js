const stage = document.getElementById("stage");
const statusEl = document.getElementById("status");

const SENTENCE = "I am choosing to scroll the raw feed instead of doing my work";
const COOLDOWN_MS = 20_000;
const HOLD_MS = 4000;
const PROGRESS_TTL = 10 * 60_000;

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

const QUESTIONS = [
  {
    q: "Is there a specific post, product or account you came here for?",
    stopLabel: "No, I just want to scroll",
    goLabel: "Yes, something specific",
    stop: "Then this is the reflex, not the research. Close the tab.",
  },
  {
    q: "Could you find it with search instead of the feed?",
    stopLabel: "Probably, yes",
    goLabel: "No, I need to browse",
    stop: "Then search for it. The feed is the slowest possible path to a thing you can name.",
  },
  {
    q: "In thirty minutes, will this have been worth it?",
    stopLabel: "Honestly, probably not",
    goLabel: "Yes, this is real work",
    stop: "Believe yourself. The filtered feed is still there.",
  },
];

let timers = [];
let session = { reason: "", cooldownStart: 0, minutes: 0 };

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
const normalize = (s) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const fmt = (ms) => {
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
};

async function saveProgress(step) {
  await chrome.storage.local.set({ progress: { step, ...session, ts: Date.now() } });
}
const clearProgress = () => chrome.storage.local.remove("progress");

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
  clearProgress();
  const { unlockUntil = 0, history = [], minViews = 50000 } =
    await chrome.storage.local.get({ unlockUntil: 0, history: [], minViews: 50000 });
  const left = unlockUntil - Date.now();

  if (left > 0) {
    statusEl.textContent = "off";
    render(
      `<h2>The raw feed is open.</h2>
       <div class="count" id="left">${fmt(left)}</div>
       ${history[0]?.reason ? `<p class="tiny">You said: "${escapeHtml(history[0].reason)}"</p>` : ""}
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
  const last = history[0];
  const k = Math.round(minViews / 1000);
  render(
    `<h2>Only ${k}k+ launch posts get through.</h2>
     <p>Everything else in the timeline is hidden. Search and profiles still work normally.</p>
     ${today ? `<p class="tiny"><span class="badge">${today} unlock${today > 1 ? "s" : ""} today</span></p>` : ""}
     ${last ? `<p class="tiny">Last time: "${escapeHtml(last.reason)}" (${last.minutes} min)</p>` : ""}
     <p class="tiny">Go straight to the good stuff:</p>
     ${radarHtml()}
     <button class="link" id="start">I need to turn the filter off</button>`,
    () => {
      wireRadar();
      on("#start", "click", () => showQuestion(0));
    }
  );
}

function showQuestion(i) {
  const item = QUESTIONS[i];
  saveProgress(`q${i}`);
  render(
    `<p class="tiny">Step ${i + 1} of 6</p>
     <h2>${item.q}</h2>
     <div class="stack">
       <button class="ghost" id="stop">${item.stopLabel}</button>
       <button class="ghost" id="go">${item.goLabel}</button>
     </div>
     <button class="link" id="cancel">Never mind</button>`,
    () => {
      on("#stop", "click", () => showStop(item.stop));
      on("#go", "click", () =>
        i + 1 < QUESTIONS.length ? showQuestion(i + 1) : showReason()
      );
      on("#cancel", "click", showStatus);
    }
  );
}

function showStop(message) {
  render(
    `<h2>Alright.</h2>
     <p>${message}</p>
     ${radarHtml()}
     <button class="primary" id="ok">Close</button>
     <button class="link" id="back">Turn it off anyway</button>`,
    () => {
      wireRadar();
      on("#ok", "click", () => window.close());
      on("#back", "click", () => showQuestion(0));
    }
  );
}

function showReason() {
  saveProgress("reason");
  render(
    `<p class="tiny">Step 4 of 6</p>
     <h2>What are you looking for that the filter is hiding?</h2>
     <p>Be specific. "Inspiration" is not a plan. You'll see this again next time.</p>
     <textarea id="reason" rows="3" placeholder="e.g. the Linear release thread everyone quoted this morning">${escapeHtml(session.reason)}</textarea>
     <p class="tiny" id="counter"></p>
     <button class="primary" id="next" disabled>Continue</button>
     <button class="link" id="cancel">Never mind</button>`,
    () => {
      const ta = stage.querySelector("#reason");
      const next = stage.querySelector("#next");
      const counter = stage.querySelector("#counter");
      const check = () => {
        const n = ta.value.trim().length;
        counter.textContent = n < 30 ? `${30 - n} more characters` : "Good enough.";
        next.disabled = n < 30;
      };
      ta.addEventListener("input", check);
      check();
      ta.focus();
      on("#next", "click", () => {
        session.reason = ta.value.trim();
        showSentence();
      });
      on("#cancel", "click", showStatus);
    }
  );
}

function showSentence() {
  saveProgress("sentence");
  render(
    `<p class="tiny">Step 5 of 6</p>
     <h2>Type this out. Exactly.</h2>
     <div class="mono">${SENTENCE}</div>
     <input type="text" id="typed" placeholder="Type it here" autocomplete="off" spellcheck="false">
     <p class="tiny" id="hint">No pasting. That's the point.</p>
     <button class="primary" id="next" disabled>Continue</button>
     <button class="link" id="cancel">Never mind</button>`,
    () => {
      const input = stage.querySelector("#typed");
      const next = stage.querySelector("#next");
      input.addEventListener("paste", (e) => {
        e.preventDefault();
        stage.querySelector("#hint").textContent = "Nice try. Type it.";
      });
      input.addEventListener("input", () => {
        const ok = normalize(input.value) === normalize(SENTENCE);
        next.disabled = !ok;
        input.classList.toggle("good", ok);
        input.classList.toggle("bad", input.value.length > 10 && !ok);
      });
      input.focus();
      on("#next", "click", () => {
        session.cooldownStart = Date.now();
        showWait();
      });
      on("#cancel", "click", showStatus);
    }
  );
}

function showWait() {
  if (!session.cooldownStart) session.cooldownStart = Date.now();
  saveProgress("wait");
  render(
    `<p class="tiny">Step 6 of 6</p>
     <h2>Sit with it for a second.</h2>
     <div class="count" id="count"></div>
     <p>If the urge passes before this hits zero, that tells you something.</p>
     <button class="link" id="cancel">It passed. Never mind.</button>`,
    () => {
      const el = stage.querySelector("#count");
      const tick = () => {
        const left = session.cooldownStart + COOLDOWN_MS - Date.now();
        if (left <= 0) return showDuration();
        el.textContent = Math.ceil(left / 1000);
      };
      tick();
      timers.push(setInterval(tick, 200));
      on("#cancel", "click", showStatus);
    }
  );
}

function showDuration() {
  saveProgress("duration");
  render(
    `<h2>How long?</h2>
     <p>The filter comes back on by itself when the time is up.</p>
     <div class="stack">
       <button class="ghost" data-min="5">5 minutes</button>
       <button class="ghost" data-min="15">15 minutes</button>
       <button class="ghost" data-min="30">30 minutes</button>
     </div>
     <button class="link" id="cancel">Never mind</button>`,
    () => {
      stage.querySelectorAll("[data-min]").forEach((b) =>
        b.addEventListener("click", () => {
          session.minutes = Number(b.dataset.min);
          showFinal();
        })
      );
      on("#cancel", "click", showStatus);
    }
  );
}

function showFinal() {
  saveProgress("final");
  render(
    `<h2>Last one.</h2>
     <p>Hold the button for four seconds to open the raw feed for ${session.minutes} minutes.</p>
     <button class="hold" id="hold"><span class="fill"></span><span>Press and hold</span></button>
     <button class="link" id="cancel">Never mind</button>`,
    () => {
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
        label.textContent = "Press and hold";
      };
      const finish = async () => {
        cancelAnimationFrame(raf);
        label.textContent = "Opening…";
        await chrome.runtime.sendMessage({
          type: "unlock",
          minutes: session.minutes,
          reason: session.reason,
        });
        await clearProgress();
        session = { reason: "", cooldownStart: 0, minutes: 0 };
        showStatus();
      };

      btn.addEventListener("mousedown", begin);
      btn.addEventListener("mouseup", abort);
      btn.addEventListener("mouseleave", abort);
      on("#cancel", "click", showStatus);
    }
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/* ---------- resume ---------- */

async function init() {
  document.getElementById("settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // Popups close on any outside click; resume rather than restart the run.
  const { unlockUntil = 0, progress } = await chrome.storage.local.get({
    unlockUntil: 0,
    progress: null,
  });
  if (unlockUntil <= Date.now() && progress && Date.now() - progress.ts < PROGRESS_TTL) {
    session = {
      reason: progress.reason || "",
      cooldownStart: progress.cooldownStart || 0,
      minutes: progress.minutes || 0,
    };
    const step = progress.step;
    statusEl.textContent = "on";
    if (step?.startsWith("q")) return showQuestion(Number(step.slice(1)));
    if (step === "reason") return showReason();
    if (step === "sentence") return showSentence();
    if (step === "wait") return showWait();
    if (step === "duration") return showDuration();
    if (step === "final") return showFinal();
  }
  showStatus();
}

init();
