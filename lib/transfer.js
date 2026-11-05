/*
 * The export file, and the checks of everything that comes from outside: a file that is imported, or a message from the
 * content script. Nothing from outside reaches the database without passing one of the clean* functions.
 */

export const FORMAT = "reviewlog-export";
export const VERSION = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WALL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/; // "2026-11-03T23:31:00", the time of the log, no time zone
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NO_SLUG = "None"; // the log links to /reviewers/review/None for an add-on without a slug, such rows are ignored
const TEXT_FIELDS = ["dateRaw", "event", "reviewer", "comment", "addonName", "addonVersion", "addonSlug", "siteAddonId"];
const QUEUES = new Set(["new", "update"]);

export const LIMITS = {
  text: 200000,
  url: 2000,
  slug: 200,
  entryHtml: 5 * 1024 * 1024,
  manifest: 1024 * 1024, // the text of manifest.json of the rejected file
  page: 20 * 1024 * 1024 // a whole review page: from an older file, or just fetched
};

export const isUuid = (v) => typeof v === "string" && UUID.test(v);
export const isWallTime = (v) => typeof v === "string" && WALL_TIME.test(v);
export const isDay = (v) => v === "" || (typeof v === "string" && DAY.test(v));
const isTime = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const isSlug = (v) => typeof v === "string" && v !== "" && v.length <= LIMITS.slug && v !== NO_SLUG;

/** The queue of an event of a file: `queue`, or `kind` in a file of the versions up to 7. */
const queueOf = (r) => ("queue" in r ? r.queue : r.kind);

/** The three cells that are filled when the review details are known. Absent = not looked up yet, null = nothing to find. */
function cleanFacts(r) {
  if (!("tSubmission" in r)) {
    return QUEUES.has(queueOf(r)) ? { queue: queueOf(r) } : {}; // a waiting row has its queue before its details are known
  }
  return {
    tSubmission: isWallTime(r.tSubmission) ? r.tSubmission : null,
    tWait: Number.isFinite(r.tWait) && r.tWait >= 0 ? Math.round(r.tWait * 100) / 100 : null,
    queue: QUEUES.has(queueOf(r)) ? queueOf(r) : null
  };
}

const TYPES = new Set(["webextension", "experiment", "theme", "legacy"]);

/**
 * The type of an event. Absent = not classified, or its files could not be found. A file of the versions up to 6 has isExperiment instead:
 * true is an Experiment, false a WebExtension, null (no answer) no type.
 */
function cleanType(r) {
  if (TYPES.has(r.type)) {
    return { type: r.type };
  }
  return r.isExperiment === true ? { type: "experiment" } : r.isExperiment === false ? { type: "webextension" } : {};
}

/** One event of the log (from a scan or a file). Returns a clean event or null. A malformed id or time is dropped. */
/**
 * A row that the parser of today would not store and that has nothing to be told apart by: no event, no add-on slug and no version (an older parser stored such rows about
 * unlisted versions). Only a row that lacks all three counts. A row that has any of them is kept, also when something else is missing.
 */
export const isBadEvent = (e) => !e.event && !e.addonSlug && !e.addonVersion;

export function cleanEvent(r) {
  if (!r || typeof r !== "object" || r.addonSlug === NO_SLUG) {
    return null;
  }
  const out = {};
  for (const f of TEXT_FIELDS) {
    if (typeof r[f] !== "string" || r[f].length > LIMITS.text) {
      return null;
    }
    out[f] = r[f];
  }
  if (!out.dateRaw || !out.event || !out.addonSlug) { // rows about unlisted versions (no event, no slug) were stored by an older parser
    return null;
  }
  return {
    ...out,
    id: isUuid(r.id) ? r.id : null,
    date: isWallTime(r.date) ? r.date : null,
    reviewUrl: typeof r.reviewUrl === "string" && r.reviewUrl.length <= LIMITS.url ? r.reviewUrl : "",
    scannedAt: isTime(r.scannedAt) ? r.scannedAt : null,
    ...cleanFacts(r),
    ...cleanType(r)
  };
}

/** One entry of a review page: the HTML of one version. Returns a clean entry or null. */
export function cleanEntry(r) {
  if (!r || typeof r !== "object" || !isSlug(r.addonSlug)) {
    return null;
  }
  if (typeof r.version !== "string" || !r.version || r.version.length > LIMITS.slug) {
    return null;
  }
  if (typeof r.html !== "string" || !r.html || r.html.length > LIMITS.entryHtml) {
    return null;
  }
  return {
    id: isUuid(r.id) ? r.id : null,
    addonSlug: r.addonSlug,
    version: r.version,
    headerDateText: text(r.headerDateText, 100),
    state: text(r.state, 100),
    fetchedAt: isTime(r.fetchedAt) ? r.fetchedAt : null,
    oldest: r.oldest === true,
    html: r.html,
    ...(typeof r.manifest === "string" && r.manifest.length <= LIMITS.manifest ? { manifest: r.manifest } : {})
  };
}

/** A whole review page (a file of the versions 2 to 4, or a page that was just fetched). Returns a clean page or null. */
export function cleanPage(r) {
  if (!r || typeof r !== "object" || !isSlug(r.addonSlug)) {
    return null;
  }
  if (typeof r.html !== "string" || !r.html || r.html.length > LIMITS.page) {
    return null;
  }
  return {
    addonSlug: r.addonSlug,
    url: typeof r.url === "string" && r.url.length <= LIMITS.url ? r.url : "",
    fetchedAt: isTime(r.fetchedAt) ? r.fetchedAt : null,
    html: r.html
  };
}

/**
 * Version 2 added reviewUrl to the events and the list of review pages, version 3 the read failures. Version 4 replaced the
 * review pages by entries, version 5 added tSubmission, tWait and kind to the events and dropped the failures, version 6 isExperiment, version 7 the type instead of it, version 8 the queue instead of kind.
 * The fingerprint is derived, it is rebuilt on import. Older files are still read.
 */
export function buildExport(events, entries = [], { anonymous = false } = {}) {
  const records = events.map((e) => {
    const out = { id: e.id, date: e.date };
    for (const f of TEXT_FIELDS) {
      out[f] = e[f];
    }
    out.reviewUrl = e.reviewUrl || "";
    out.scannedAt = e.scannedAt;
    if (e.tSubmission !== undefined) {
      Object.assign(out, { tSubmission: e.tSubmission, tWait: e.tWait, queue: e.queue });
    } else if (e.queue !== undefined) {
      out.queue = e.queue;
    }
    if (e.type !== undefined) {
      out.type = e.type;
    }
    return out;
  });
  const reviewEntries = entries.map((e) => ({
    id: e.id, addonSlug: e.addonSlug, version: e.version, headerDateText: e.headerDateText, state: e.state,
    fetchedAt: e.fetchedAt, oldest: !!e.oldest, html: e.html, ...(e.manifest !== undefined ? { manifest: e.manifest } : {})
  }));
  return JSON.stringify({
    format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), ...(anonymous ? { anonymous: true } : {}),
    count: records.length, reviewEntryCount: reviewEntries.length, records, reviewEntries
  }, null, 1);
}

/** Cleans a list. Returns the clean items, and how many were ignored (add-on without a slug) or unreadable. */
function cleanList(list, clean) {
  const items = [];
  let ignored = 0;
  let invalid = 0;
  for (const r of Array.isArray(list) ? list : []) {
    if (r && typeof r === "object" && r.addonSlug === NO_SLUG) {
      ignored++;
    } else {
      const c = clean(r);
      if (c) {
        items.push(c);
      } else {
        invalid++;
      }
    }
  }
  return { items, ignored, invalid };
}

/**
 * Reads an export file. Returns { events, entries, legacyPages, ignored, invalid }. legacyPages are the whole pages of
 * a file of the versions 2 to 4, they still have to be cut into entries. Throws an Error with a readable message for a
 * file that is not an export of this add-on.
 */
export function parseImport(content) {
  let data;
  try {
    data = JSON.parse(content);
  } catch (e) {
    throw new Error("The file is not valid JSON.");
  }
  if (!data || data.format !== FORMAT) {
    throw new Error("The file is not an export of this add-on.");
  }
  if (!Number.isInteger(data.version) || data.version > VERSION) {
    throw new Error(`The file has format version ${data.version}, this add-on reads up to ${VERSION}.`);
  }
  if (!Array.isArray(data.records)) {
    throw new Error("The file has no record list.");
  }
  const events = cleanList(data.records, cleanEvent);
  const entries = cleanList(data.reviewEntries, cleanEntry);
  const pages = cleanList(data.reviewPages, cleanPage);
  return {
    anonymous: data.anonymous === true,
    events: events.items,
    entries: entries.items,
    legacyPages: pages.items,
    ignored: events.ignored + entries.ignored + pages.ignored,
    invalid: events.invalid + entries.invalid + pages.invalid
  };
}
