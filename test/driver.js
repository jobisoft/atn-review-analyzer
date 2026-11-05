// Staged into the test copy only. Drives the real popup, analysis and import pages and reports to the fake site.
const SITE = "http://127.0.0.1:8770";
const checks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { document.getElementById("log").textContent += m + "\n"; };

function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail: String(detail) });
  log(`${ok ? "ok  " : "FAIL"} ${name} ${ok ? "" : detail}`);
}

async function waitFor(fn, what, timeout = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { /* retry */ }
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
}

const trackerNow = () => browser.runtime.sendMessage({ cmd: "getTracker" });
const ctl = (q) => fetch(`${SITE}/ctl?${q}`).then((r) => r.json());
const expectation = () => ctl("expect=1");
const popupFrame = document.getElementById("popup");
const sideFrame = document.getElementById("analysis");

async function openPopup() {
  popupFrame.src = "about:blank";
  await sleep(100);
  popupFrame.src = "popup/popup.html";
  await waitFor(() => popupFrame.contentDocument.getElementById("start")?.value, "popup init");
  await sleep(700); // first poll
  return popupFrame.contentDocument;
}

async function openTab(url) {
  const tab = await browser.tabs.create({ url, active: false });
  await waitFor(async () => (await browser.tabs.sendMessage(tab.id, { cmd: "status" }))?.onLogPage, "content script", 8000);
  return tab.id;
}

const state = (tabId) => browser.tabs.sendMessage(tabId, { cmd: "status" }).then((r) => r.state);
const finished = (tabId) => waitFor(async () => {
  const s = await state(tabId);
  return ["done", "cancelled", "error"].includes(s.phase) ? s : null;
}, "scan finished", 600000).catch(async (e) => { throw new Error(`${e.message} ${JSON.stringify(await state(tabId))}`); });

/** Presses Scan in the popup. mode: "new" or "range". Returns the final state and the pages fetched. */
async function runScan(doc, tabId, { mode = "new", start = "2025-01-01", end = "" } = {}) {
  doc.querySelector(`input[name="mode"][value="${mode}"]`).click();
  doc.getElementById("start").value = start;
  doc.getElementById("end").value = end;
  const before = await ctl("x=1");
  const run0 = (await state(tabId)).runId;
  doc.getElementById("scan").click();
  await waitFor(async () => (await state(tabId)).runId > run0, "scan started", 5000);
  const s = await finished(tabId);
  await sleep(700); // let the popup poll once more
  const after = await ctl("x=1");
  return { s, hits: after.hits.slice(before.hits.length), rh: after.rhits.slice(before.rhits.length), fh: after.fhits.slice(before.fhits.length) };
}

const db = () => import("./lib/db.js");
const dbRows = async () => (await db()).getAllEvents();
const entryRows = async () => (await db()).getAllReviewEntries();

const keyOf = (e) => `${e.addonSlug || e.slug}|${e.addonVersion || e.version}|${e.event}|${e.date}`;
const same = (a, b) => (a ?? null) === (b ?? null);

/** Compares the cells of the stored events with what the fake site says a complete walk finds. Returns the differences. */
async function compareWithOracle({ skip = () => false } = {}) {
  const want = new Map((await expectation()).map((x) => [keyOf(x), x]));
  const diffs = [];
  for (const ev of await dbRows()) {
    const w = want.get(keyOf(ev));
    if (!w) {
      if (ev.event !== "Awaiting Review" || ev.addonSlug !== "wt-3") diffs.push(`${keyOf(ev)}: not in the oracle`); // wt-3 left the queue without an entry: its row stays
      continue;
    }
    if (skip(w)) continue;
    if (ev.tSubmission === undefined) { diffs.push(`${keyOf(ev)}: pending`); continue; }
    const waitOk = ev.tWait === null || w.tWait === null || w.tWait === undefined ? same(ev.tWait, w.tWait) : Math.abs(ev.tWait - w.tWait) < 0.0101; // rounding of x.xx5
    if (ev.type !== (w.type || undefined)) { // no type in the oracle: nothing is stored, the scan asks again
      diffs.push(`${keyOf(ev)}: type ${ev.type} wanted ${w.type}`);
    }
    if (!same(ev.tSubmission, w.tSubmission) || !waitOk || !same(ev.queue, w.queue)) {
      diffs.push(`${keyOf(ev)}: ${ev.tSubmission}/${ev.tWait}/${ev.queue} wanted ${w.tSubmission}/${w.tWait}/${w.queue}`);
    }
  }
  return diffs;
}

const sendMsg = (msg) => browser.runtime.sendMessage(msg);

async function main() {
  await ctl("reset=1&n=230&delay=0&fail=0&logout=0");

  // 1. A page that is not the log: popup opens, controls are disabled
  await browser.tabs.create({ url: `${SITE}/other`, active: false });
  await sleep(1500);
  const t0 = await trackerNow();
  check("tracker: no review tab, nothing tracked", t0.tabId === null && t0.scanning === false, JSON.stringify(t0));
  let doc = await openPopup();
  check("not a log page: Scan, dates and modes disabled", doc.getElementById("scan").disabled && doc.getElementById("start").disabled && doc.getElementById("end").disabled && [...doc.querySelectorAll('input[name="mode"]')].every((r) => r.disabled));
  check("not a log page: hint shown", /Open the Review Log page/.test(doc.getElementById("status").textContent), doc.getElementById("status").textContent);
  check("popup: Wipe is a button, Analyze/Export/Import present, no checkboxes of the old design", !!doc.getElementById("wipe") && !!doc.getElementById("analyze") && !doc.getElementById("full") && !doc.getElementById("reviews"));

  // 2. First scan, nothing stored: "new entries only" starts at the start date
  const tab = await openTab(`${SITE}/en-US/reviewers/reviewlog?start=2025-01-01&end=&search=`);
  const t1 = await trackerNow();
  check("tracker: the new review tab is tracked after loading", t1.tabId === tab && t1.scanning === false, JSON.stringify(t1));
  doc = await openPopup();
  check("log page: Scan enabled, mode 'new' is the default", !doc.getElementById("scan").disabled && doc.querySelector('input[name="mode"]:checked').value === "new");
  check("popup: end date is disabled in 'new' mode", doc.getElementById("end").disabled);
  let r = await runScan(doc, tab);
  check("scan 1: 230 added", r.s.added === 230 && r.s.skipped === 0, JSON.stringify(r.s));
  check("scan 1: walked 5 pages", r.hits.join() === "1,2,3,4,5", r.hits.join());
  check("scan 1: matches site total", /Matches the 230/.test(r.s.message), r.s.message);
  check("scan 1: one history page fetched per add-on (40, each has under 10 versions)", r.rh.length === 40 && new Set(r.rh).size === 40 && r.rh.every((x) => x.endsWith("#1")), `${r.rh.length} fetched`);
  check("scan 1: the details were fetched after the log, then the manifests", r.s.stage === "files" && r.s.detailTotal === 40 && r.s.detailFailed === 0, JSON.stringify(r.s));
  let entries = await entryRows();
  check("scan 1: one entry per version, 230 in all", entries.length === 230 && new Set(entries.map((e) => `${e.addonSlug}|${e.version}`)).size === 230, entries.length);
  check("scan 1: an entry is the table of one version, stored as the site sent it (links and scripts are still in it)", entries.every((e) => e.html.startsWith('<table id="review-files">') && (e.html.match(/listing-header/g) || []).length === 1 && /<a href="javascript:/.test(e.html) && /<script>/.test(e.html) && /<a href="\/en-US\/thunderbird\/user\//.test(e.html)));
  check("scan 1: the last entry of each add-on is the oldest", entries.filter((e) => e.oldest).length === 40);
  let diffs = await compareWithOracle();
  check("scan 1: tSubmission, tWait, queue and type of all 230 events equal the oracle", diffs.length === 0, diffs.slice(0, 3).join(" / "));
  let rows = await dbRows();
  const rejectedVersions = new Set(rows.map((e) => `${e.addonSlug}@${e.addonVersion}`));
  check("scan 1: the raw manifest.json is fetched once per version (every event is after the announcement), in one request each", r.fh.length === rejectedVersions.size && new Set(r.fh).size === r.fh.length && r.fh.every((x) => rejectedVersions.has(x)), `${r.fh.length} vs ${rejectedVersions.size}`);
  check("scan 1: the type check ran after the details", r.s.fileTotal === rejectedVersions.size && r.s.fileFailed === 0 && r.s.fileUnknown === 0 && Object.values(r.s.fileTypes).reduce((a, b) => a + b, 0) === r.s.fileTotal && r.s.fileTypes.experiment > 0 && r.s.fileTypes.webextension > 0 && /Type check of \d+ versions/.test(r.s.message), JSON.stringify(r.s));
  check("scan 1: every event has a type whatever its queue or event, experiment and webextension both occur", rows.every((e) => e.type !== undefined) && rows.some((e) => e.event === "Approved" && e.type === "experiment") && rows.some((e) => e.type === "experiment") && rows.some((e) => e.type === "webextension"));
  const { getReviewEntry, getEntriesOf, getAllReviewEntries } = await db();
  const entriesNow = await getAllReviewEntries();
  const withManifest = entriesNow.filter((e) => e.manifest !== undefined);
  check("scan 1: the manifest is stored on the entry of every version", withManifest.length === rejectedVersions.size && withManifest.every((e) => rejectedVersions.has(`${e.addonSlug}@${e.version}`) && typeof e.manifest === "string" && JSON.parse(e.manifest).manifest_version === 2));
  check("scan 1: the type of an event is what its stored manifest says", rows.every((e) => { const en = withManifest.find((x) => x.addonSlug === e.addonSlug && x.version === e.addonVersion); return en && ("experiment_apis" in JSON.parse(en.manifest) ? "experiment" : "webextension") === e.type; }));
  check("scan 1: tWait is in days with at most 2 decimals, and every event has a queue", rows.every((e) => typeof e.tWait === "number" && Math.abs(e.tWait * 100 - Math.round(e.tWait * 100)) < 1e-6 && (e.queue === "new" || e.queue === "update")));
  check("scan 1: both queues occur", rows.some((e) => e.queue === "new") && rows.some((e) => e.queue === "update"));
  check("popup shows 230 events and 230 entries", doc.getElementById("count").textContent === "230" && /230 review entries/.test(doc.getElementById("entries").textContent), doc.getElementById("entries").textContent);
  check("popup preview: Review Activity stacked line graph with axis titles", !!doc.querySelector("#preview svg path.line.approved") && /Review Activity/.test(doc.getElementById("preview-title").textContent) && [...doc.querySelectorAll("#preview text.axis-title")].some((t) => t.textContent === "Date"));
  check("popup: 'new entries only' shows the day it starts from", /from 2026-11-03 until today/.test(doc.getElementById("since").textContent), doc.getElementById("since").textContent);

  // 3. Repeat: new-only starts at the newest day, nothing new, no detail fetch
  r = await runScan(doc, tab);
  check("scan 2: nothing added, the known events of the day are skipped", r.s.added === 0 && r.s.skipped > 0, JSON.stringify(r.s));
  check("scan 2: one log page, no history page", r.hits.join() === "1" && r.rh.length === 0, `${r.hits} / ${r.rh}`);
  check("scan 2: details up to date, no file is downloaded again", /Review details are up to date/.test(r.s.message) && r.fh.length === 0 && r.s.fileTotal === 0, r.s.message + r.fh.length);
  check("scan 2: nothing wiped", (await dbRows()).length === 230 && (await entryRows()).length === 230);

  // 3b. Events without cells (an import from an older file) are resolved from the stored entries, without any request
  const { openDb } = await db();
  const handle = await openDb();
  await new Promise((resolve, reject) => {
    const tx = handle.transaction("events", "readwrite");
    const st = tx.objectStore("events");
    st.openCursor().onsuccess = (ev) => {
      const c = ev.target.result;
      if (c) { const { tSubmission, tWait, queue, ...rest } = c.value; c.update(rest); c.continue(); }
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  check("cells removed from all events", (await dbRows()).every((e) => e.tSubmission === undefined));
  r = await runScan(doc, tab);
  check("scan 2b: nothing is fetched, the 40 add-ons are filled in from stored data", r.rh.length === 0 && r.s.detailTotal === 0 && r.s.detailStored === 40 && /filled in from stored data/.test(r.s.message), `${r.rh.length} ${JSON.stringify(r.s)}`);
  diffs = await compareWithOracle();
  check("scan 2b: the cells equal the oracle again", diffs.length === 0, diffs.slice(0, 3).join(" / "));

  // 3c. type removed: the stored manifests answer, nothing is fetched
  await new Promise((resolve, reject) => {
    const tx = handle.transaction("events", "readwrite");
    tx.objectStore("events").openCursor().onsuccess = (ev) => {
      const c = ev.target.result;
      if (c) { const { type, ...rest } = c.value; c.update(rest); c.continue(); }
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  check("type removed from all events", (await dbRows()).every((e) => e.type === undefined));
  r = await runScan(doc, tab);
  check("scan 2c: the stored manifests answer, no request is made", r.fh.length === 0 && r.s.fileTotal === 0, `${r.fh.length} ${r.s.fileTotal}`);
  diffs = await compareWithOracle();
  check("scan 2c: type equals the oracle again", diffs.length === 0, diffs.slice(0, 3).join(" / "));

  // 4. Three new events on top
  await ctl("add=3");
  r = await runScan(doc, tab);
  check("scan 3: exactly 3 added", r.s.added === 3, JSON.stringify(r.s));
  check("scan 3: only the 3 add-ons of the new events are fetched", [...r.rh].sort().join() === "addon-30#1,addon-31#1,addon-32#1", r.rh.join());
  diffs = await compareWithOracle();
  check("scan 3: all 233 events equal the oracle", (await dbRows()).length === 233 && diffs.length === 0, diffs.slice(0, 3).join(" / "));

  // 5. Range mode with an end date: only that range is walked, known events are skipped
  r = await runScan(doc, tab, { mode: "range", start: "2026-10-30", end: "2026-10-31" });
  const inRange = (await dbRows()).filter((e) => e.date.slice(0, 10) >= "2026-10-30" && e.date.slice(0, 10) <= "2026-10-31").length;
  check("range scan: only the events of the range are on the site's pages", r.hits.length === Math.ceil(inRange / 50) && r.s.added === 0 && r.s.skipped === inRange, `${r.hits} ${JSON.stringify(r.s)} inRange=${inRange}`);
  check("range scan: the end input is enabled in range mode", !doc.getElementById("end").disabled);
  doc.querySelector('input[name="mode"][value="range"]').click();
  doc.getElementById("start").value = "2026-11-02";
  doc.getElementById("end").value = "2026-10-01";
  const runBefore = (await state(tab)).runId;
  doc.getElementById("scan").click();
  await sleep(250);
  check("range scan: start after end is refused by the popup, no scan starts", /start date is after the end date/.test(doc.getElementById("status").textContent) && (await state(tab)).runId === runBefore, doc.getElementById("status").textContent);

  // 6. Walker: a version far back in the history and an approval further back
  await ctl("newer=addon-3:25&addev=addon-3:Approved");
  r = await runScan(doc, tab);
  check("walker: the new version is on history page 3, so pages 1 to 3 are fetched", r.rh.join() === "addon-3#1,addon-3#2,addon-3#3", r.rh.join());
  await ctl(`older=wk-1:12&newer=wk-1:25${"&addev=wk-1:Rejected".repeat(12)}`);
  r = await runScan(doc, tab);
  check("walker: no approval in the newer pages, it goes back to the extra old versions (page 4)", r.rh.join() === "wk-1#1,wk-1#2,wk-1#3,wk-1#4", r.rh.join());
  diffs = await compareWithOracle();
  check("walker: the events of both add-ons equal the oracle", diffs.length === 0, diffs.slice(0, 3).join(" / "));
  const stored = await (await db()).getEntriesOf("wk-1");
  check("walker: all fetched entries are stored (4 pages), none is the oldest yet", stored.length === 40 && !stored.some((e) => e.oldest), stored.length);
  r = await runScan(doc, tab);
  check("walker: stored entries stop all fetches at the next scan", r.rh.length === 0 && r.s.added === 0, r.rh.join());

  // 7. Review page problems
  await ctl("rfail=gone-1&redirect=gone-2&rerr=err-1&addev=gone-1:Rejected&addev=gone-1:Approved&addev=gone-2:Approved&addev=err-1:Approved");
  r = await runScan(doc, tab);
  const byslug = (slug) => dbRows().then((x) => x.filter((e) => e.addonSlug === slug));
  const g1 = await byslug("gone-1");
  check("404: the Rejected event is a new add-on, nothing else known", g1.find((e) => e.event === "Rejected")?.queue === "new" && g1.every((e) => e.tSubmission === null && e.tWait === null) && g1.find((e) => e.event === "Approved")?.queue === null, JSON.stringify(g1.map((e) => [e.event, e.queue, e.tSubmission])));
  const g2 = await byslug("gone-2");
  check("redirect to the queue: empty cells, add-on marked inaccessible", g2.length === 1 && g2[0].queue === null && g2[0].tWait === null && (await (await db()).getInaccessible()).some((x) => x.slug === "gone-2"), JSON.stringify(g2));
  const e1 = await byslug("err-1");
  check("500: the event stays pending and is retried", e1.length === 1 && e1[0].tSubmission === undefined && r.rh.filter((x) => x === "err-1#1").length === 3 && r.s.detailFailed === 1, `${r.rh.filter((x) => x === "err-1#1").length} ${JSON.stringify(r.s)}`);
  check("500: the scan message says which add-on could not be read", /could not be read/.test(r.s.message) && /err-1/.test(r.s.message), r.s.message);
  await ctl("rerr=none");
  r = await runScan(doc, tab);
  check("after the server recovers the pending event is resolved, nothing else is fetched", r.rh.join() === "err-1#1", r.rh.join());
  diffs = await compareWithOracle({ skip: (w) => w.mode !== "ok" });
  check("review page problems: the readable events still equal the oracle", diffs.length === 0, diffs.slice(0, 3).join(" / "));
  r = await runScan(doc, tab);
  check("a gone page is not asked for again", r.rh.length === 0, r.rh.join());
  check("gone page and queue redirect: their rejected events have no type, nothing is stored", g1.concat(await byslug("gone-2")).filter((e) => e.event === "Rejected").every((e) => e.type === undefined) && (await byslug("gone-1")).filter((e) => e.event === "Rejected").length === 1);

  // 7b. The files: not there (404), a web page instead of the file, server error, Experiment, plain, legacy (install.rdf)
  await ctl("file=fx-1:404&file=fx-2:nomanifest&file=fx-3:page&file=fx-4:500&file=fx-5:experiment&file=fx-6:plain&file=fx-7:legacy&addev=fx-1:Rejected&addev=fx-2:Rejected&addev=fx-3:Rejected&addev=fx-4:Rejected&addev=fx-5:Rejected&addev=fx-6:Rejected&addev=fx-6:Approved&addev=fx-7:Rejected");
  r = await runScan(doc, tab);
  const fx = async (slug) => (await byslug(slug)).filter((e) => e.event === "Rejected")[0].type;
  check("files: a 404 for manifest.json and install.rdf stores no type, and both files were asked for", (await fx("fx-1")) === undefined && (await fx("fx-2")) === undefined && r.fh.filter((x) => /^fx-1@/.test(x)).length === 2, [await fx("fx-1"), await fx("fx-2"), r.fh.join()].join());
  check("files: experiment_apis gives experiment, a plain manifest gives webextension, an install.rdf gives legacy", (await fx("fx-5")) === "experiment" && (await fx("fx-6")) === "webextension" && (await fx("fx-7")) === "legacy");
  check("files: a web page instead of the file and a server error leave the events pending and are reported", (await fx("fx-3")) === undefined && (await fx("fx-4")) === undefined && r.s.fileFailed === 2 && /could not be read/.test(r.s.message) && /fx-[34]/.test(r.s.message), r.s.message);
  check("files: the Approved event of fx-6 has the type as well", (await byslug("fx-6")).filter((e) => e.event === "Approved").every((e) => e.type === "webextension"));
  check("files: the manifest of fx-5 is stored with its entry, none for the missing ones", !!(await getEntriesOf("fx-5")).find((e) => e.manifest && e.manifest.includes("experiment_apis")) && (await getEntriesOf("fx-1")).every((e) => e.manifest === undefined));
  await ctl("file=fx-3:none&file=fx-4:none");
  r = await runScan(doc, tab);
  check("files: after the server recovers the manifests of fx-3 and fx-4 are fetched and they are plain, the missing ones are asked for again (both files)", r.fh.filter((x) => /^fx-[34]@/.test(x)).length === 2 && r.fh.filter((x) => /^fx-[12]@/.test(x)).length === 4 && r.fh.length === 6 && (await fx("fx-3")) === "webextension" && (await fx("fx-4")) === "webextension", r.fh.join());
  r = await runScan(doc, tab);
  check("files: only the versions without a type are asked for again", r.fh.length === 4 && r.fh.every((x) => /^fx-[12]@/.test(x)), r.fh.join());

  // 7c. The review queue: waiting versions become rows "Awaiting Review", and are cleaned up when the version has another entry
  const marker = await (await db()).newestEventDay();
  await ctl("wait=wt-1:1.0:new&wait=wt-2:2.0:update&wait=wt-3:3.0:new&file=wt-3:experiment");
  r = await runScan(doc, tab);
  const waitRows = async () => (await dbRows()).filter((e) => e.event === "Awaiting Review");
  let wr = await waitRows();
  check("queue: the waiting versions are rows of the log without a date, with the reviewer Nobody and the queue they were read in", wr.length === 3 && wr.every((e) => e.date === null && e.reviewer === "Nobody" && e.dateRaw === "waiting") && wr.find((e) => e.addonSlug === "wt-1").queue === "new" && wr.find((e) => e.addonSlug === "wt-2").queue === "update", JSON.stringify(wr.map((e) => [e.addonSlug, e.queue, e.reviewer])));
  check("queue: the scan reports the queues", /Queue: 2 new and 1 updates waiting, 3 added/.test(r.s.message), r.s.message);
  check("queue: the waiting rows got their submission time from the review page, no wait, and the type from the manifest", wr.every((e) => e.tSubmission === "2026-11-03T07:00:00" && e.tWait === null) && wr.find((e) => e.addonSlug === "wt-3").type === "experiment" && wr.find((e) => e.addonSlug === "wt-1").type === "webextension");
  check("queue: the marker of the log scan did not move", (await (await db()).newestEventDay()) === marker, marker);
  diffs = await compareWithOracle({ skip: (w) => w.mode !== "ok" });
  check("queue: all rows equal the oracle", diffs.length === 0, diffs.slice(0, 3).join(" / "));
  const waitIds = new Map(wr.map((e) => [e.addonSlug, e.id]));
  r = await runScan(doc, tab);
  wr = await waitRows();
  check("queue: the next scan adds nothing, the rows keep their ids", wr.length === 3 && wr.every((e) => waitIds.get(e.addonSlug) === e.id) && /3 added|0 added/.test(r.s.message) && r.s.queueAdded === 0, `${r.s.queueAdded} ${r.s.message}`);
  await ctl("decide=wt-1:1.0:Approved&decide=wt-2:2.0:More information requested&unwait=wt-3:3.0");
  r = await runScan(doc, tab);
  wr = await waitRows();
  const decided = await byslug("wt-1");
  check("queue: a decided version loses its waiting row and has its event, an information request does the same", !wr.some((e) => e.addonSlug === "wt-1" || e.addonSlug === "wt-2") && decided.some((e) => e.event === "Approved" && e.date) && (await byslug("wt-2")).some((e) => e.event === "More information requested"));
  check("queue: nothing adds them again, a version that left the queue without an entry keeps its row", wr.length === 1 && wr[0].addonSlug === "wt-3" && r.s.queueAdded === 0, JSON.stringify(wr.map((e) => e.addonSlug)));
  await ctl("qfail=1&wait=wt-4:4.0:new");
  r = await runScan(doc, tab);
  check("queue: a queue that can not be read is reported, the scan goes on and the rows stay", r.s.phase === "done" && /could not be read/.test(r.s.message) && (await waitRows()).length === 1 && !(await waitRows()).some((e) => e.addonSlug === "wt-4"), r.s.message);
  await ctl("qfail=0");
  r = await runScan(doc, tab);
  check("queue: the next scan adds the version", (await waitRows()).some((e) => e.addonSlug === "wt-4") && r.s.queueAdded === 1, r.s.message);
  diffs = await compareWithOracle({ skip: (w) => w.mode !== "ok" });
  check("queue: all events and waiting rows equal the oracle", diffs.length === 0, diffs.slice(0, 3).join(" / "));
  diffs = await compareWithOracle({ skip: (w) => w.mode !== "ok" });
  check("files: all events equal the oracle", diffs.length === 0, diffs.slice(0, 3).join(" / "));


  // 8. Log failures
  await ctl("fail=3");
  r = await runScan(doc, tab, { mode: "range", start: "2025-01-01" });
  check("failing log page: error phase naming the page", r.s.phase === "error" && /Log page 3/.test(r.s.message), JSON.stringify(r.s));
  check("failing log page: popup shows the error", doc.getElementById("status").classList.contains("error"), doc.getElementById("status").textContent);
  await ctl("fail=0&logout=1");
  r = await runScan(doc, tab, { mode: "range", start: "2025-01-01" });
  check("logged out: error mentions the missing table", r.s.phase === "error" && /no review log table/.test(r.s.message), r.s.message);
  await ctl("logout=0");

  // 9. Analysis page: only reads
  sideFrame.src = "analysis/analysis.html";
  await waitFor(() => sideFrame.contentDocument.querySelectorAll("#records tbody tr").length > 0, "analysis rows");
  let ad = sideFrame.contentDocument;
  const heads = [...ad.querySelectorAll("#records thead th")].map((th) => th.textContent.trim());
  check("analysis: columns Date, Event, Reviewer, Add-on, Submitted, Wait in days, Queue, Type, Comment, Review entry", heads.join("|") === "Date|Event|Reviewer|Add-on|Submitted|Wait in days|Queue|Type|Comment|Review entry", heads.join("|"));
  const all = await dbRows();
  const firstRow = [...ad.querySelectorAll("#records tbody tr")].find((tr) => tr.children[1].textContent !== "Pending"); // the waiting versions come first
  const newest = [...all].filter((e) => e.date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  check("analysis: Submitted and Wait (a bare number, no unit) are filled from the stored cells", newest.tSubmission === undefined || newest.tSubmission === null || (firstRow.children[4].textContent !== "" && /^[\d.]+$/.test(firstRow.children[5].textContent)), firstRow.textContent.slice(0, 120));
  check("analysis: the removed parts are gone (failure section, expand all, legend text, caption)", !ad.getElementById("failtable") && !ad.getElementById("fail-count") && !ad.getElementById("expand-all") && !/red box|blue box|read failure/i.test(ad.body.textContent) && !ad.querySelector("caption"));
  const vb = ad.querySelector("#timeline svg").getAttribute("viewBox").split(" ").map(Number);
  check("analysis: the graph is as wide as its box, not the small popup size", vb[2] === Math.max(320, ad.getElementById("timeline").clientWidth) && vb[2] > 400, `${vb} box ${ad.getElementById("timeline").clientWidth}`);
  check("analysis: the weekday and hour graph and its subsection are gone", !ad.getElementById("heat") && ![...ad.querySelectorAll("h3")].some((h) => /Events over time|Weekday/.test(h.textContent)) && !ad.querySelector("rect.heat"));
  check("analysis: the range starts with the popup values", ad.getElementById("f-start").value === "2025-01-01" && ad.getElementById("f-end").value === "", ad.getElementById("f-start").value + "/" + ad.getElementById("f-end").value);
  const rangeInput = async (id, value) => { const i = ad.getElementById(id); i.value = value; i.dispatchEvent(new Event("input", { bubbles: true })); await sleep(300); };
  await rangeInput("f-start", "2026-11-01");
  const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const weeksBetween = (a, b) => Math.round((mondayOf(b) - mondayOf(a)) / (7 * 86400000)) + 1;
  const dayCount = weeksBetween(new Date("2026-11-01T00:00:00"), new Date()); // the graphs count per week
  check("analysis: the graph follows the range in weeks, end empty means today", ad.querySelectorAll("#timeline rect.hover").length === dayCount, `${ad.querySelectorAll("#timeline rect.hover").length} vs ${dayCount}`);
  const subDays = (id) => ad.querySelectorAll(`#${id} rect.hover`).length;
  check("analysis: the submission graphs follow the From date as well (same axis start and end as the review graphs)", subDays("submissions") === dayCount, `${subDays("submissions")} vs ${dayCount}`);
  await rangeInput("f-end", "2026-11-09");
  check("analysis: the submission graph follows the To date, in weeks", subDays("submissions") === 3, `${subDays("submissions")}`);
  check("analysis: the graph follows both dates, in weeks (26 October, 2 November, 9 November)", ad.querySelectorAll("#timeline rect.hover").length === 3, ad.querySelectorAll("#timeline rect.hover").length);
  const dayOf = (e) => (e.date || (e.event === "Awaiting Review" ? e.tSubmission : "") || "").slice(0, 10); // a waiting row counts on the day of its submission
  const shownRange = (await dbRows()).filter((e) => dayOf(e) >= "2026-11-01" && dayOf(e) <= "2026-11-09" && dayOf(e) !== "").length;
  check("analysis: records count and header follow the range", new RegExp(`of ${shownRange}\\)$`).test(ad.getElementById("shown").textContent) && ad.getElementById("span").textContent.startsWith(`${shownRange.toLocaleString()} of `), `${shownRange} ${ad.getElementById("shown").textContent} ${ad.getElementById("span").textContent}`);
  ad.getElementById("f-reset").click();
  await sleep(300);
  check("analysis: Reset brings back the values of the popup", ad.getElementById("f-start").value === "2025-01-01" && ad.getElementById("f-end").value === "");
  check("analysis: sections", [...ad.querySelectorAll("section.block h2")].map((h) => h.firstChild.textContent.trim()).join("|") === "Submission Activity|Review Activity|Review Queue Activity|Reviewers and Event Types|Records");
  const f = ad.getElementById("c-text");
  const typeFilter = async (value) => { f.value = value; f.dispatchEvent(new Event("input", { bubbles: true })); await sleep(400); return [...ad.querySelectorAll("#records > tbody > tr")]; };
  check("analysis: the text filter does not search the queue or the reviewer", (await typeFilter("update")).length === 0 && (await typeFilter("jess")).length === 0);
  const byName = await typeFilter("n:37");
  check("analysis: n: searches the add-on name only", byName.length > 0 && (await typeFilter("n:contribution")).length === 0);
  check("analysis: c: does not search the name", (await typeFilter("c:add-on 37")).length === 0 && byName.length > 0);
  const named = await typeFilter("37"); // a part of "Add-on 37"
  const unnamed = named.filter((tr) => !/37/.test(tr.children[3].textContent.replace(/ \d+\.\d+\.\d+$/, "")));
  check("analysis: the text filter matches part of the add-on name", named.length > 0 && unnamed.length === 0, `${named.length} rows, first without: ${unnamed[0] && unnamed[0].textContent.slice(0, 120)}`);
  await typeFilter("");
  const pick = async (id, value) => { const s = ad.getElementById(id); s.value = value; s.dispatchEvent(new Event("input", { bubbles: true })); await sleep(300); return [...ad.querySelectorAll("#records > tbody > tr")]; };
  const stored2 = await dbRows();
  const shownAll = async () => { const m = ad.getElementById("rec-max"); m.value = "all"; m.dispatchEvent(new Event("change", { bubbles: true })); await sleep(400); };
  await shownAll();
  let sel = await pick("c-queue", "new");
  check("analysis: the Queue filter shows only new", sel.length === stored2.filter((e) => e.queue === "new").length && sel.every((tr) => tr.children[6].textContent === "new"), `${sel.length}`);
  sel = await pick("c-queue", "unknown");
  check("analysis: the Queue filter 'unknown' shows the events without a queue", sel.length === stored2.filter((e) => !e.queue).length && sel.every((tr) => tr.children[6].textContent === "unknown"), `${sel.length}`);
  await pick("c-queue", "");
  ad.getElementById("c-reset").click();
  await sleep(300);
  check("analysis: Reset clears the queue filter", ad.getElementById("c-queue").value === "");
  const top = (id) => ad.getElementById(id).getBoundingClientRect().top;
  const wide2 = ["timeline", "submissions"].map((id) => ad.getElementById(id).getBoundingClientRect().width);
  const spot = (id) => ad.getElementById(id).getBoundingClientRect();
  const activityTitles = Array(3).fill("New queue|Update queue");
  check("analysis: the graph sections are below each other, Review Queue Activity has 3 subsections with a pair each (new left, update right), the age pictures are below each other", ad.querySelectorAll("section.block figure.graph").length === 10 && [...ad.querySelectorAll("figure.graph .graph-title")].map((t) => t.textContent).join("|") === [...activityTitles, "New queue|Update queue"].join("|") && top("submissions") < top("timeline") && top("timeline") < top("size-new") && top("size-new") === top("size-update") && top("size-new") < top("bars-new") && top("bars-new") === top("bars-update") && top("bars-new") < top("time-new") && top("time-new") === top("time-update") && top("time-new") < top("ageweeks-new") && top("ageweeks-new") < top("ageweeks-update") && spot("size-new").left < spot("size-update").left && spot("bars-new").left < spot("bars-update").left && spot("time-new").left < spot("time-update").left);
  check("analysis: Review Queue Activity has a size line, bars and the median and mean review time for each queue", ["new", "update"].every((queue) => ad.querySelectorAll(`#size-${queue} path.line.size`).length === 1 && ad.querySelectorAll(`#bars-${queue} rect.flow-in`).length > 0 && ad.querySelectorAll(`#time-${queue} path.line.median-time, #time-${queue} circle.dot-median-time`).length > 0 && ad.querySelectorAll(`#time-${queue} path.line.mean-time, #time-${queue} circle.dot-mean-time`).length > 0));
  check("analysis: the two age pictures are 3D canvases, the new queue above the update queue, each as wide as the other and without dotted lines", ["ageweeks-new", "ageweeks-update"].every((id) => ad.querySelectorAll(`#${id} canvas.surface`).length === 1) && top("ageweeks-new") < top("ageweeks-update") && Math.abs(ad.getElementById("ageweeks-new").getBoundingClientRect().width - ad.getElementById("ageweeks-update").getBoundingClientRect().width) < 2 && ad.getElementById("ageweeks-new").getBoundingClientRect().width > ad.getElementById("flow-new").getBoundingClientRect().width * 1.5);
  check("analysis: the submission graph is a stacked line graph, its tooltips only have the period and the total", !!ad.querySelector("#submissions svg path.line.approved") && !ad.getElementById("experiments") && [...ad.querySelectorAll("#submissions rect.hover title")].every((t) => /^week from \d{4}-\d{2}-\d{2}: \d+ submitted$/.test(t.textContent)), [...ad.querySelectorAll("#submissions rect.hover title")].slice(0, 2).map((t) => t.textContent).join(" / "));
  const eventNames = [...new Set(stored2.map((e) => e.event).filter(Boolean))].sort();
  const eventOptions = (id) => [...ad.getElementById(id).options].map((o) => o.value);
  check("analysis: the event filter of every section is a drop down with All and one entry per event type, no empty name, no checkboxes", ["f", "s", "g", "c"].every((p) => ad.getElementById(`${p}-event`)?.tagName === "SELECT" && eventOptions(`${p}-event`).join() === ["", ...eventNames].join()) && !ad.querySelector("fieldset.events") && !ad.querySelector(".filters input[type=checkbox]"), eventOptions("c-event").join());
  sel = await pick("c-event", "Rejected");
  check("analysis: with Rejected chosen only rejected events are shown", sel.length === stored2.filter((e) => e.event === "Rejected").length && sel.every((tr) => tr.children[1].textContent === "Rejected"), `${sel.length}`);
  ad.getElementById("c-reset").click();
  await sleep(300);
  check("analysis: Reset chooses All again", ad.getElementById("c-event").value === "");
  const dateCell = ad.querySelector("#records > tbody > tr td.date");
  check("analysis: the two date columns do not wrap", ad.defaultView.getComputedStyle(dateCell).whiteSpace === "nowrap" && ad.defaultView.getComputedStyle(ad.querySelectorAll("#records > tbody > tr")[0].children[4]).whiteSpace === "nowrap");
  const m50 = ad.getElementById("rec-max");
  m50.value = "all";
  m50.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(500);
  const expCells = [...ad.querySelectorAll("#records > tbody > tr")].map((tr) => ({ event: tr.children[1].textContent, text: tr.children[7].textContent, title: tr.children[7].title }));
  const dbAll = await dbRows();
  check("analysis: the Type column says the type", ["experiment", "webextension", "legacy"].every((t) => expCells.filter((c) => c.text === t).length === dbAll.filter((e) => e.type === t).length) && expCells.some((c) => c.text === "legacy"));
  check("analysis: an event without a type shows an empty cell with a tooltip", expCells.some((c) => c.text === "" && c.title === "not known, the files of the version were not found"));
  ad.querySelector('#records thead button[data-sort="type"]').click();
  await sleep(300);
  const sortedCells = [...ad.querySelectorAll("#records > tbody > tr")].map((tr) => tr.children[7].textContent);
  check("analysis: the Type column sorts, empty cells last", sortedCells.every((t, i) => i === 0 || (sortedCells[i - 1] === "" ? t === "" : t === "" || sortedCells[i - 1] <= t)), sortedCells.slice(0, 5).join());
  ad.querySelector('#records thead button[data-sort="date"]').click();
  await sleep(200);
  f.value = "";
  f.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(300);
  // the review entry cell
  const detailsOf = async (predicate) => {
    const row = [...ad.querySelectorAll("#records > tbody > tr")].find(predicate);
    const d = row.querySelector("details");
    d.open = true;
    d.dispatchEvent(new Event("toggle"));
    await sleep(500);
    return { row, d };
  };
  const m = ad.getElementById("rec-max");
  m.value = "all";
  m.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(500);
  const target = all.find((e) => e.addonSlug === "addon-7" && e.event === "Approved");
  const hit = await detailsOf((tr) => tr.children[3].textContent === `${target.addonName} ${target.addonVersion}` && tr.children[1].textContent === "Approved");
  const unopened = ad.querySelector("#records > tbody > tr:last-child details");
  check("review entry: nothing is loaded when the table is drawn, the label is Show", !unopened.querySelector(".ui-entry") && unopened.querySelector("summary").textContent === "Show");
  check("review entry: a stored entry is shown with red boxes and nothing executable", !!hit.d.querySelector("table.rv-block") && hit.d.querySelectorAll(".rv-red-box").length >= 1 && !hit.d.querySelector("script, img[onerror], a[href^='javascript']") && window.__pwned === undefined && ad.defaultView.__pwned === undefined, hit.d.textContent.slice(0, 120));
  check("review entry: the label is Hide while open and the entry header is not copied into it", hit.d.querySelector("summary").textContent === "Hide");
  hit.d.open = false;
  hit.d.dispatchEvent(new Event("toggle"));
  await sleep(100);
  check("review entry: the label is Show again after closing", hit.d.querySelector("summary").textContent === "Show");
  // an event of gone-1 has no page stored
  const g1ev = g1[0];
  f.value = (g1ev.addonName || "").toLowerCase(); // only the name is searched, the row is told apart by its version
  f.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(400);
  const gRow = [...ad.querySelectorAll("#records > tbody > tr")].find((tr) => tr.children[3].textContent === `${g1ev.addonName} ${g1ev.addonVersion}`);
  const gd = gRow.querySelector("details");
  gd.open = true;
  gd.dispatchEvent(new Event("toggle"));
  await sleep(500);
  check("review entry: an add-on without a stored page says so", /No review page is stored/.test(gd.textContent), gd.textContent.slice(0, 100));

  // 10. Export, wipe, import round trip
  const { buildExport } = await import("./lib/transfer.js");
  const before = await dbRows();
  const exported = JSON.parse(buildExport(before, await entryRows()));
  check("export: the manifests of the entries are in the file", exported.reviewEntries.filter((e) => typeof e.manifest === "string").length === (await entryRows()).filter((e) => e.manifest !== undefined).length && exported.reviewEntries.some((e) => e.manifest));
  check("export: version 8 with events, cells, type and entries, no failures", exported.version === 8 && exported.records.filter((x) => x.type !== undefined).length === before.filter((e) => e.type !== undefined).length && before.some((e) => e.type === "experiment") && exported.count === before.length && !("readFailures" in exported) && exported.records.filter((x) => x.tWait !== undefined).length === before.length && exported.reviewEntries.length === (await entryRows()).length);
  doc = await openPopup();
  doc.getElementById("export").click();
  await sleep(1200);
  check("popup: export message", /^Exported \d+ events and \d+ review entries/.test(doc.getElementById("status").textContent), doc.getElementById("status").textContent);

  const wipeBtn = doc.getElementById("wipe");
  wipeBtn.click();
  check("wipe: the first click only asks", /Sure/.test(wipeBtn.textContent) && (await dbRows()).length === before.length);
  wipeBtn.click();
  await waitFor(async () => (await dbRows()).length === 0, "wiped", 5000);
  const emptied = await (await db()).getAllReviewEntries();
  const lastScan = await (await db()).getMeta("lastScan");
  check("wipe: events, entries and meta are gone", emptied.length === 0 && !lastScan && doc.getElementById("count").textContent === "0", doc.getElementById("count").textContent);
  check("wipe: the settings stay", (await browser.storage.local.get("start")).start === "2025-01-01");

  sideFrame.src = "import/import.html";
  await waitFor(() => sideFrame.contentDocument.getElementById("file"), "import page");
  const idoc = sideFrame.contentDocument;
  async function importText(text) {
    const dt = new DataTransfer();
    dt.items.add(new File([text], "export.json", { type: "application/json" }));
    idoc.getElementById("file").files = dt.files;
    idoc.getElementById("file").dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(100);
    idoc.getElementById("import").click();
    await waitFor(() => /^Done|\.$/.test(idoc.getElementById("status").textContent) && !idoc.getElementById("file").disabled, "import finished", 30000);
    return idoc.getElementById("status").textContent;
  }
  let msg = await importText(JSON.stringify(exported));
  check("import: all events and entries are added", new RegExp(`Done: ${before.length} added, 0 already stored`).test(msg) && new RegExp(`Review entries: ${exported.reviewEntries.length} added`).test(msg), msg);
  const after = await dbRows();
  const cellsKept = before.every((e) => { const x = after.find((y) => y.fingerprint === e.fingerprint); return x && same(x.tSubmission, e.tSubmission) && same(x.tWait, e.tWait) && same(x.queue, e.queue) && x.type === e.type && (x.tSubmission === undefined) === (e.tSubmission === undefined); });
  check("import: the cells survive the round trip", after.length === before.length && cellsKept);
  check("import: the manifests of the entries survive the round trip", (await entryRows()).filter((e) => e.manifest !== undefined).length === exported.reviewEntries.filter((e) => e.manifest !== undefined).length && exported.reviewEntries.some((e) => e.manifest));
  msg = await importText(JSON.stringify(exported));
  check("import: the same file again adds nothing", /Done: 0 added/.test(msg) && /0 added, 0 updated/.test(msg), msg);
  // a file without cells: the events come in pending, a scan fills them from the stored entries without any request
  const bare = { ...exported, records: exported.records.slice(0, 20).map(({ tSubmission, tWait, queue, ...rest }, i) => ({ ...rest, id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, date: `2020-01-01T${String(i).padStart(2, "0")}:15:00`, dateRaw: `Jan. 1, 2020, ${i}:15` })), reviewEntries: [] };
  msg = await importText(JSON.stringify(bare));
  check("import: events without cells are added", /Done: 20 added/.test(msg), msg);
  check("import: they are pending (no cells)", (await (await db()).pendingEvents()).length === 20);
  // a version 3 file with a failure list and a whole page
  const legacyRow = (label, who, when) => `<tr><th>${label}</th><td><div>By <a href="/u/x/">${who}</a> on ${when}</div></td></tr>`;
  const legacyVersion = (v, day, rws) => `<tr class="listing-header"><th colspan="2">Version ${v} &middot; ${day} <span class="light">&middot; Approved</span></th></tr><tr class="listing-body"><td class="files"></td><td><table class="activity">${rws}</table></td></tr>`;
  const legacy = {
    format: "reviewlog-export", version: 3, records: [],
    readFailures: [{ url: "http://127.0.0.1:8770/x", kind: "review-page", slug: "x", status: 503, error: "HTTP 503", count: 2 }],
    reviewPages: [{ addonSlug: "brand-new", url: "http://127.0.0.1:8770/en-US/reviewers/review/brand-new", html: `<!DOCTYPE html><html><body><div id="review-files-paginate"></div><table id="review-files">${legacyVersion("2.0", "Jan. 2, 2026", legacyRow("", "Dev", "Jan. 2, 2026, 8 a.m."))}${legacyVersion("1.0", "Jan. 1, 2026", "")}</table></body></html>` }]
  };
  msg = await importText(JSON.stringify(legacy));
  const brandNew = await (await db()).getEntriesOf("brand-new");
  check("import: a legacy file's whole page is cut into entries, its failures are ignored", brandNew.length === 2 && brandNew.some((e) => e.oldest) && !(await indexedDB.databases()).some((d) => d.name === "readFailures"), msg);

  // 11. A scan fills the cells of imported events from the site
  await ctl("reset=1&n=230");
  await (await db()).wipeAll();
  doc = await openPopup();
  r = await runScan(doc, tab, { mode: "range", start: "2026-11-02", end: "2026-11-03" });
  const firstCount = (await dbRows()).length;
  check("range scan into an empty store: only that range is stored, with cells", firstCount > 0 && firstCount < 230 && r.s.skipped === 0, firstCount);
  r = await runScan(doc, tab, { mode: "range", start: "2026-10-01", end: "2026-11-01" });
  check("a range before the stored data is added, the rest is kept", (await dbRows()).length === 230 && r.s.added === 230 - firstCount, `${(await dbRows()).length} ${JSON.stringify(r.s)}`);
  diffs = await compareWithOracle();
  check("both ranges: all cells equal the oracle", diffs.length === 0, diffs.slice(0, 3).join(" / "));

  // 12. Cancel
  await (await db()).wipeAll();
  await ctl("delay=600");
  const run1 = (await state(tab)).runId;
  doc.querySelector('input[name="mode"][value="new"]').click();
  doc.getElementById("start").value = "2025-01-01";
  doc.getElementById("scan").click();
  await waitFor(async () => (await state(tab)).runId > run1 && (await state(tab)).page >= 1, "first page", 10000);
  await waitFor(() => doc.getElementById("scan-buttons").classList.contains("running"), "cancel button", 5000);
  check("running: Wipe is disabled, Scan is disabled", doc.getElementById("wipe").disabled && doc.getElementById("scan").disabled);
  const refused = await sendMsg({ cmd: "wipeAll" }).then(() => false, () => true);
  check("running: the background refuses to wipe", refused);
  doc.getElementById("cancel").click();
  const sc = await finished(tab);
  await sleep(700);
  check("cancel: phase cancelled and message in the popup", sc.phase === "cancelled" && /Cancelled/.test(doc.getElementById("status").textContent), doc.getElementById("status").textContent);
  await ctl("delay=0");

  // 13. Upgrade of a scratch database of the previous build (version 6)
  const result = await upgradeCheck();
  check("upgrade 3 to 10: empty events and None data removed, failures, pages and coverage gone, entries cut", result.ok, JSON.stringify(result));

  const purge = await purgeCheck();
  check("upgrade 8 to 10: the entries of versions rejected after the announcement, and the cleaned ones of versions from then on, are purged, all events of those versions lose their cells", purge.ok, JSON.stringify(purge));

  await sleep(300);
  await fetch(`${SITE}/report`, { method: "POST", body: JSON.stringify({ type: "finished", checks }) });
}

async function purgeCheck() {
  const { upgradeSchema } = await db();
  const name = "scratch-purge";
  await new Promise((res) => { const d = indexedDB.deleteDatabase(name); d.onsuccess = d.onerror = res; });
  await new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 8);
    req.onupgradeneeded = () => {
      const d = req.result;
      const ev = d.createObjectStore("events", { keyPath: "id" });
      ev.createIndex("date", "date");
      ev.createIndex("fingerprint", "fingerprint", { unique: true });
      d.createObjectStore("meta", { keyPath: "key" });
      const en = d.createObjectStore("reviewEntries", { keyPath: "id" });
      en.createIndex("slugVersion", ["addonSlug", "version"], { unique: true });
      en.createIndex("addonSlug", "addonSlug");
      const entry = (id, version, label, raw = false) => ({ id, addonSlug: "a", version, state: "Approved", html: `<table id="review-files"><tbody><tr class="listing-header"><th colspan="2">Version ${version}</th></tr><tr class="listing-body"><td>${raw ? '<a class="reviewers-install" href="/x">All Platforms</a>' : ""}<table><tr><th>${label}</th><td><div>By x on Jan. 1, 2026</div></td></tr></table></td></tr></tbody></table>` });
      en.add(entry("e1", "1", " Rejected "));
      en.add(entry("e2", "2", "Approved", true)); // as the site sent it, with the file link
      en.add(entry("e4", "4", "Approved")); // cleaned, and approved after the announcement
      en.add(entry("e3", "3", "Rejected"));
      const evt = (id, version, date, event) => ({ id, fingerprint: id, date, event, addonSlug: "a", addonVersion: version, tSubmission: "2026-01-01T00:00:00", tWait: 0.4, queue: "update" });
      ev.add(evt("v1", "1", "2026-05-01T10:00:00", "Rejected")); // after the announcement
      ev.add(evt("v1b", "1", "2026-05-02T10:00:00", "Commented")); // same version, a later event
      ev.add(evt("v2", "2", "2026-05-03T10:00:00", "Approved"));
      ev.add(evt("v3", "3", "2026-01-01T10:00:00", "Rejected")); // before the announcement
      ev.add(evt("v4", "4", "2026-05-04T10:00:00", "Approved"));
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
  const upgraded = await new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 10);
    req.onupgradeneeded = (ev) => upgradeSchema(req.result, req.transaction, ev.oldVersion);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const all = (store) => new Promise((res) => { const q = upgraded.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); });
  const entries = (await all("reviewEntries")).map((x) => x.version);
  const events = await all("events");
  upgraded.close();
  indexedDB.deleteDatabase(name);
  const cells = (id) => { const e = events.find((x) => x.id === id); return e.tSubmission === undefined && e.tWait === undefined && e.queue === undefined; };
  return { entries, ok: entries.join() === "2,3" && cells("v1") && cells("v1b") && !cells("v2") && !cells("v3") && cells("v4") };
}

async function upgradeCheck() {
  const { upgradeSchema, convertLegacyPages } = await db();
  const name = "scratch-upgrade";
  await new Promise((res) => { const d = indexedDB.deleteDatabase(name); d.onsuccess = d.onerror = res; });
  await new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 3);
    req.onupgradeneeded = () => {
      const d = req.result;
      const ev = d.createObjectStore("events", { keyPath: "id" });
      ev.createIndex("date", "date");
      ev.createIndex("fingerprint", "fingerprint", { unique: true });
      ev.createIndex("reviewer", "reviewer");
      ev.createIndex("event", "event");
      d.createObjectStore("meta", { keyPath: "key" });
      d.createObjectStore("readFailures", { keyPath: "url" });
      const pages = d.createObjectStore("reviewPages", { keyPath: "id" });
      pages.createIndex("addonSlug", "addonSlug", { unique: true });
      const e = (id, fp, event, slug) => ({ id, fingerprint: fp, date: "2026-01-01T10:00:00", event, addonSlug: slug, reviewer: "x" });
      ev.add(e("1", "a", "Approved", "keep-me"));
      ev.add(e("2", "b", "", "unlisted-one"));
      ev.add(e("3", "c", "Rejected", "None"));
      req.transaction.objectStore("meta").put({ key: "coverage", value: [] });
      req.transaction.objectStore("meta").put({ key: "inaccessible", value: [{ slug: "None" }, { slug: "keep-me" }] });
      req.transaction.objectStore("readFailures").put({ url: "u" });
      const row = '<tr><th></th><td><div>By <a href="/u/">Dev</a> on Jan. 1, 2026, 8 a.m.</div></td></tr>';
      const v = (n, day) => `<tr class="listing-header"><th colspan="2">Version ${n} &middot; ${day} <span class="light">&middot; Approved</span></th></tr><tr class="listing-body"><td class="files"></td><td><table class="activity">${row}</table></td></tr>`;
      pages.add({ id: "p", addonSlug: "keep-me", fetchedAt: "2026-01-02T00:00:00.000Z", html: `<html><body><div id="review-files-paginate"></div><table id="review-files">${v("2", "Jan. 2, 2026")}${v("1", "Jan. 1, 2026")}</table></body></html>` });
      pages.add({ id: "q", addonSlug: "None", fetchedAt: "2026-01-02T00:00:00.000Z", html: "<html></html>" });
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
  const upgraded = await new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 10);
    req.onupgradeneeded = (ev) => upgradeSchema(req.result, req.transaction, ev.oldVersion);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const converted = await convertLegacyPages(upgraded, 1);
  const stores = [...upgraded.objectStoreNames].sort().join();
  const get = (s, store, key) => new Promise((res) => { const q = upgraded.transaction(s).objectStore(store).get(key); q.onsuccess = () => res(q.result); });
  const all = (store) => new Promise((res) => { const q = upgraded.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); });
  const events = await all("events");
  const entries = await all("reviewEntries");
  const meta = await get("meta", "meta", "coverage");
  const inacc = await get("meta", "meta", "inaccessible");
  const indexes = [...upgraded.transaction("events").objectStore("events").indexNames].sort().join();
  const leftPages = (await all("reviewPages")).length;
  upgraded.close();
  indexedDB.deleteDatabase(name);
  const detail = { stores, events: events.map((x) => x.id), entries: entries.map((x) => [x.version, x.oldest]).sort(), meta, inacc: inacc && inacc.value, indexes };
  detail.ok = converted === 1 && leftPages === 0 && stores === "events,meta,reviewEntries,reviewPages" && detail.events.join() === "1" && entries.length === 2 && entries.find((x) => x.version === "1").oldest === true && entries.find((x) => x.version === "2").oldest === false && !meta && inacc.value.length === 1 && indexes === "date,fingerprint";
  return detail;
}

main().catch(async (e) => {
  log(`ERROR ${e.stack || e}`);
  await fetch(`${SITE}/report`, { method: "POST", body: JSON.stringify({ type: "finished", checks, error: `${e.message}\n${e.stack || ""}` }) }).catch(() => {});
});
