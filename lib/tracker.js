/*
 * Tracks the one review log tab that scans run in. The scan itself runs in the content script of that tab,
 * because only there the requests carry the session of the logged in user.
 *
 * The tracker { tabId, scanning } lives in the session storage area, so it survives the suspension of the
 * background page. The popup listens to changes of that key. Every read and write goes through one promise
 * chain, so events that arrive together cannot interleave.
 */

import { withTimeout } from "./util.js";

const KEY = "tracker";
const MATCHES = browser.runtime.getManifest().content_scripts.flatMap((c) => c.matches);

let chain = Promise.resolve();

function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

async function read() {
  const stored = await browser.storage.session.get(KEY);
  return stored[KEY] || null;
}

/** Keeps the invariant: scanning implies a tracked tab. */
async function write({ tabId, scanning }) {
  const value = { tabId: tabId ?? null, scanning: !!scanning && tabId != null };
  await browser.storage.session.set({ [KEY]: value });
  return value;
}

/** Tabs whose URL matches the pages the content script is injected into. */
async function reviewTabs(excludeId) {
  const tabs = await browser.tabs.query({ url: MATCHES });
  return tabs.filter((t) => t.id !== excludeId);
}

/** Prefers tabs that are loaded, then the most recently used one. */
function best(tabs) {
  const sorted = [...tabs].sort((a, b) => (Number(a.discarded) - Number(b.discarded)) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
  return sorted[0] || null;
}

async function reselect(excludeId) {
  const tab = best(await reviewTabs(excludeId));
  return write({ tabId: tab ? tab.id : null, scanning: false });
}

async function isValid(tabId) {
  return (await reviewTabs()).some((t) => t.id === tabId);
}

async function current() {
  return (await read()) || reselect();
}

const TAB_ANSWER_TIMEOUT_MS = 5000;

/** Null if the tab does not answer. A content script that never answers must not block the tracker chain. */
async function sendToTab(tabId, msg) {
  try {
    return await withTimeout(browser.tabs.sendMessage(tabId, msg), TAB_ANSWER_TIMEOUT_MS);
  } catch (e) {
    return null;
  }
}

/** Add-on start. Content scripts of an earlier run are gone, so no scan can be running. */
export function init() {
  return serial(() => reselect());
}

export function getTracker() {
  return serial(current);
}

export function onTabRemoved(tabId) {
  return serial(async () => {
    const t = await current();
    if (t.tabId === tabId) {
      await reselect(tabId);
    }
  });
}

/**
 * Tracked tab: a scan dies when the tab starts loading (reload, navigation) or is discarded.
 * No tracked tab: the first review tab that finishes loading is tracked.
 */
export function onTabUpdated(tabId, changeInfo) {
  return serial(async () => {
    const t = await current();
    if (t.tabId === tabId) {
      if (changeInfo.discarded) {
        await reselect(tabId);
      } else if (changeInfo.status === "loading" || changeInfo.url !== undefined) {
        if (await isValid(tabId)) {
          await write({ tabId, scanning: false });
        } else {
          await reselect(tabId);
        }
      }
    } else if (t.tabId === null && changeInfo.status === "complete" && (await isValid(tabId))) {
      await write({ tabId, scanning: false });
    }
  });
}

/** The scan is marked as running only after the content script has accepted it. */
export function startScan(options) {
  return serial(async () => {
    const t = await current();
    if (t.tabId === null) {
      throw new Error("There is no review log tab.");
    }
    if (t.scanning) {
      throw new Error("A scan is running already.");
    }
    const answer = await sendToTab(t.tabId, { cmd: "scan", ...options });
    if (!answer || answer.started !== true) {
      throw new Error("The log page does not answer. Reload it once.");
    }
    await write({ tabId: t.tabId, scanning: true });
  });
}

export function cancelScan() {
  return serial(async () => {
    const t = await current();
    if (t.tabId !== null) {
      await sendToTab(t.tabId, { cmd: "cancel" });
    }
  });
}

/** The content script of the tracked tab reports the end of its scan (done, cancelled or failed). */
export function scanEnded(tabId) {
  return serial(async () => {
    const t = await current();
    if (t.tabId === tabId && t.scanning) {
      await write({ tabId, scanning: false });
    }
  });
}

/** Repairs the tracker from the facts: is the tab still a review tab, is a scan running in it. */
export function reconcile() {
  return serial(async () => {
    let t = await current();
    if (t.tabId !== null && !(await isValid(t.tabId))) {
      t = await reselect();
    }
    let running = false;
    if (t.tabId !== null) {
      const info = await sendToTab(t.tabId, { cmd: "status" });
      running = !!info && !!info.state && info.state.phase === "running";
    }
    return write({ tabId: t.tabId, scanning: running });
  });
}
