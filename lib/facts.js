/*
 * What can be said about the events of an add-on from its stored entries, and what still has to be fetched.
 * Pure functions, no database and no network. Each event is { event, date, addonVersion }, `date` is the time of the log
 * ("YYYY-MM-DDTHH:MM:00").
 *
 * The facts of an event: tSubmission (see ReviewPage.submissionOf), tWait (days from the submission to the event) and,
 * for an Approved or Rejected event, queue: "update" if the add-on had an Approved row before the event, "new" if
 * the whole history is known and had none, else null.
 */
import "./parser.js";
import "./reviewpage.js";

const RP = () => globalThis.ReviewPage;

const DECISIONS = new Set(["Approved", "Rejected"]);

// the rows of an entry that decide a version for the first time. A preliminary approval counts as an approval.
const FIRST_DECISION_LABELS = new Set(["Approved", "Preliminarily approved", "Rejected"]);

/** The event of a row that the queue pages made: a version that was submitted and is not decided yet. It has no date and no reviewer. */
export const WAITING_EVENT = "Awaiting Review";

/** The pause on new Experiment add-on reviews was announced on this day (March 17, 2026). Only the upgrade steps of the database use it, no scan limits anything to it. */
export const ANNOUNCEMENT = "2026-03-17T00:00:00";
const FETCH_MARGIN_MS = 36 * 3600 * 1000; // the time of the log has no time zone

/**
 * Did an earlier build store the entry with its links turned into plain text (a span "link" instead of the address)? Such an entry has
 * no file to fetch the manifest from. One that the site sent has the class "reviewers-install" on the download link.
 */
export const isCleanedEntry = (html) => html.includes('class="link"') && !html.includes("reviewers-install");

/** The stored entries of one add-on, each read once. */
export class AddonView {
  constructor() {
    this.versions = new Map(); // version -> { headerDay, activities, typeless, fetchedAt }
    this.oldest = false; // the entry of the oldest version is stored, so the whole history is known
  }

  /** entry: { version, html, fetchedAt, oldest } */
  add(entry, parse) {
    const read = RP().readEntry(entry.html, parse);
    if (!read) {
      return;
    }
    this.versions.set(entry.version, {
      headerDay: read.headerDay,
      activities: read.activities.map(({ label, when }) => ({ label, when })),
      typeless: read.typeless.map(({ when }) => ({ when })),
      cleaned: isCleanedEntry(entry.html),
      firstDecision: read.activities.filter((a) => FIRST_DECISION_LABELS.has(a.label) && a.when).map((a) => a.when).sort()[0] || null,
      fetchedAt: entry.fetchedAt
    });
    this.oldest = this.oldest || !!entry.oldest;
  }

  approvedBefore(time) {
    return RP().approvedBefore(this.versions.values(), time);
  }
}

const isStale = (view, ev) => {
  if (ev.event === WAITING_EVENT) {
    return false; // no event time to compare, the entry of the version is all it needs
  }
  const v = view.versions.get(ev.addonVersion);
  return !!v && !RP().hasRow(v, ev.event, ev.date) && !(Date.parse(v.fetchedAt) > Date.parse(`${ev.date}Z`) + FETCH_MARGIN_MS);
};

/** Is the manifest of the event still wanted, while the stored entry of its version has no link to the file? Then the entry has to be fetched again. */
const lacksLinks = (view, ev) => needsTypeCheck(ev) && !!view.versions.get(ev.addonVersion)?.cleaned;

/**
 * Must the first page of the history be fetched? Yes if the entry of an event's version is missing (it may be new), if it
 * was fetched before the event happened and has no row for it yet, or if an approval before a decision is still to be found.
 */
export function needsFirstPage(view, events) {
  return events.some((ev) => !view.versions.has(ev.addonVersion) || isStale(view, ev) || lacksLinks(view, ev)
    || (ev.event !== WAITING_EVENT && !view.oldest && !view.approvedBefore(ev.date)));
}

/** After a page: must the next, older page be fetched? `more` is true if the page had a link to older versions. */
export function needsOlderPage(view, events, more) {
  return more && events.some((ev) => !view.versions.has(ev.addonVersion) || lacksLinks(view, ev)
    || (ev.event !== WAITING_EVENT && !view.oldest && !view.approvedBefore(ev.date)));
}

const utc = (time) => Date.parse(`${time}Z`);

/**
 * tSubmission, tWait and queue of one event. gone: the review page does not exist (HTTP 404). Nothing is known then,
 * except that a Rejected event without an earlier approval was a new add-on that never came back.
 */
export function factsFor(view, ev, { gone = false } = {}) {
  const v = view.versions.get(ev.addonVersion);
  if (ev.event === WAITING_EVENT) { // no event time: no wait, and the queue is the one it was read in
    const waiting = v ? RP().submissionOf(v, null) : null;
    return { tSubmission: waiting ? waiting.time : null, tWait: null, queue: ev.queue || null };
  }
  const submission = v ? RP().submissionOf(v, ev.date) : null;
  let queue = null; // every event of a version belongs to the queue the version was in: an approval before the event makes it an update
  if (view.approvedBefore(ev.date)) {
    queue = "update";
  } else if (view.oldest || (gone && ev.event === "Rejected")) {
    queue = "new";
  }
  // a decision after the first decision of the version is a review of a version that was decided already, it waited no time
  const again = DECISIONS.has(ev.event) && !!v && !!v.firstDecision && v.firstDecision < ev.date;
  return {
    tSubmission: submission ? submission.time : null,
    tWait: submission && !again ? Math.round(((utc(ev.date) - utc(submission.time)) / 86400000) * 100) / 100 : null,
    queue
  };
}

/** The types of an add-on. An event without one has not been classified, or the files of its version could not be found (404), which a scan asks again. */
export const TYPES = ["webextension", "experiment", "theme", "legacy"];

/**
 * Does the event need its type? Every event, whatever its queue or event and whenever it happened (it is a fact of the version),
 * waiting rows too, as long as the field is absent.
 */
export function needsTypeCheck(ev) {
  return ev.type === undefined;
}

/**
 * Is the entry of a version a theme? It has a download link and no "Contents" link (the link to the files of the version), so there is no manifest to read.
 * An entry whose links were turned into text (see isCleanedEntry) has no download link either and is not a theme.
 */
export function isThemeEntry(html, parse = RP().parseHtml) {
  let download = false;
  for (const a of parse(html).querySelectorAll("li.file-info a")) {
    const href = a.getAttribute("href") || "";
    if (/\/files\/browse\/\d+(?:\/|$)/.test(href)) {
      return false;
    }
    download = download || /\/downloads\/file\/\d+(?:\/|$)/.test(href);
  }
  return download;
}

/** The id of the file of an entry: from the "Contents" link (.../files/browse/<id>/) or the download link (.../downloads/file/<id>/...). null if there is none. */
export function fileIdOf(html, parse = RP().parseHtml) {
  for (const a of parse(html).querySelectorAll("li.file-info a")) {
    const match = /\/(?:files\/browse|downloads\/file)\/(\d+)(?:\/|$)/.exec(a.getAttribute("href") || "");
    if (match) {
      return match[1];
    }
  }
  return null;
}

/** The address of a raw file of a file of the site at origin (a redirect to the file inside the package). */
const fileUrl = (name) => (fileId, origin) => `${origin}/en-US/thunderbird/files/browse/${fileId}/file-redirect/${name}`;
export const manifestUrl = fileUrl("manifest.json");
/** install.rdf is the manifest of a legacy add-on, which has no manifest.json. */
export const installRdfUrl = fileUrl("install.rdf");

/** Does a text look like the install.rdf of a legacy add-on? */
export const isInstallRdf = (text) => typeof text === "string" && /<(?:\w+:)?RDF[\s>]/i.test(text);

/**
 * The JSON of a text that may have comments (// and block comments) and a comma before a closing } or ], as Firefox accepts them in a manifest. Parsing is the one of JSON.parse
 * after the comments and those commas are taken out, so nothing is run and no library is needed. Throws like JSON.parse if the rest is not JSON.
 */
export function parseLooseJson(text) {
  const out = [];
  let i = 0;
  let comma = -1; // where a comma is in out that may be dropped if the next thing is a closing bracket
  let last = ""; // the last character that is not a space or a comment
  while (i < text.length) {
    const c = text[i];
    if (c === '"') { // a string, copied as it is up to its closing quote
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      out.push(text.slice(i, j + 1));
      comma = -1;
      last = '"';
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
      out.push(" ");
    } else {
      if (c === "}" || c === "]") {
        if (comma !== -1) {
          out[comma] = "";
        }
        comma = -1;
      } else if (c === ",") {
        comma = last && !"{[,".includes(last) ? out.length : -1; // only a comma after a value can go: {,} stays an error
      } else if (!/\s/.test(c)) {
        comma = -1;
      }
      if (!/\s/.test(c)) {
        last = c;
      }
      out.push(c);
      i++;
    }
  }
  return JSON.parse(out.join("").replace(/^\uFEFF/, ""));
}

/**
 * The type of an add-on from the text of its manifest.json: "experiment" if it declares experiment_apis, "theme" if it declares a theme, else "webextension".
 * null if it can not be told. Comments and trailing commas are fine (parseLooseJson). A text that is still not JSON but looks like a manifest
 * ("manifest_version" is in it) is searched: the key is there or it is not.
 */
export function manifestType(text) {
  if (typeof text !== "string") {
    return null;
  }
  try {
    const manifest = parseLooseJson(text);
    if (manifest === null || typeof manifest !== "object") {
      return null;
    }
    return Object.hasOwn(manifest, "experiment_apis") ? "experiment" : Object.hasOwn(manifest, "theme") ? "theme" : "webextension";
  } catch (e) {
    if (/"experiment_apis"\s*:/.test(text)) {
      return "experiment";
    }
    return /"manifest_version"/.test(text) && !text.includes("experiment_apis") ? "webextension" : null;
  }
}
