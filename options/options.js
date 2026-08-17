// Settings are editable only while the filter is unlocked. Otherwise dropping
// the view floor to zero would be an unlock that skips the whole gauntlet.

const BOOLS = [
  "requireLaunch",
  "hideAds",
  "hideReplies",
  "hideReposts",
  "blockExplore",
  "filterSearch",
  "filterProfiles",
  "showHud",
];
const TEXTS = ["extraInclude", "extraExclude"];

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
  const locked = stored.enabled && Date.now() >= (stored.unlockUntil || 0);

  document.getElementById("lockstate").textContent = locked
    ? "filter on — settings locked"
    : "filter off — settings editable";
  document.getElementById("notice").hidden = !locked;

  const minViews = document.getElementById("minViews");
  minViews.value = String(stored.minViews);
  minViews.disabled = locked;
  minViews.addEventListener("change", () => {
    chrome.storage.local.set({ minViews: Number(minViews.value) });
    flashSaved();
  });

  BOOLS.forEach((k) => {
    const el = document.getElementById(k);
    el.checked = !!stored[k];
    el.disabled = locked;
    el.addEventListener("change", () => {
      chrome.storage.local.set({ [k]: el.checked });
      flashSaved();
    });
  });

  TEXTS.forEach((k) => {
    const el = document.getElementById(k);
    el.value = stored[k] || "";
    el.disabled = locked;
    let t = 0;
    el.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        chrome.storage.local.set({ [k]: el.value });
        flashSaved();
      }, 400);
    });
  });

  document.getElementById("sum-include").textContent =
    `Launch signals (${self.XLF.INCLUDE.length})`;
  document.getElementById("sum-exclude").textContent =
    `Always dropped (${self.XLF.EXCLUDE.length})`;
  renderChips("list-include", self.XLF.INCLUDE);
  renderChips("list-exclude", self.XLF.EXCLUDE);
}

init();
