/*
 * IndexedDB layer. Stores:
 *   events         the review log, one record per approval, rejection or other event
 *   reviewEntries  one record per version of an add-on, the HTML of its entry on the review page
 *   meta           small values: lastScan, inaccessible
 * Only the background page writes. The popup and the analysis page read.
 */
import "./parser.js";
import { ANNOUNCEMENT, needsTypeCheck, WAITING_EVENT } from "./facts.js";
import { isBadEvent } from "./transfer.js";
import "./reviewpage.js"; // convertLegacyPages cuts whole stored pages into entries

const DB_NAME = "reviewlog";
const DB_VERSION = 15; // 11 has the same schema and data as 10, a build that cleared cells in that upgrade was installed, so the number can not go back. 12 replaces isExperiment by type, 14 renames kind to queue, 15 clears the cells of events without a queue that are not decisions (13 did, but a second pass overwrote it)

let dbPromise = null;

/** Indexes of the events that earlier builds created and nothing uses. */
const UNUSED_EVENT_INDEXES = ["reviewer", "event"];

function createSchema(db) {
  const events = db.createObjectStore("events", { keyPath: "id" });
  events.createIndex("date", "date");
  events.createIndex("fingerprint", "fingerprint", { unique: true });
  db.createObjectStore("meta", { keyPath: "key" });
  createEntryStore(db);
}

/**
 * Review entries are found by the pair add-on slug and version (a unique index over both). The id is a UUID, slug and
 * version are only used to find the record. `oldest` is true for the entry of the oldest version of an add-on (the page it
 * came from had no link to older versions). Nothing is kept per add-on: what is up to date is read from the entries and the events.
 */
function createEntryStore(db) {
  const entries = db.createObjectStore("reviewEntries", { keyPath: "id" });
  entries.createIndex("slugVersion", ["addonSlug", "version"], { unique: true });
  entries.createIndex("addonSlug", "addonSlug");
}

/** Walks a store inside an upgrade transaction. visit(value, cursor) may delete the record. */
function eachRecord(store, visit) {
  const cursor = store.openCursor();
  cursor.onsuccess = () => {
    const c = cursor.result;
    if (c) {
      visit(c.value, c);
      c.continue();
    }
  };
}

/** Steps for databases of earlier builds. */

/** Version 4: rows about unlisted versions are ignored. An older parser stored them with an empty event. */
function dropEmptyEvents(tx) {
  eachRecord(tx.objectStore("events"), (e, c) => {
    if (e.event === "") {
      c.delete();
    }
  });
}

/** Version 5: add-ons without a slug are ignored. Their events, the placeholder page, failures and skip entry are removed. */
function dropNoSlugData(db, tx) {
  eachRecord(tx.objectStore("events"), (e, c) => {
    if (e.addonSlug === "None") {
      c.delete();
    }
  });
  if (db.objectStoreNames.contains("reviewPages")) {
    const pages = tx.objectStore("reviewPages");
    const key = pages.index("addonSlug").getKey("None");
    key.onsuccess = () => key.result !== undefined && pages.delete(key.result);
  }
  const meta = tx.objectStore("meta");
  const skip = meta.get("inaccessible");
  skip.onsuccess = () => {
    if (skip.result && skip.result.value.some((x) => x.slug === "None")) {
      meta.put({ key: "inaccessible", value: skip.result.value.filter((x) => x.slug !== "None") });
    }
  };
}

/** Version 8: no read failure log, no scanned ranges, no indexes that nothing uses. */
function removeUnusedData(db, tx) {
  if (db.objectStoreNames.contains("readFailures")) {
    db.deleteObjectStore("readFailures");
  }
  tx.objectStore("meta").delete("coverage");
  const events = tx.objectStore("events");
  for (const name of UNUSED_EVENT_INDEXES) {
    if (events.indexNames.contains(name)) {
      events.deleteIndex(name);
    }
  }
}

/**
 * Version 9: entries are stored as fetched (earlier builds removed the links and more). The entries of versions that were
 * rejected on or after the announcement are removed, and every event of those versions loses its cells, so the next scan
 * fetches the entries again.
 */
function purgeRejectedEntries(tx) {
  const purged = new Set();
  const key = (slug, version) => `${slug}\u001f${version}`;
  const resetCells = () => eachRecord(tx.objectStore("events"), (e, c) => {
    if (e.tSubmission !== undefined && purged.has(key(e.addonSlug, e.addonVersion))) {
      const { tSubmission, tWait, kind, ...rest } = e;
      c.update(rest);
    }
  });
  const dropEntries = () => {
    const cursor = tx.objectStore("reviewEntries").openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) {
        resetCells();
        return;
      }
      if (rejected.has(key(c.value.addonSlug, c.value.version))) {
        purged.add(key(c.value.addonSlug, c.value.version));
        c.delete();
      }
      c.continue();
    };
  };
  const rejected = new Set();
  const events = tx.objectStore("events").index("date").openCursor(IDBKeyRange.lowerBound(ANNOUNCEMENT));
  events.onsuccess = () => {
    const c = events.result;
    if (!c) {
      dropEntries();
      return;
    }
    if (c.value.event === "Rejected") {
      rejected.add(key(c.value.addonSlug, c.value.addonVersion));
    }
    c.continue();
  };
}

/**
 * Version 10: the isExperiment field is wanted for every version of the announcement and later, and its manifest is found through the
 * links of the entry. An entry that an earlier build stored without them (links turned into text, no file link) is removed for
 * the versions that have an event from the announcement on or were submitted then, and every event of such a version loses its cells,
 * so the next scan fetches the entry again as the site sends it.
 */
function purgeCleanedEntries(tx) {
  const key = (e) => `${e.addonSlug}\u001f${e.addonVersion}`;
  const wanted = new Set();
  const purged = new Set();
  const events = tx.objectStore("events").openCursor();
  events.onsuccess = () => {
    const c = events.result;
    if (c) {
      const e = c.value;
      if (e.event !== WAITING_EVENT && ((e.date && e.date >= ANNOUNCEMENT) || (e.tSubmission && e.tSubmission >= ANNOUNCEMENT))) {
        wanted.add(key(e));
      }
      c.continue();
      return;
    }
    const entries = tx.objectStore("reviewEntries").openCursor();
    entries.onsuccess = () => {
      const ec = entries.result;
      if (ec) {
        const k = `${ec.value.addonSlug}\u001f${ec.value.version}`;
        if (wanted.has(k) && !ec.value.html.includes("reviewers-install")) {
          purged.add(k);
          ec.delete();
        }
        ec.continue();
        return;
      }
      eachRecord(tx.objectStore("events"), (e, cc) => {
        if (e.event !== WAITING_EVENT && e.tSubmission !== undefined && purged.has(key(e))) {
          const { tSubmission, tWait, kind, ...rest } = e;
          cc.update(rest);
        }
      });
    };
  };
}

/**
 * The steps of versions 12 to 15 on the events, all in one pass. Separate passes over the same store would overwrite each other: a pass writes the
 * record as it read it, before the changes of the other pass.
 * 12: the type (webextension, experiment, theme or legacy) replaces isExperiment. true becomes "experiment", false "webextension", null (no answer) no type, which the next scan asks again.
 * 14: the field kind is called queue, the value stays.
 * 15 (and 13, which this replaces): every event of a version has its queue, not only the decisions. An event that is no decision and has none loses its
 * cells (tSubmission, tWait, queue), so the next scan works them out again from the stored entries. Nothing else changes.
 */
function upgradeEvents(tx, from) {
  eachRecord(tx.objectStore("events"), (e, c) => {
    let out = e;
    if (from < 12 && "isExperiment" in out) {
      const { isExperiment, ...rest } = out;
      out = isExperiment === true ? { ...rest, type: "experiment" } : isExperiment === false ? { ...rest, type: "webextension" } : rest;
    }
    if (from < 14 && "kind" in out) {
      const { kind, ...rest } = out;
      out = { ...rest, queue: kind };
    }
    if (from < 15 && out.event !== WAITING_EVENT && out.event !== "Approved" && out.event !== "Rejected" && out.tSubmission !== undefined && !out.queue) {
      const { tSubmission, tWait, queue, ...rest } = out;
      out = rest;
    }
    if (out !== e) {
      c.update(out);
    }
  });
}

/** Creates the schema, or brings the database of an earlier build (version `from`) to the current one. */
export function upgradeSchema(db, tx, from) {
  if (from === 0) {
    createSchema(db);
    return;
  }
  if (from < 4) {
    dropEmptyEvents(tx);
  }
  if (from < 5) {
    dropNoSlugData(db, tx);
  }
  if (from < 7) {
    createEntryStore(db); // stored whole pages stay, convertLegacyPages cuts them into entries after the upgrade, in the background
  }
  if (from < 8) {
    removeUnusedData(db, tx);
  }
  if (from < 9) {
    purgeRejectedEntries(tx);
  }
  if (from < 10) {
    purgeCleanedEntries(tx);
  }
  if (from < 15) {
    upgradeEvents(tx, from);
  }
}

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => upgradeSchema(req.result, req.transaction, event.oldVersion);
      req.onsuccess = () => {
        const db = req.result;
        // a newer version of the add-on wants to upgrade: give way instead of blocking it
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onblocked = () => {
        // another page of this add-on (an old tab) still holds the old version, the upgrade would wait forever
        dbPromise = null;
        reject(new Error("The database upgrade is blocked by another open page of this add-on. Close its other tabs and reopen this page."));
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const store = async (name, mode = "readonly") => (await openDb()).transaction(name, mode).objectStore(name);

/* ---------- events ---------- */

/**
 * Duplicate check only, never used as a key. The hash covers the fields that make an event the same event when the log
 * is scanned again. It is the identifier that comes back for an event that is scanned a second time.
 */
export async function fingerprint(r) {
  const text = [r.dateRaw, r.siteAddonId, r.addonVersion, r.event, r.reviewer].join("\u001f");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The record as it is stored. keepIds: the id and scan time of a file are kept. */
async function toStored(r, keepIds) {
  const out = {
    id: (keepIds && r.id) || crypto.randomUUID(),
    date: r.date,
    dateRaw: r.dateRaw,
    event: r.event,
    reviewer: r.reviewer,
    comment: r.comment,
    addonName: r.addonName,
    addonVersion: r.addonVersion,
    addonSlug: r.addonSlug,
    siteAddonId: r.siteAddonId,
    reviewUrl: r.reviewUrl || "",
    fingerprint: await fingerprint(r),
    scannedAt: (keepIds && r.scannedAt) || new Date().toISOString()
  };
  if (r.tSubmission !== undefined) {
    Object.assign(out, { tSubmission: r.tSubmission, tWait: r.tWait, queue: r.queue });
  } else if (r.queue !== undefined) {
    out.queue = r.queue; // a waiting row: the queue it was read in
  }
  if (r.type !== undefined) {
    out.type = r.type;
  }
  return out;
}

/** Adds prepared records. A record with a fingerprint that is stored already is skipped. Returns { added, skipped }. */
async function addPrepared(prepared) {
  const events = await store("events", "readwrite");
  const counts = { added: 0, skipped: 0 };
  for (const rec of prepared) {
    const req = events.add(rec);
    req.onsuccess = () => {
      counts.added++;
    };
    req.onerror = (e) => {
      if (req.error && req.error.name === "ConstraintError") { // the same event is stored already
        e.preventDefault();
        e.stopPropagation();
        counts.skipped++;
      }
    };
  }
  await done(events.transaction);
  return counts;
}

/** Adds the events that are not stored yet (same fingerprint = stored). Returns { added, skipped }. */
async function insertEvents(records, keepIds) {
  const prepared = [];
  for (const r of records) {
    prepared.push(await toStored(r, keepIds));
  }
  return addPrepared(prepared);
}

const versionKey = (e) => `${e.addonSlug}\u001f${e.addonVersion}`;

/** The add-on and version of every entry of the log that is not a waiting row. */
async function decidedVersions() {
  return new Set((await getAllEvents()).filter((e) => e.event !== WAITING_EVENT).map(versionKey));
}

/**
 * Adds the waiting rows that the queue pages made. Like any entry, one that is stored is skipped. A version that has another
 * entry in the log already (it was decided, or a reviewer asked for information) is not added. Returns { added, skipped }.
 */
export async function addWaiting(records) {
  const known = await decidedVersions();
  const prepared = [];
  for (const r of records.filter((x) => !known.has(versionKey(x)))) {
    prepared.push(await toStored(r, false));
  }
  const counts = await addPrepared(prepared);
  counts.skipped += records.length - prepared.length;
  return counts;
}

/**
 * Removes the waiting rows of versions that have another entry in the log now, or whose stored review entry does not say
 * "Awaiting Review" any more (disabled or deleted without a review). Returns the number removed.
 */
export async function cleanupWaiting() {
  const known = await decidedVersions();
  for (const entry of await getAllReviewEntries()) {
    if (entry.state && entry.state !== WAITING_EVENT) {
      known.add(versionKey({ addonSlug: entry.addonSlug, addonVersion: entry.version }));
    }
  }
  const events = await store("events", "readwrite");
  let removed = 0;
  const cursor = events.openCursor();
  cursor.onsuccess = () => {
    const c = cursor.result;
    if (c) {
      if (c.value.event === WAITING_EVENT && known.has(versionKey(c.value))) {
        c.delete();
        removed++;
      }
      c.continue();
    }
  };
  await done(events.transaction);
  return removed;
}

/** Removes the rows that have no event, no add-on slug and no version (see isBadEvent), and nothing else. Returns the number of rows removed. */
export async function removeBadEvents() {
  const events = await store("events", "readwrite");
  let removed = 0;
  const cursor = events.openCursor();
  cursor.onsuccess = () => {
    const c = cursor.result;
    if (c) {
      if (isBadEvent(c.value)) {
        c.delete();
        removed++;
      }
      c.continue();
    }
  };
  await done(events.transaction);
  return removed;
}

/** Events of a scan. */
export const addEvents = (records) => insertEvents(records, false);

/** Events of a file. They keep their id, scan time and, if they have them, their cells. */
export const importEvents = (records) => insertEvents(records, true);

export async function countEvents() {
  return wrap((await store("events")).count());
}

export async function getAllEvents() {
  return wrap((await store("events")).getAll());
}

/** The day (YYYY-MM-DD) of the newest stored event, or "" if there is none. */
export async function newestEventDay() {
  const cursor = await wrap((await store("events")).index("date").openCursor(null, "prev"));
  return cursor && cursor.value.date ? cursor.value.date.slice(0, 10) : "";
}

/** Number of stored events between two days (both inclusive, empty = open). */
export async function countInRange(start, end) {
  const lower = start ? `${start}T00:00:00` : null;
  const upper = end ? `${end}T23:59:59` : null;
  let range = null;
  if (lower && upper) {
    range = IDBKeyRange.bound(lower, upper);
  } else if (lower) {
    range = IDBKeyRange.lowerBound(lower);
  } else if (upper) {
    range = IDBKeyRange.upperBound(upper);
  }
  return wrap((await store("events")).index("date").count(range));
}

/** Events whose review details are not looked up yet (they have no cells). slug: only those of one add-on. */
export async function pendingEvents(slug) {
  const all = await getAllEvents();
  return all.filter((e) => e.tSubmission === undefined && (slug === undefined || e.addonSlug === slug));
}

/** Writes the cells of events: [{ id, tSubmission, tWait, queue }]. */
export async function saveFacts(updates) {
  const events = await store("events", "readwrite");
  for (const { id, tSubmission, tWait, queue } of updates) {
    const get = events.get(id);
    get.onsuccess = () => get.result && events.put({ ...get.result, tSubmission, tWait, queue });
  }
  await done(events.transaction);
}

/** Keeps the text of manifest.json with the entry of its version. Nothing happens if there is no entry. */
export async function saveManifest(slug, version, text) {
  const entries = await store("reviewEntries", "readwrite");
  const find = entries.index("slugVersion").get([slug, version]);
  find.onsuccess = () => find.result && entries.put({ ...find.result, manifest: text });
  await done(entries.transaction);
}

/** Events that still need their type. */
export async function pendingFileChecks() {
  return (await getAllEvents()).filter(needsTypeCheck);
}

/** Writes the type of events: [{ id, type }]. The other cells stay as they are. */
export async function saveType(updates) {
  const events = await store("events", "readwrite");
  for (const { id, type } of updates) {
    const get = events.get(id);
    get.onsuccess = () => get.result && events.put({ ...get.result, type });
  }
  await done(events.transaction);
}

const REQUEST_LOG_MAX = 5000;

/** Adds requests to the log of the requested addresses: [{ t, url, status }], status is the HTTP status or 0 if there was none. The newest REQUEST_LOG_MAX are kept. */
export async function addRequests(items) {
  const log = ((await getMeta("requestLog")) || []).concat(items);
  await setMeta("requestLog", log.slice(-REQUEST_LOG_MAX));
}

export async function getRequests() {
  return (await getMeta("requestLog")) || [];
}

/* ---------- meta ---------- */

export async function getMeta(key) {
  const row = await wrap((await store("meta")).get(key));
  return row ? row.value : undefined;
}

export async function setMeta(key, value) {
  const meta = await store("meta", "readwrite");
  meta.put({ key, value });
  await done(meta.transaction);
}

/**
 * Add-ons whose review page the site does not show to this user (it redirects to the review queue, for example for the
 * reviewer's own add-ons). They are not fetched again.
 */
export async function getInaccessible() {
  return (await getMeta("inaccessible")) || [];
}

export async function addInaccessible(slug) {
  const list = await getInaccessible();
  if (!list.some((x) => x.slug === slug)) {
    await setMeta("inaccessible", [...list, { slug, since: new Date().toISOString() }]);
  }
}

/* ---------- review entries ---------- */

export async function countReviewEntries() {
  return wrap((await store("reviewEntries")).count());
}

export async function getAllReviewEntries() {
  return wrap((await store("reviewEntries")).getAll());
}

/** The entry of one version of one add-on, or undefined. */
export async function getReviewEntry(slug, version) {
  return wrap((await store("reviewEntries")).index("slugVersion").get([slug, version]));
}

/** All stored entries of one add-on. */
export async function getEntriesOf(slug) {
  return wrap((await store("reviewEntries")).index("addonSlug").getAll(slug));
}

/**
 * Stores the entries of one fetched review page. The entry of a version that is stored already is overwritten in place
 * and keeps its id. The last entry of a page without a link to older versions is the oldest one of the add-on.
 * page: { addonSlug, fetchedAt, more, entries: [{ version, headerDateText, state, html }] }. Returns { added, updated }.
 */
export async function saveEntries(page) {
  const entries = await store("reviewEntries", "readwrite");
  const counts = { added: 0, updated: 0 };
  page.entries.forEach((e, i) => {
    const find = entries.index("slugVersion").get([page.addonSlug, e.version]);
    find.onsuccess = () => {
      const old = find.result;
      counts[old ? "updated" : "added"]++;
      entries.put({
        id: old ? old.id : crypto.randomUUID(), addonSlug: page.addonSlug, version: e.version,
        headerDateText: e.headerDateText, state: e.state, html: e.html, fetchedAt: page.fetchedAt,
        oldest: !!(old && old.oldest) || (!page.more && i === page.entries.length - 1),
        ...(old && old.manifest !== undefined ? { manifest: old.manifest } : {}) // the manifest of the file is not part of the page
      });
    };
  });
  await done(entries.transaction);
  return counts;
}

/**
 * Entries from a file. One is added if its version is not stored, and replaces the stored one only if it was fetched later.
 * Returns { added, updated, kept }.
 */
export async function importEntries(records) {
  const entries = await store("reviewEntries", "readwrite");
  const counts = { added: 0, updated: 0, kept: 0 };
  for (const e of records) {
    const find = entries.index("slugVersion").get([e.addonSlug, e.version]);
    find.onsuccess = () => {
      const old = find.result;
      if (old && (old.fetchedAt || "") >= (e.fetchedAt || "")) {
        counts.kept++;
        if (e.manifest !== undefined && old.manifest === undefined) {
          entries.put({ ...old, manifest: e.manifest }); // the manifest of the file is not part of the page, it is added
        }
        return;
      }
      counts[old ? "updated" : "added"]++;
      entries.put({
        id: old ? old.id : (e.id || crypto.randomUUID()), addonSlug: e.addonSlug, version: e.version,
        headerDateText: e.headerDateText, state: e.state, html: e.html, fetchedAt: e.fetchedAt || new Date().toISOString(),
        oldest: e.oldest || !!(old && old.oldest),
        ...(e.manifest !== undefined ? { manifest: e.manifest } : old && old.manifest !== undefined ? { manifest: old.manifest } : {})
      });
    };
  }
  await done(entries.transaction);
  return counts;
}

/* ---------- whole pages of earlier builds ---------- */

/**
 * Cuts the whole review pages that an earlier build stored (store reviewPages) into entries, a few at a time, and removes
 * each page when it is done. An entry that exists already is kept, it is newer. A page that can not be cut is dropped, the
 * next scan fetches it again. Returns the number of pages that were converted. db: the database, by default the real one.
 */
export async function convertLegacyPages(db = null, batch = 10) {
  db = db || (await openDb());
  if (!db.objectStoreNames.contains("reviewPages")) {
    return 0;
  }
  let converted = 0;
  for (;;) {
    const pages = await wrap(db.transaction("reviewPages").objectStore("reviewPages").getAll(null, batch));
    if (pages.length === 0) {
      return converted;
    }
    const cut = pages.map((page) => {
      try {
        const sliced = globalThis.ReviewPage.sliceReviewPage(page.html);
        return sliced.entries.map((e, i) => ({
          id: crypto.randomUUID(), addonSlug: page.addonSlug, version: e.version, headerDateText: e.headerDateText,
          state: e.state, html: e.html, fetchedAt: page.fetchedAt || new Date().toISOString(), oldest: !sliced.more && i === sliced.entries.length - 1
        }));
      } catch (e) {
        return [];
      }
    });
    const tx = db.transaction(["reviewEntries", "reviewPages"], "readwrite");
    const entries = tx.objectStore("reviewEntries");
    cut.flat().forEach((entry) => {
      const find = entries.index("slugVersion").get([entry.addonSlug, entry.version]);
      find.onsuccess = () => !find.result && entries.add(entry);
    });
    pages.forEach((page) => tx.objectStore("reviewPages").delete(page.id));
    await done(tx);
    converted += pages.length;
    await new Promise((resolve) => setTimeout(resolve, 0)); // the pages that wait for the database get their turn
  }
}

/* ---------- everything ---------- */

/** Removes all stored data: the events, the entries and the small values. */
export async function wipeAll() {
  const db = await openDb();
  const names = ["events", "reviewEntries", "meta", ...(db.objectStoreNames.contains("reviewPages") ? ["reviewPages"] : [])];
  const tx = db.transaction(names, "readwrite");
  names.forEach((name) => tx.objectStore(name).clear());
  await done(tx);
}
