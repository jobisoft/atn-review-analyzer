/*
 * The background page: receives the messages of the content script (the scan) and of the extension pages (popup, import page),
 * checks every payload, and does all the work with the database. What to fetch next is decided here, the content script
 * only fetches (only it has the session of the logged in user).
 */
import {
  addEvents, addInaccessible, addRequests, addWaiting, cleanupWaiting, convertLegacyPages, countInRange, getAllEvents, getAllReviewEntries, getEntriesOf, getInaccessible, getMeta, getReviewEntry, importEntries, importEvents, newestEventDay,
  pendingEvents, pendingFileChecks, removeBadEvents, saveEntries, saveFacts, saveManifest, saveType, setMeta, wipeAll
} from "./lib/db.js";
import { AddonView, factsFor, fileIdOf, installRdfUrl, isThemeEntry, manifestType, manifestUrl, needsFirstPage, needsOlderPage, TYPES, WAITING_EVENT } from "./lib/facts.js";
import { cleanEntry, cleanEvent, cleanPage, isDay, LIMITS } from "./lib/transfer.js";
import * as tracker from "./lib/tracker.js";

const MAX_PAGES = 200; // history pages per add-on, the largest add-on has 81 (10 versions each)
const EPOCH = "1970-01-01T00:00:00.000Z"; // fetch time of a page from a file that does not say, a stored entry wins

/** The walks that are under way: slug -> { view, events }. Rebuilt from the database if the page was unloaded meanwhile. */
const walks = new Map();

const sliceReviewPage = (html) => globalThis.ReviewPage.sliceReviewPage(html);

function check(ok, what) {
  if (!ok) {
    throw new Error(`invalid ${what}`);
  }
}

const isSlug = (v) => typeof v === "string" && v !== "" && v.length <= LIMITS.slug;
const asList = (v, max, what) => {
  check(Array.isArray(v) && v.length <= max, what);
  return v;
};

async function viewOf(slug) {
  const view = new AddonView();
  for (const entry of await getEntriesOf(slug)) {
    view.add(entry);
  }
  return view;
}

/** Writes the cells of the events of an add-on. */
async function writeFacts(events, view, options) {
  await saveFacts(events.map((ev) => ({ id: ev.id, ...factsFor(view, ev, options) })));
}

/** The origin of an address, ATN if it is not one. */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (e) {
    return "https://addons.thunderbird.net";
  }
}

/** The type for the events of a version that do not have it yet. */
async function writeType(slug, version, type) {
  // it is a fact of the version, so every event of the version gets it, also one that is older than the announcement
  const ids = (await getAllEvents()).filter((ev) => ev.addonSlug === slug && ev.addonVersion === version && ev.type === undefined).map((ev) => ev.id);
  await saveType(ids.map((id) => ({ id, type })));
}

/**
 * The type of every event from what is stored, without a request: the manifest of the entry of its version (experiment, theme or webextension), else a download
 * link and no Contents link (theme). An event whose type differs gets the one found here, one that nothing is found for keeps what it has (a legacy add-on has
 * neither). It brings the events of an earlier build to the rules of today, a theme with a manifest was a WebExtension before.
 */
async function recheckStoredTypes() {
  const found = new Map(); // slug and version -> type
  for (const entry of await getAllReviewEntries()) {
    const type = typeof entry.manifest === "string" ? manifestType(entry.manifest)
      : !entry.html.includes("files/browse/") && isThemeEntry(entry.html) ? "theme" : null; // the text test saves parsing the page of nearly every entry
    if (type) {
      found.set(`${entry.addonSlug}\u001f${entry.version}`, type);
    }
  }
  const updates = (await getAllEvents()).filter((ev) => {
    const type = found.get(`${ev.addonSlug}\u001f${ev.addonVersion}`);
    return type && ev.type !== undefined && ev.type !== type;
  }).map((ev) => ({ id: ev.id, type: found.get(`${ev.addonSlug}\u001f${ev.addonVersion}`) }));
  await saveType(updates);
}

/** The text of manifest.json: kept with the entry of the version (if it is not huge), and what it says is written to the events. */
async function finishManifest(slug, version, text) {
  const type = manifestType(text);
  if (text.length <= LIMITS.manifest) {
    await saveManifest(slug, version, text);
  }
  if (type !== null) {
    await writeType(slug, version, type);
  }
  return type;
}

/** The events of an add-on that a walk of its review page works for: those without cells, and those that wait for their manifest. */
async function walkEvents(slug) {
  const events = new Map();
  for (const ev of [...await pendingEvents(slug), ...(await pendingFileChecks()).filter((e) => e.addonSlug === slug)]) {
    events.set(ev.id, ev);
  }
  return [...events.values()];
}

async function startWalk(slug) {
  const events = await walkEvents(slug);
  const view = await viewOf(slug);
  return { events, view };
}

/* ---------- messages of the content script ---------- */

const contentCommands = {
  async addEvents(msg) {
    const records = asList(msg.records, 1000, "records").map(cleanEvent).filter(Boolean);
    return addEvents(records);
  },

  /**
   * The add-ons whose review page has to be fetched, newest first, with the review page URL of their newest event that has one.
   * Add-ons that have events without cells but whose stored entries answer everything get their cells here, without a request.
   * Answers { targets, fromStored } (fromStored: number of add-ons that were resolved from stored data).
   */
  async pendingSlugs() {
    const skip = new Set((await getInaccessible()).map((x) => x.slug));
    const cellsMissing = await pendingEvents();
    const pending = [...cellsMissing, ...(await pendingFileChecks()).filter((ev) => !skip.has(ev.addonSlug))] // also those that wait for a manifest, the entry may need to be fetched again
      .filter((ev, i, all) => all.findIndex((x) => x.id === ev.id) === i)
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const bySlug = new Map();
    const noAccess = [];
    for (const ev of pending) {
      if (skip.has(ev.addonSlug)) { // only events without cells get here
        noAccess.push({ id: ev.id, tSubmission: null, tWait: null, queue: null }); // nothing to look up
      } else if (!bySlug.has(ev.addonSlug)) {
        bySlug.set(ev.addonSlug, { url: ev.reviewUrl || "", events: [] });
      }
      if (bySlug.has(ev.addonSlug)) {
        bySlug.get(ev.addonSlug).events.push(ev);
      }
    }
    await saveFacts(noAccess);
    const targets = [];
    let fromStored = 0;
    for (const [slug, { url, events }] of bySlug) {
      const view = await viewOf(slug);
      if (needsFirstPage(view, events)) {
        targets.push({ slug, url });
      } else {
        await writeFacts(events, view);
        fromStored += events.some((ev) => ev.tSubmission === undefined);
      }
    }
    return { targets, fromStored };
  },

  /** Does the page of this add-on have to be fetched? If not, its events get their cells now. */
  async reviewStart(msg) {
    check(isSlug(msg.slug), "slug");
    const walk = await startWalk(msg.slug);
    if (walk.events.length === 0) {
      return { fetch: false };
    }
    if (!needsFirstPage(walk.view, walk.events)) {
      await writeFacts(walk.events, walk.view);
      return { fetch: false };
    }
    walks.set(msg.slug, walk);
    return { fetch: true };
  },

  /** A fetched page of the history. Stores its entries, answers with the next page to fetch, or null. */
  async reviewPage(msg) {
    check(isSlug(msg.slug) && Number.isInteger(msg.page) && msg.page >= 1, "review page");
    check(typeof msg.html === "string" && msg.html.length <= LIMITS.page, "html");
    const walk = walks.get(msg.slug) || await startWalk(msg.slug);
    const sliced = sliceReviewPage(msg.html);
    const fetchedAt = new Date().toISOString();
    await saveEntries({ addonSlug: msg.slug, fetchedAt, more: sliced.more, entries: sliced.entries });
    sliced.entries.forEach((e, i) => {
      walk.view.add({ ...e, fetchedAt, oldest: !sliced.more && i === sliced.entries.length - 1 });
    });
    const next = msg.page < MAX_PAGES && needsOlderPage(walk.view, walk.events, sliced.more) ? msg.page + 1 : null;
    if (next === null) {
      await writeFacts(walk.events, walk.view);
      walks.delete(msg.slug);
    } else {
      walks.set(msg.slug, walk);
    }
    return { next };
  },

  /** The page does not exist (404), or the site redirected to the review queue (no access, for example an own add-on). */
  async reviewGone(msg) {
    check(isSlug(msg.slug), "slug");
    const events = await pendingEvents(msg.slug);
    walks.delete(msg.slug);
    if (msg.redirected === true) {
      await addInaccessible(msg.slug);
      await saveFacts(events.map((ev) => ({ id: ev.id, tSubmission: null, tWait: null, queue: null })));
    } else {
      await writeFacts(events, await viewOf(msg.slug), { gone: true });
    }
    return { ok: true };
  },

  /**
   * The files to read for the type of the versions that have events without one. Answers { targets: [{ slug, version, url, installUrl }] }, url is the raw manifest.json
   * and installUrl the raw install.rdf (a redirect to the file). A version whose entry has the manifest is answered from it, without a request. A version whose
   * entry has a download link and no "Contents" link is a theme. A version without files to read (an entry that is not stored, links turned into text, not
   * accessible) gets no type, so it is asked again at the next scan.
   */
  async pendingFiles() {
    await recheckStoredTypes();
    const skip = new Set((await getInaccessible()).map((x) => x.slug));
    const byVersion = new Map();
    for (const ev of (await pendingFileChecks()).sort((a, b) => (b.date || "").localeCompare(a.date || ""))) {
      const key = `${ev.addonSlug}\u001f${ev.addonVersion}`;
      if (!byVersion.has(key)) {
        byVersion.set(key, { slug: ev.addonSlug, version: ev.addonVersion, base: ev.reviewUrl || "", ids: [] });
      }
      byVersion.get(key).ids.push(ev.id);
    }
    const targets = [];
    const answers = []; // events that are answered now
    for (const { slug, version, base, ids } of byVersion.values()) {
      const entry = skip.has(slug) ? null : await getReviewEntry(slug, version);
      if (!entry) {
        continue; // not stored (yet), or not accessible
      }
      const type = typeof entry.manifest === "string" ? manifestType(entry.manifest) : isThemeEntry(entry.html) ? "theme" : null;
      const fileId = fileIdOf(entry.html);
      if (type) {
        answers.push(...ids.map((id) => ({ id, type })));
      } else if (fileId) {
        const origin = originOf(base);
        targets.push({ slug, version, url: manifestUrl(fileId, origin), installUrl: installRdfUrl(fileId, origin) });
      }
    }
    await saveType(answers);
    return { targets };
  },

  /** The raw text of manifest.json. */
  async manifestText(msg) {
    check(isSlug(msg.slug) && typeof msg.version === "string" && msg.version !== "" && msg.version.length <= LIMITS.slug, "manifest");
    check(typeof msg.text === "string" && msg.text.length <= LIMITS.page, "manifest text");
    return { type: await finishManifest(msg.slug, msg.version, msg.text) };
  },

  /** The type of a version that was found without reading a manifest.json (a legacy add-on has install.rdf). Every event of the version without a type gets it. */
  async fileResult(msg) {
    check(isSlug(msg.slug) && typeof msg.version === "string" && msg.version !== "" && msg.version.length <= LIMITS.slug, "file result");
    check(TYPES.includes(msg.type), "type");
    await writeType(msg.slug, msg.version, msg.type);
    return { ok: true };
  },

  /** The requests that the scan made: [{ t, url, status }]. They are kept, the newest 5000, for the page that shows them. */
  async requestLog(msg) {
    const items = asList(msg.items, 500, "requests").map((x) => {
      check(x && typeof x.t === "string" && typeof x.url === "string" && x.url.length <= 2000 && Number.isInteger(x.status), "request");
      return { t: x.t.slice(0, 30), url: x.url, status: x.status };
    });
    await addRequests(items);
    return { ok: true };
  },

  /** Removes the waiting rows that are not waiting any more (the scan calls it after it has read the review details). */
  async cleanupWaiting() {
    return { removed: await cleanupWaiting() };
  },

  /**
   * The waiting versions of one queue ("new" or "update"), as read from its page. They become rows of the log with the event
   * "Awaiting Review", no date and the reviewer "Nobody". Like any entry they are skipped if they are stored, and a version that has
   * another entry in the log is not added.
   */
  async queueRead(msg) {
    check(msg.queue === "new" || msg.queue === "update", "queue");
    const rows = asList(msg.items, 1000, "queue items").map((item) => {
      check(item && typeof item === "object" && Array.isArray(item.flags), "queue item");
      const waiting = typeof item.waiting === "string" ? item.waiting : "";
      return cleanEvent({
        dateRaw: "waiting", date: null, event: WAITING_EVENT, reviewer: "Nobody",
        comment: [waiting && `Waiting ${waiting}.`, item.flags.filter((f) => typeof f === "string").join(", ")].filter(Boolean).join(" "),
        addonName: item.name, addonVersion: item.version, addonSlug: item.slug, siteAddonId: item.siteAddonId, reviewUrl: item.reviewUrl,
        queue: msg.queue
      });
    }).filter(Boolean);
    return addWaiting(rows);
  },

  async finishScan(msg) {
    check(isDay(msg.start) && isDay(msg.end), "range");
    await setMeta("lastScan", { when: new Date().toISOString() });
    await cleanupWaiting(); // a version that was decided, or asked about, since the last scan is not waiting any more
    const removed = await removeBadEvents(); // rows without event, slug and version, which an older parser stored
    return { inRange: await countInRange(msg.start, msg.end), removed };
  },

  async scanEnded(msg, sender) {
    await tracker.scanEnded(sender.tab.id);
    return { ok: true };
  }
};

/* ---------- messages of the extension pages ---------- */

const extensionCommands = {
  getTracker: () => tracker.getTracker(),
  cancelScan: async () => {
    await tracker.cancelScan();
    return { ok: true };
  },
  reconcile: () => tracker.reconcile(),

  /**
   * mode "new": from the day of the newest stored event (the start date if there is none) until today.
   * mode "range": exactly the range that was entered, an empty end is today. Known events are skipped in both.
   */
  async startScan(msg) {
    check(isDay(msg.start) && isDay(msg.end) && (msg.mode === "new" || msg.mode === "range"), "range");
    if (await getMeta("anonymousData")) {
      throw new Error("This profile holds anonymous data, scanning is off. Wipe all data to scan.");
    }
    const start = msg.mode === "new" ? (await newestEventDay()) || msg.start : msg.start;
    const end = msg.mode === "new" ? "" : msg.end;
    if (start && end && start > end) {
      throw new Error("The start date is after the end date.");
    }
    await tracker.startScan({ start, end });
    return { started: true, start, end };
  },

  /** An anonymous file was imported: this profile only shows data, it does not scan (a scan would mix real pages into the fake ones). Wipe all data clears it. */
  async markAnonymous() {
    await setMeta("anonymousData", true);
    return { ok: true };
  },

  async isAnonymous() {
    return { anonymous: !!(await getMeta("anonymousData")) };
  },

  async wipeAll() {
    if ((await tracker.getTracker()).scanning) {
      throw new Error("A scan is running, cancel it first.");
    }
    await wipeAll();
    return { ok: true };
  },

  async importEvents(msg) {
    const events = asList(msg.events, 1000, "events").map(cleanEvent).filter(Boolean);
    return { ...(await importEvents(events)), invalid: msg.events.length - events.length };
  },

  async importEntries(msg) {
    const entries = asList(msg.entries, 200, "entries").map(cleanEntry).filter(Boolean);
    return { ...(await importEntries(entries)), invalid: msg.entries.length - entries.length };
  },

  /** Whole pages of an older file, cut into entries. */
  async importLegacyPages(msg) {
    const pages = asList(msg.pages, 20, "pages").map(cleanPage).filter(Boolean);
    const counts = { added: 0, updated: 0, kept: 0, invalid: msg.pages.length - pages.length };
    for (const page of pages) {
      const sliced = sliceReviewPage(page.html);
      const res = await importEntries(sliced.entries.map((e, i) => ({
        ...e, addonSlug: page.addonSlug, fetchedAt: page.fetchedAt || EPOCH, oldest: !sliced.more && i === sliced.entries.length - 1
      })));
      for (const k of ["added", "updated", "kept"]) {
        counts[k] += res[k];
      }
    }
    return counts;
  }
};

/* ---------- who may send what ---------- */

const EXTENSION_PAGES = browser.runtime.getURL("");
const fromExtensionPage = (sender) => sender.id === browser.runtime.id && typeof sender.url === "string" && sender.url.startsWith(EXTENSION_PAGES);
const fromContentScript = (sender) => sender.id === browser.runtime.id && !!sender.tab && !fromExtensionPage(sender);

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.cmd !== "string") {
    return undefined;
  }
  if (Object.hasOwn(contentCommands, msg.cmd) && fromContentScript(sender)) {
    return contentCommands[msg.cmd](msg, sender);
  }
  if (Object.hasOwn(extensionCommands, msg.cmd) && fromExtensionPage(sender)) {
    return extensionCommands[msg.cmd](msg, sender);
  }
  return undefined;
});

browser.runtime.onStartup.addListener(() => tracker.init());
browser.runtime.onInstalled.addListener(() => tracker.init());
browser.tabs.onRemoved.addListener((tabId) => tracker.onTabRemoved(tabId));
browser.tabs.onUpdated.addListener((tabId, changeInfo) => tracker.onTabUpdated(tabId, changeInfo), {
  properties: ["status", "url", "discarded"]
});

// pages that an earlier build stored are cut into entries in the background, a few at a time
convertLegacyPages().catch((e) => console.error("Converting the stored review pages failed:", e));
