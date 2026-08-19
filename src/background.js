// Owns the lock state. The filter is on by default and returns on its own:
// an unlock is always a fixed-length lease, never a permanent switch.

const DEFAULTS = {
  enabled: true,
  unlockUntil: 0,
  minViews: 50000,
  minLikeRate: 0,
  minBookmarkRate: 0,
  maxFollowers: 0,
  minPerPage: 2,
  topUp: false,
  pageSize: 60,
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
  // Use X's own server-side search as the feed instead of the algorithmic
  // timeline. The server does the coarse filtering, so what arrives is
  // mostly good and our gates drop a little rather than nearly everything.
  searchFeed: false,
  searchLatest: false,
  searchVideoOnly: false,
  searchQuery: "",
  history: [],
};

const RELOCK_ALARM = "xlf-relock";
const TICK_ALARM = "xlf-tick";

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({ ...DEFAULTS, ...stored });
  refresh();
});

chrome.runtime.onStartup.addListener(refresh);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === RELOCK_ALARM) await relock();
  if (alarm.name === TICK_ALARM) refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ("unlockUntil" in changes || "enabled" in changes)) refresh();
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === "unlock") {
    unlock(msg.minutes).then(() => respond({ ok: true }));
    return true;
  }
  if (msg?.type === "openOptions") {
    chrome.runtime.openOptionsPage();
    respond({ ok: true });
    return true;
  }
  if (msg?.type === "relock") {
    relock().then(() => respond({ ok: true }));
    return true;
  }
});

async function unlock(minutes) {
  const until = Date.now() + minutes * 60_000;
  const { history = [] } = await chrome.storage.local.get({ history: [] });
  history.unshift({ at: Date.now(), minutes });
  await chrome.storage.local.set({ unlockUntil: until, history: history.slice(0, 40) });
  chrome.alarms.create(RELOCK_ALARM, { when: until });
  chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  refresh();
}

async function relock() {
  await chrome.storage.local.set({ unlockUntil: 0, enabled: true });
  chrome.alarms.clear(RELOCK_ALARM);
  chrome.alarms.clear(TICK_ALARM);
  refresh();
}

// Badge: minutes of raw feed left, or nothing at all while filtering.
async function refresh() {
  const { unlockUntil = 0, enabled = true } = await chrome.storage.local.get(DEFAULTS);
  const left = unlockUntil - Date.now();
  if (left > 0) {
    chrome.action.setBadgeText({ text: String(Math.max(1, Math.ceil(left / 60_000))) });
    chrome.action.setBadgeBackgroundColor({ color: "#ff3b30" });
  } else if (enabled) {
    chrome.action.setBadgeText({ text: "" });
  } else {
    chrome.action.setBadgeText({ text: "off" });
    chrome.action.setBadgeBackgroundColor({ color: "#6b6b74" });
  }
}
