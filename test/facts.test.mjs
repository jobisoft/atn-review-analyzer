// Run: NODE_PATH=<dir with jsdom>/node_modules node test/facts.test.mjs
import assert from "assert";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
globalThis.ReviewLogParser = require("../lib/parser.js");
globalThis.ReviewPage = require("../lib/reviewpage.js");
const { AddonView, factsFor, WAITING_EVENT, fileIdOf, isCleanedEntry, isInstallRdf, isThemeEntry, installRdfUrl, manifestType, parseLooseJson, manifestUrl, needsTypeCheck, needsFirstPage, needsOlderPage } = await import("../lib/facts.js");

const parse = (html) => new JSDOM(html).window.document;
const row = (label, who, when) => `<tr><th>${label}</th><td><div>By <a href="/u/">${who}</a> on ${when}</div></td></tr>`;
const entryHtml = (v, day, rows) => `<table id="review-files"><tbody><tr class="listing-header"><th colspan="2">Version ${v} &middot; ${day} <span class="light">&middot; Approved</span></th></tr><tr class="listing-body"><td class="files"></td><td><table class="activity">${rows}</table></td></tr></tbody></table>`;
const viewOf = (entries) => { const view = new AddonView(); entries.forEach((e) => view.add(e, parse)); return view; };

const NOW = "2026-11-04T10:00:00.000Z";
const e3 = { version: "3.0", fetchedAt: NOW, oldest: false, html: entryHtml("3.0", "Oct. 17, 2026", row("", "Dev", "Oct. 17, 2026, 8:05 a.m.") + row("Approved", "Jess", "Oct. 21, 2026, 11:31 p.m.")) };
const e2 = { version: "2.0", fetchedAt: NOW, oldest: false, html: entryHtml("2.0", "Sept. 2, 2026", row("", "Dev", "Sept. 2, 2026, 6:46 a.m.") + row("Rejected", "Jess", "Sept. 3, 2026, noon")) };
const e1 = { version: "1.0", fetchedAt: NOW, oldest: true, html: entryHtml("1.0", "Aug. 1, 2025", row("", "Dev", "Aug. 1, 2025, 9 a.m.") + row("Approved", "John", "Aug. 4, 2025, 10 a.m.")) };

const approve3 = { event: "Approved", date: "2026-10-21T23:31:00", addonVersion: "3.0" };
const reject2 = { event: "Rejected", date: "2026-09-03T12:00:00", addonVersion: "2.0" };
const approve1 = { event: "Approved", date: "2025-08-04T10:00:00", addonVersion: "1.0" };
const moreInfo3 = { event: "More information requested", date: "2026-10-18T09:00:00", addonVersion: "3.0" };

// facts
let view = viewOf([e3, e2, e1]);
assert.deepStrictEqual(factsFor(view, approve3), { tSubmission: "2026-10-17T08:05:00", tWait: 4.64, queue: "update" }, "an approval earlier than the event: update. 4 days 15 h 26 min");
assert.deepStrictEqual(factsFor(view, reject2), { tSubmission: "2026-09-02T06:46:00", tWait: 1.22, queue: "update" }, "the rejection came after the approval of 1.0");
assert.deepStrictEqual(factsFor(view, approve1), { tSubmission: "2025-08-01T09:00:00", tWait: 3.04, queue: "new" }, "the whole history is known and has no earlier approval");
assert.deepStrictEqual(factsFor(view, moreInfo3), { tSubmission: "2026-10-17T08:05:00", tWait: 1.04, queue: "update" }, "other events have the queue too (an approval of 2.0 is earlier), and a wait time");

// a decision after the first decision of the version has no wait. A preliminary approval is a decision
const again = { version: "4.0", fetchedAt: NOW, oldest: false, html: entryHtml("4.0", "Feb. 24, 2014", row("", "Dev", "Feb. 24, 2014, 8 a.m.") + row("Preliminarily approved", "Kris", "March 4, 2014, 4:28 p.m.") + row("Rejected", "John", "July 7, 2026, 11:03 a.m.")) };
assert.deepStrictEqual(factsFor(viewOf([again]), { event: "Rejected", date: "2026-07-07T11:03:00", addonVersion: "4.0" }), { tSubmission: "2014-02-24T08:00:00", tWait: null, queue: null }, "a rejection years after the first decision");
assert.strictEqual(factsFor(viewOf([again]), { event: "Approved", date: "2014-03-04T16:28:00", addonVersion: "4.0" }).tWait, 8.35, "the first decision has its wait");
assert.strictEqual(factsFor(view, moreInfo3).tWait, 1.04, "only decisions lose their wait");

// without the oldest entry the history is not known to be complete: undecided
view = viewOf([e3, e2]);
assert.strictEqual(factsFor(view, reject2).queue, null);
assert.strictEqual(factsFor(view, approve3).queue, null, "no approval before it in the stored entries, but the history goes on");
// a version that is not stored: no submission
assert.deepStrictEqual(factsFor(viewOf([e1]), approve3), { tSubmission: null, tWait: null, queue: "update" }, "e1 has an approval before the event");
// a page that is gone
assert.strictEqual(factsFor(new AddonView(), { event: "Rejected", date: "2026-01-01T00:00:00", addonVersion: "1.0" }, { gone: true }).queue, "new");
assert.strictEqual(factsFor(new AddonView(), { event: "Approved", date: "2026-01-01T00:00:00", addonVersion: "1.0" }, { gone: true }).queue, null);
assert.strictEqual(factsFor(viewOf([e1]), { event: "Rejected", date: "2026-01-01T00:00:00", addonVersion: "9.9" }, { gone: true }).queue, "update", "an approval is known");

// what has to be fetched: nothing if the stored entries answer everything
view = viewOf([e3, e2, e1]);
assert.strictEqual(needsFirstPage(view, [approve3, reject2, approve1]), false);
// the entry of the event's version is missing
assert.strictEqual(needsFirstPage(view, [{ ...approve3, addonVersion: "4.0" }]), true, "a new version may be on the first page");
assert.strictEqual(needsFirstPage(new AddonView(), [approve3]), true);
// an entry fetched before the event happened and without its row
const early = { ...e3, fetchedAt: "2026-10-20T00:00:00.000Z", html: entryHtml("3.0", "Oct. 17, 2026", row("", "Dev", "Oct. 17, 2026, 8:05 a.m.")) };
assert.strictEqual(needsFirstPage(viewOf([early, e2, e1]), [approve3]), true, "stale: fetched before the approval");
const late = { ...early, fetchedAt: "2026-10-30T00:00:00.000Z" };
assert.strictEqual(needsFirstPage(viewOf([late, e2, e1]), [approve3]), false, "fetched long after the event: the row is not there and will not come");
// an approval before a decision is still to be found
assert.strictEqual(needsFirstPage(viewOf([e3, e2]), [reject2]), true, "no approval before the rejection in what is stored, history not complete");
assert.strictEqual(needsFirstPage(viewOf([e3, e2]), [moreInfo3]), true, "any event needs the history to know its queue");
assert.strictEqual(needsFirstPage(viewOf([{ ...e2, oldest: true }]), [reject2]), false, "history complete: nothing more to find");

// walking back
assert.strictEqual(needsOlderPage(viewOf([e3]), [reject2], true), true, "the version is not on this page");
assert.strictEqual(needsOlderPage(viewOf([e3, e2]), [reject2], true), true, "found the version, still no approval before it");
assert.strictEqual(needsOlderPage(viewOf([e3, e2, e1]), [reject2], true), false, "found an approval before it");
assert.strictEqual(needsOlderPage(viewOf([e3]), [reject2], false), false, "no older page");
assert.strictEqual(needsOlderPage(viewOf([e3, e2]), [moreInfo3, reject2], true), true);
assert.strictEqual(needsOlderPage(viewOf([e3, e2, e1]), [moreInfo3, reject2, approve1], true), false);

console.log("facts tests ok");

// the experiment check: every event, whatever it is and whenever it happened
const rej = { event: "Rejected", date: "2026-03-17T00:00:00" };
assert.strictEqual(needsTypeCheck(rej), true);
assert.strictEqual(needsTypeCheck({ ...rej, date: "2025-01-05T10:00:00" }), true, "no limit by date");
assert.strictEqual(needsTypeCheck({ ...rej, event: "Approved", date: "2025-01-05T10:00:00", tSubmission: "2024-12-01T08:00:00" }), true, "also an approval of a long time ago");
assert.strictEqual(needsTypeCheck({ ...rej, event: "More information requested" }), true, "any event");
assert.strictEqual(needsTypeCheck({ ...rej, date: null }), true, "also a row without a date");
assert.strictEqual(needsTypeCheck({ ...rej, type: "webextension" }), false);
assert.strictEqual(needsTypeCheck({ ...rej, type: undefined }), true, "no type: it is asked again at every scan");

// an entry that an earlier build stored with its links turned into text has no file: the page is fetched again, as long as the manifest is wanted
const cleaned = (v) => ({ version: v, fetchedAt: NOW, oldest: true, html: entryHtml(v, "Aug. 1, 2025", row("", "Dev", "Aug. 1, 2025, 9 a.m.") + row("Approved", "John", "Aug. 4, 2025, 10 a.m.")).replace("<td class=\"files\"></td>", "<td class=\"files\"><span class=\"link\">Contents</span></td>") });
assert.strictEqual(isCleanedEntry(cleaned("1.0").html), true);
assert.strictEqual(isCleanedEntry(cleaned("1.0").html.replace('<span class="link">', '<a class="reviewers-install"><span class="link">')), false, "the download link of the site is there");
assert.strictEqual(isCleanedEntry(e1.html), false);
assert.strictEqual(needsFirstPage(viewOf([cleaned("1.0")]), [{ ...approve1 }]), true, "a manifest is wanted and the entry has no link");
assert.strictEqual(needsFirstPage(viewOf([cleaned("1.0")]), [{ ...approve1, type: "webextension" }]), false, "the answer is there already");
assert.strictEqual(needsOlderPage(viewOf([cleaned("1.0")]), [{ ...approve1 }], true), true, "on to the older pages while the entry of the version has no link");

// manifests as Firefox reads them: comments and trailing commas are fine, strings are left alone
assert.deepStrictEqual(parseLooseJson('{"a": 1, // one\n "b": [1, 2,], /* block\n comment */ "c": {"d": 3,},}'), { a: 1, b: [1, 2], c: { d: 3 } });
assert.deepStrictEqual(parseLooseJson('\uFEFF{"url": "https://example.org/a//b", "t": "/* not a comment */", "q": "say \\"hi\\" // here",}'), { url: "https://example.org/a//b", t: "/* not a comment */", q: 'say "hi" // here' }, "comment marks inside strings stay");
assert.deepStrictEqual(parseLooseJson("// a comment first\n/* and a block */ {\"a\": 1}"), { a: 1 }, "comments before the object");
assert.deepStrictEqual(parseLooseJson('{"a": [1, 2, // last one\n ],}'), { a: [1, 2] }, "a comment between the comma and the bracket");
assert.deepStrictEqual(parseLooseJson('{"a": ",}"}'), { a: ",}" }, "a comma and a bracket in a string stay");
assert.throws(() => parseLooseJson('{"a": 1 "b": 2}'), "missing comma is still an error");
assert.throws(() => parseLooseJson("{,}"), "a comma alone is an error");
assert.strictEqual(manifestType('{ // theme\n "manifest_version": 2, "name": "x", /* c */ "experiment_apis": {"a": {},},\n}'), "experiment", "an Experiment with comments");
assert.strictEqual(manifestType('//  Release-reference:  /* ver 103 + */\n{ "manifest_version": 2, "name": "x", "theme": {},\n}'), "theme", "a theme with comments and a trailing comma");
assert.strictEqual(manifestType('{ "manifest_version": 2, // "experiment_apis": {}\n "name": "x" }'), "webextension", "the key in a comment is not the key");
assert.strictEqual(manifestType('{ "manifest_version": 2, "name": "x" "oops": 1 }'), "webextension", "not valid, but a manifest that does not have the key");
assert.strictEqual(manifestType('{ "manifest_version": 2, "experiment_apis": {} "oops": 1 }'), "experiment", "not valid, with the key");
assert.strictEqual(manifestType("<html>not found</html>"), null, "not a manifest at all: unknown");
assert.strictEqual(manifestType(null), null);

// the id of the file of an entry
const file = (inner) => `<table id="review-files"><tbody><tr class="listing-header"><th colspan="2">Version 1.0</th></tr><tr class="listing-body"><td class="files"><ul><li class="file-info"><span class="light"><strong><a href="/thunderbird/downloads/file/1039398/x-1.0-tb.xpi?src=reviewer" class="reviewers-install">All Platforms</a></strong><div>Rejected</div>${inner}</span></li></ul></td><td></td></tr></tbody></table>`;
assert.strictEqual(fileIdOf(file('<a href="/en-US/thunderbird/files/browse/77/">Contents</a>'), parse), "1039398", "the first link that has an id (the download link)");
assert.strictEqual(fileIdOf(file("").replace("/thunderbird/downloads/file/1039398/x-1.0-tb.xpi", "/x"), parse), null, "no id");
assert.strictEqual(fileIdOf(file('<a href="https://addons.thunderbird.net/en-US/thunderbird/files/browse/55">Contents</a>').replace("/thunderbird/downloads/file/1039398/x-1.0-tb.xpi?src=reviewer", "/validation"), parse), "55", "the Contents link, no slash at the end");
assert.strictEqual(fileIdOf(file('<a href="javascript:alert(1)">x</a>').replace("downloads/file/1039398", "downloads/file/abc"), parse), null);
assert.strictEqual(fileIdOf(entryHtml("1.0", "Jan. 1, 2026", ""), parse), null, "an entry without a link (an old cleaned entry)");
assert.strictEqual(manifestUrl("1039398", "https://addons.thunderbird.net"), "https://addons.thunderbird.net/en-US/thunderbird/files/browse/1039398/file-redirect/manifest.json");

// what a manifest says
const exp = JSON.stringify({ manifest_version: 2, experiment_apis: { a: {} } });
assert.strictEqual(manifestType(exp), "experiment");
assert.strictEqual(manifestType(JSON.stringify({ manifest_version: 2 })), "webextension");
assert.strictEqual(manifestType(JSON.stringify({ experiment_apis: {} })), "experiment", "an empty object is still a declaration");
assert.strictEqual(manifestType('{\n // a comment\n "name": "x",\n "experiment_apis": { }\n}'), "experiment", "comments are fine for Firefox");
assert.strictEqual(manifestType('{\n // a comment\n "name": "x"\n}'), "webextension", "comments are fine, and there is no key");
assert.strictEqual(manifestType("\uFEFF" + exp), "experiment", "byte order mark");
assert.strictEqual(manifestType("[]"), "webextension");
assert.strictEqual(manifestType("null"), null);
assert.strictEqual(manifestType(""), null);
assert.strictEqual(manifestType(null), null);

// waiting rows (the queue): no date, no wait, the queue of the queue, a submission time from the entry
const waitingRow = (queue) => ({ event: WAITING_EVENT, date: null, addonVersion: "3.0", queue });
assert.strictEqual(WAITING_EVENT, "Awaiting Review");
assert.deepStrictEqual(factsFor(viewOf([e3]), waitingRow("update")), { tSubmission: "2026-10-17T08:05:00", tWait: null, queue: "update" });
assert.deepStrictEqual(factsFor(viewOf([e3]), waitingRow("new")), { tSubmission: "2026-10-17T08:05:00", tWait: null, queue: "new" }, "the queue of the queue is kept, whatever the stored history says");
assert.deepStrictEqual(factsFor(new AddonView(), waitingRow("new"), { gone: true }), { tSubmission: null, tWait: null, queue: "new" }, "no page: nothing known, the queue stays");
assert.strictEqual(needsFirstPage(new AddonView(), [waitingRow("new")]), true, "the entry of the version is missing");
assert.strictEqual(needsFirstPage(viewOf([e3]), [waitingRow("new")]), false, "it has its entry, it is never stale and needs no approval");
assert.strictEqual(needsOlderPage(viewOf([e3]), [waitingRow("new")], true), false);
assert.strictEqual(needsOlderPage(viewOf([e2]), [waitingRow("new")], true), true, "the version is not on this page");
assert.strictEqual(needsTypeCheck(waitingRow("new")), true, "waiting rows are checked for their type");
assert.strictEqual(needsTypeCheck({ ...waitingRow("new"), type: "webextension" }), false);
console.log("facts experiment tests ok");

// the type of a version without a manifest to read
const fileLink = (href, text) => `<ul><li class="file-info"><a href="${href}">${text}</a></li></ul>`;
assert.strictEqual(isThemeEntry(fileLink("/en-US/thunderbird/downloads/file/1054606/x-4.4.xpi?src=reviewer", "Download"), parse), true, "a download link and no Contents link");
assert.strictEqual(isThemeEntry(fileLink("/en-US/thunderbird/downloads/file/1054606/x.xpi", "Download") + fileLink("/en-US/thunderbird/files/browse/1054606/", "Contents"), parse), false, "with a Contents link");
assert.strictEqual(isThemeEntry("<p>links turned into text</p>", parse), false, "no link at all");
assert.strictEqual(installRdfUrl("1054943", "https://addons.thunderbird.net"), "https://addons.thunderbird.net/en-US/thunderbird/files/browse/1054943/file-redirect/install.rdf");
assert.strictEqual(isInstallRdf('<?xml version="1.0"?>\n<RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></RDF>'), true);
assert.strictEqual(isInstallRdf('<rdf:RDF xmlns:rdf="x"></rdf:RDF>'), true, "with a prefix");
assert.strictEqual(isInstallRdf("<html>not found</html>"), false);
assert.strictEqual(needsTypeCheck({ ...rej, type: "legacy" }), false);
console.log("type tests ok");
