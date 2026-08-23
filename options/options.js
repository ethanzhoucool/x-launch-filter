// Freely editable, on purpose. Tuning the bars is the main thing you do with
// this extension, and locking that behind the unlock made experimenting worse
// without making the filter meaningfully harder to defeat.

const NUMS = ["pageSize", "hideSeenAfter"];
const BOOLS = [
  "hideAds",
  "hideReplies",
  "hideReposts",
  "blockExplore",
  "filterSearch",
  "filterProfiles",
  "showHud",
  "debug",
  "topUp",
  "searchLatest",
  "searchVideoOnly",
  "searchRotate",
];
const TEXTS = ["extraInclude", "extraExclude", "searchQuery"];

const savedEl = document.getElementById("saved");
let saveTimer = 0;

function flashSaved() {
  savedEl.textContent = "Saved";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => (savedEl.textContent = ""), 1400);
}

function renderChips(id, terms) {
  const box = document.getElementById(id);
  box.replaceChildren();
  terms.forEach((t) => {
    const s = document.createElement("span");
    s.className = "chip";
    s.textContent = t;
    box.appendChild(s);
  });
}

async function init() {
  const stored = await chrome.storage.local.get(self.XLF.DEFAULTS);
  const on = stored.enabled && Date.now() >= (stored.unlockUntil || 0);

  document.getElementById("lockstate").textContent = on
    ? "filter on"
    : "filter off — changes apply when it comes back on";

  NUMS.forEach((k) => {
    const el = document.getElementById(k);
    el.value = String(stored[k] ?? 0);
    el.addEventListener("change", () => {
      chrome.storage.local.set({ [k]: Number(el.value) });
      flashSaved();
    });
  });

  BOOLS.forEach((k) => {
    const el = document.getElementById(k);
    el.checked = !!stored[k];
    el.addEventListener("change", () => {
      chrome.storage.local.set({ [k]: el.checked });
      flashSaved();
    });
  });

  TEXTS.forEach((k) => {
    const el = document.getElementById(k);
    el.value = stored[k] || "";
    let t = 0;
    el.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        chrome.storage.local.set({ [k]: el.value });
        flashSaved();
      }, 400);
    });
  });

  // The authoritative ledger lives in x.com's own localStorage; this is the
  // backup, and it lags by up to a minute. So the count is approximate and the
  // button is never disabled on the strength of it — a stale zero here must not
  // take away the only way to clear a ledger that is actually holding hundreds.
  const countEl = document.getElementById("seen-count");
  const forgetEl = document.getElementById("forget-seen");
  const { seen = {} } = await chrome.storage.local.get({ seen: {} });
  const n = Object.keys(seen).length;
  countEl.textContent = n
    ? `Remembering about ${n} post${n === 1 ? "" : "s"} you have read.`
    : "Nothing recorded yet.";
  forgetEl.addEventListener("click", async () => {
    // The timestamp is what makes this work. This page usually opens with no
    // x.com tab to talk to, so clearing the backup alone would be undone the
    // moment a tab loaded its own copy back. Every ledger checks this stamp and
    // drops anything older than it.
    await chrome.storage.local.set({ seen: {}, seenClearedAt: Date.now() });
    const tabs = await chrome.tabs.query({
      url: ["*://x.com/*", "*://www.x.com/*", "*://twitter.com/*", "*://www.twitter.com/*"],
    });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "forgetSeen" })
        .catch(() => { /* no content script in that tab */ });
    }
    countEl.textContent = "Forgotten.";
    flashSaved();
  });

  document.getElementById("sum-include").textContent =
    `Launch signals (${self.XLF.INCLUDE.length})`;
  document.getElementById("sum-exclude").textContent =
    `Always dropped (${self.XLF.EXCLUDE.length})`;
  renderChips("list-include", self.XLF.INCLUDE);
  renderChips("list-exclude", self.XLF.EXCLUDE);
}

init();
