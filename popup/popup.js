import { countEvents, countReviewEntries, getAllEvents, getAllReviewEntries, getMeta, getRequests, newestEventDay } from "../lib/db.js";
import { timeline } from "../lib/chart.js";
import { anonymousFile } from "../lib/anon.js";
import { buildExport } from "../lib/transfer.js";
import { DEFAULT_START, downloadText, formatTime, today, withTimeout } from "../lib/util.js";

const POLL_MS = 400;
const WIPE_CONFIRM_MS = 5000;
const $ = (id) => document.getElementById(id);

const ui = {
  count: $("count"), entries: $("entries"), last: $("last"), since: $("since"), start: $("start"), end: $("end"),
  scan: $("scan"), cancel: $("cancel"), buttons: $("scan-buttons"), bar: $("bar"), status: $("status"), preview: $("preview"),
  analyze: $("analyze"), export: $("export"), import: $("import"), wipe: $("wipe"), requests: $("requests"), anonymize: $("anonymize")
};
const modeInputs = [...document.querySelectorAll('input[name="mode"]')];
const mode = () => modeInputs.find((r) => r.checked).value;

// the background tracker: which review log tab scans run in, and whether one is running
let tracker = { tabId: null, scanning: false };
let mismatches = 0;
let lastProgress = "";
let note = ""; // message of the last export, wipe or refused scan, kept until the next scan
let noteIsError = false;
let dataError = ""; // the stored data could not be read, shown until it can
let dataBusy = ""; // opening the database takes long (an upgrade is running), shown until the data is there
const BUSY_AFTER_MS = 1000;
let polling = false;
let wipeTimer = null;

/** Null if there is no tracked tab or it does not answer. A silent tab must not stall the popup. */
async function askTab(msg) {
  if (tracker.tabId === null) {
    return null;
  }
  try {
    return await withTimeout(browser.tabs.sendMessage(tracker.tabId, msg), 2000);
  } catch (e) {
    return null;
  }
}

function setStatus(text, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("error", isError);
}

/** What "new entries only" means now: from the day of the newest stored event. */
async function showSince() {
  const newest = await newestEventDay();
  ui.since.textContent = `(from ${newest || ui.start.value || DEFAULT_START} until today)`;
}

async function refreshData() {
  const count = await countEvents();
  ui.count.textContent = count.toLocaleString();
  ui.export.disabled = count === 0;
  const entries = await countReviewEntries();
  ui.entries.textContent = entries ? `, ${entries.toLocaleString()} review entries` : "";
  const last = await getMeta("lastScan");
  ui.last.textContent = last ? `last scan: ${formatTime(last.when)}` : "";
  timeline(ui.preview, await getAllEvents(), { width: 324, height: 170 });
  await showSince();
}

async function showData() {
  const timer = setTimeout(() => {
    dataBusy = "The database is being upgraded. The data will show when that is done.";
    setStatus(dataBusy, true);
  }, BUSY_AFTER_MS);
  try {
    await refreshData();
    dataError = "";
  } catch (e) {
    dataError = `Could not read the stored data: ${e.message || e}`;
  } finally {
    clearTimeout(timer);
    dataBusy = "";
  }
}

let stopping = false; // Stop was pressed and the scan has not ended yet: the button is disabled and says so

let anonymousData = false; // this profile holds an imported anonymous data set: it only shows data

function setControls({ canScan, running }) {
  const locked = !canScan || running || anonymousData;
  ui.start.disabled = locked; // "new entries only" starts at the newest stored event, the date is used if nothing is stored
  ui.end.disabled = locked || mode() !== "range";
  modeInputs.forEach((r) => {
    r.disabled = locked;
  });
  ui.scan.disabled = locked;
  ui.wipe.disabled = running;
  ui.buttons.classList.toggle("running", running); // popup.css shows Stop while it runs and Scan otherwise
  stopping = stopping && running; // the scan has ended, so it is stopped
  ui.cancel.disabled = stopping;
  ui.cancel.textContent = stopping ? "Stopping..." : "Stop";
}

const HINT_NO_TAB = "Open the Review Log page to scan.";
const HINT_NO_ANSWER = "The log tab does not answer. If it is still loading, wait. Otherwise reload it once.";

function progressText(s) {
  if (s.stage === "queue") {
    return `Queues: ${s.queueNew + s.queueUpdates} waiting submissions read.`;
  }
  if (s.stage === "files") {
    return `Type check: file ${s.fileIndex} of ${s.fileTotal}${s.fileFailed ? `, ${s.fileFailed} failed` : ""}.`;
  }
  if (s.stage === "details") {
    if (s.detailTotal === 0) {
      return "Checking the stored review details...";
    }
    return `Review details: add-on ${s.detailIndex} of ${s.detailTotal}${s.detailPage > 1 ? `, history page ${s.detailPage}` : ""}.`;
  }
  return `Log page ${s.page} of ${s.pages || "?"}: ${s.added} new, ${s.skipped} already stored.`;
}

function render(info) {
  if (anonymousData) {
    setControls({ canScan: false, running: false });
    ui.bar.hidden = true;
    setStatus("This profile holds anonymous data, scanning is off. Wipe all data to scan.");
    return;
  }
  if (tracker.tabId === null || !info || !info.onLogPage) {
    setControls({ canScan: false, running: tracker.scanning });
    ui.bar.hidden = true;
    setStatus(note || (tracker.tabId === null ? HINT_NO_TAB : HINT_NO_ANSWER), noteIsError);
    return;
  }
  const s = info.state;
  setControls({ canScan: true, running: tracker.scanning });
  if (tracker.scanning && s.phase === "running") {
    ui.bar.hidden = false;
    ui.bar.max = Math.max(1, s.stage === "files" ? s.fileTotal : s.stage === "details" ? s.detailTotal : s.pages);
    ui.bar.value = s.stage === "files" ? s.fileIndex : s.stage === "details" ? s.detailIndex : s.page;
    setStatus(progressText(s));
  } else {
    ui.bar.hidden = true;
    setStatus(note || (s.phase === "idle" ? "" : s.message), note ? noteIsError : s.phase === "error");
  }
}

/** The tracker says one thing and the log tab another. The background repairs it from the facts. */
async function checkConsistency(info) {
  const running = !!info && !!info.state && info.state.phase === "running";
  mismatches = running === tracker.scanning ? 0 : mismatches + 1;
  if (mismatches === 2) { // not on the first poll, the end of a scan is reported with a short delay
    await browser.runtime.sendMessage({ cmd: "reconcile" });
  }
}

/** One poll at a time, a poll that is still busy is not started again. */
async function poll() {
  if (polling) {
    return;
  }
  polling = true;
  try {
    anonymousData = !!(await withTimeout(browser.runtime.sendMessage({ cmd: "isAnonymous" }), 3000, { anonymous: false })).anonymous;
    const info = await askTab({ cmd: "status" });
    render(info);
    if (dataError || dataBusy) {
      setStatus(dataError || dataBusy, true);
    }
    await checkConsistency(info);
    const s = info && info.state;
    const progress = s ? `${s.phase}|${s.added}|${s.detailIndex}|${s.fileIndex}|${s.queueAdded}` : "";
    if (progress !== lastProgress) {
      lastProgress = progress;
      await showData();
    }
  } finally {
    polling = false;
  }
}

ui.scan.addEventListener("click", async () => {
  if (ui.start.value && ui.end.value && ui.start.value > ui.end.value) {
    note = "The start date is after the end date.";
    noteIsError = true;
    setStatus(note, true);
    return;
  }
  await browser.storage.local.set({ start: ui.start.value, end: ui.end.value, mode: mode() });
  note = "";
  noteIsError = false;
  setStatus("Starting...");
  try {
    await browser.runtime.sendMessage({ cmd: "startScan", start: ui.start.value, end: ui.end.value, mode: mode() });
  } catch (e) {
    setStatus(e.message || String(e), true);
    return;
  }
  await poll();
});

ui.cancel.addEventListener("click", async () => {
  stopping = true;
  ui.cancel.disabled = true;
  ui.cancel.textContent = "Stopping...";
  try {
    await browser.runtime.sendMessage({ cmd: "cancelScan" });
  } catch (e) {
    stopping = false; // it did not reach the scan, Stop can be pressed again
    ui.cancel.disabled = false;
    ui.cancel.textContent = "Stop";
    throw e;
  }
});

modeInputs.forEach((r) => r.addEventListener("change", () => poll()));
ui.start.addEventListener("change", () => showSince());

ui.anonymize.addEventListener("change", () => browser.storage.local.set({ anonymize: ui.anonymize.checked }));

ui.analyze.addEventListener("click", async () => {
  await browser.tabs.create({ url: browser.runtime.getURL(`analysis/analysis.html${ui.anonymize.checked ? "?anon=1" : ""}`) });
  window.close();
});

ui.export.addEventListener("click", async () => {
  const events = await getAllEvents();
  noteIsError = false;
  if (ui.anonymize.checked) { // events only, fake reviewers, no comments and no review entries
    downloadText(`reviewlog-anon-${today()}.json`, "application/json", await anonymousFile(events));
    note = `Exported ${events.length.toLocaleString()} events, anonymous.`;
  } else {
    const entries = await getAllReviewEntries();
    downloadText(`reviewlog-export-${today()}.json`, "application/json", buildExport(events, entries));
    note = `Exported ${events.length.toLocaleString()} events and ${entries.length.toLocaleString()} review entries.`;
  }
  setStatus(note);
});

/** The addresses that the scans requested, with the HTTP status (0: no answer), one per line, oldest first. */
ui.requests.addEventListener("click", async () => {
  const lines = (await getRequests()).map((r) => `${r.t}\t${r.status}\t${r.url}`);
  downloadText(`reviewlog-requests-${today()}.txt`, "text/plain", `${lines.join("\n")}\n`);
});

ui.import.addEventListener("click", async () => {
  await browser.tabs.create({ url: browser.runtime.getURL("import/import.html") });
  window.close();
});

/** Two clicks: the first asks, the second wipes. The question goes away after a few seconds. */
function resetWipe() {
  clearTimeout(wipeTimer);
  wipeTimer = null;
  ui.wipe.textContent = "Wipe all data";
}

ui.wipe.addEventListener("click", async () => {
  if (!wipeTimer) {
    ui.wipe.textContent = "Sure? Click again";
    wipeTimer = setTimeout(resetWipe, WIPE_CONFIRM_MS);
    return;
  }
  resetWipe();
  try {
    await browser.runtime.sendMessage({ cmd: "wipeAll" });
    noteIsError = false;
    note = "All data was removed.";
    setStatus(note);
    await showData();
  } catch (e) {
    setStatus(e.message || String(e), true);
  }
});

/** The background tells every state change by writing the tracker, the popup follows. */
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.tracker && !document.body.classList.contains("no-scan")) {
    tracker = changes.tracker.newValue || { tabId: null, scanning: false };
    poll();
  }
});

/** Thunderbird has no review log tab to scan in, it only shows the data. Any other answer, or none, is Firefox. */
async function isThunderbird() {
  try {
    return (await browser.runtime.getBrowserInfo()).name === "Thunderbird";
  } catch (e) {
    return false;
  }
}

/** The stored data does not depend on the tab tracker, so it is shown first and whatever else fails. */
async function init() {
  const prefs = await browser.storage.local.get("anonymize");
  ui.anonymize.checked = !!prefs.anonymize;
  if (await isThunderbird()) {
    document.body.classList.add("no-scan"); // no scan part, no wipe, no tab tracking
    await showData();
    return;
  }
  const saved = await browser.storage.local.get(["start", "end", "mode"]);
  ui.start.value = saved.start || DEFAULT_START;
  ui.end.value = saved.end || "";
  modeInputs.forEach((r) => {
    r.checked = r.value === (saved.mode === "range" ? "range" : "new");
  });

  await showData();

  try {
    tracker = await withTimeout(browser.runtime.sendMessage({ cmd: "getTracker" }), 3000, undefined);
    if (!tracker) {
      throw new Error("the background page does not answer");
    }
  } catch (e) {
    tracker = { tabId: null, scanning: false };
    setStatus(`No scan tracking: ${e.message || e}`, true);
  }

  await poll();
  const timer = setInterval(poll, POLL_MS);
  window.addEventListener("pagehide", () => clearInterval(timer));
}

init();
