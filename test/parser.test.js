// Run: NODE_PATH=<dir with jsdom>/node_modules [ATN_SAMPLES=<dir with saved pages>] node test/parser.test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");
const P = require("../lib/parser.js");

// Saved pages of the site are not part of the repository. ATN_SAMPLES is the folder that has them, the tests that need them are skipped without.
const SAMPLES = process.env.ATN_SAMPLES || path.join(__dirname, "samples");
const sample = (name) => path.join(SAMPLES, name);
const SAMPLE = sample("Reviewer Tools __ Add-ons for Firefox.html");
if (fs.existsSync(SAMPLE)) {
  const doc = new JSDOM(fs.readFileSync(SAMPLE, "utf8")).window.document;
  const res = P.parseLogPage(doc, "https://addons.thunderbird.net/en-US/reviewers/reviewlog");

  const count = (ev) => res.records.filter((r) => r.event === ev).length;
  assert.strictEqual(res.records.length, 50);
  assert.strictEqual(count("Approved"), 23);
  assert.strictEqual(count("Rejected"), 23);
  assert.strictEqual(count("More information requested"), 4);
  assert.strictEqual(res.pageCount, 57);
  assert.strictEqual(res.total, 2808);
  assert.deepStrictEqual(res.warnings, []);
  for (const r of res.records) {
    assert(r.date && r.dateRaw && r.event && r.reviewer && r.comment && r.addonName && r.siteAddonId, JSON.stringify(r));
  }
  const first = res.records[0];
  assert.strictEqual(first.date, "2026-11-03T23:31:00");
  assert.strictEqual(first.event, "Rejected");
  assert.strictEqual(first.reviewer, "John Bieling");
  assert.strictEqual(first.addonName, "Vimbird");
  assert.strictEqual(first.addonVersion, "0.1.6");
  assert.strictEqual(first.addonSlug, "vimbird");
  assert.strictEqual(first.reviewUrl, "https://addons.thunderbird.net/en-US/reviewers/review/vimbird");
  assert(first.comment.startsWith("Thank you for your submission."));
  assert(first.comment.includes("webext-linter"));
  assert.strictEqual(res.records[1].comment, "Thank you for your contribution.");
  assert.strictEqual(res.records[2].date, "2026-11-03T23:00:00"); // "11 p.m."
} else {
  console.log("parser: no saved log page, set ATN_SAMPLES to run the tests on the real page");
}

const dates = {
  "Nov. 3, 2026, 11:31 p.m.": "2026-11-03T23:31:00",
  "Nov. 3, 2026, 8 p.m.": "2026-11-03T20:00:00",
  "Jan. 1, 2025, midnight": "2025-01-01T00:00:00",
  "Jan. 1, 2025, noon": "2025-01-01T12:00:00",
  "Jan. 1, 2025, 12:05 a.m.": "2025-01-01T00:05:00",
  "Jan. 1, 2025, 12:05 p.m.": "2025-01-01T12:05:00",
  "Sept. 9, 2025, 9:15 a.m.": "2025-09-09T09:15:00",
  "March 4, 2025, 1 a.m.": "2025-03-04T01:00:00",
  "Dec. 31, 2025": "2025-12-31T00:00:00"
};
for (const [raw, iso] of Object.entries(dates)) {
  assert.strictEqual(P.parseDate(raw), iso, raw);
}
assert.strictEqual(P.parseDate("garbage"), null);
assert.strictEqual(P.parseDate(""), null);

assert.strictEqual(
  P.buildPageUrl("https://addons.thunderbird.net/en-US/reviewers/reviewlog?start=2025-01-01&end=&search=", "2025-02-01", "", 3),
  "https://addons.thunderbird.net/en-US/reviewers/reviewlog?start=2025-02-01&page=3"
);

const relative = P.parseLogPage(new JSDOM('<table id="log-listing"><tbody><tr data-addonid="1"><td>Nov. 3, 2026, 8 p.m.</td><td><a href="">X</a> 1.0 <a href="/en-US/reviewers/review/x">Approved</a></td><td>Jess</td></tr></tbody></table>').window.document, "https://addons.thunderbird.net/en-US/reviewers/reviewlog?page=2");
assert.strictEqual(relative.records[0].reviewUrl, "https://addons.thunderbird.net/en-US/reviewers/review/x");

const empty = P.parseLogPage(new JSDOM("<html><body>login</body></html>").window.document);
assert.strictEqual(empty.hasTable, false);
assert.strictEqual(empty.records.length, 0);

// a log filtered by "SoundMail": one row links to the unlisted review page, such rows are left out and counted
const SOUNDMAIL = sample("Reviewer Tools __ Add-ons for Firefox_soundmail.html");
if (fs.existsSync(SOUNDMAIL)) {
  const doc2 = new JSDOM(fs.readFileSync(SOUNDMAIL, "utf8")).window.document;
  const sm = P.parseLogPage(doc2, "https://addons.thunderbird.net/en-US/reviewers/reviewlog?search=SoundMail");
  assert.deepStrictEqual(sm.warnings, [], "no row may be left without event, reviewer or date");
  assert(sm.unlisted >= 1, "the unlisted row is counted");
  assert.strictEqual(sm.records.length + sm.unlisted, doc2.querySelectorAll("tr[data-addonid]").length, "every row is a record or counted as unlisted");
  assert(!sm.records.some((r) => r.dateRaw === "July 7, 2026, 11:12 a.m."), "the unlisted row is not a record");
  assert(sm.records.every((r) => r.event && r.reviewer && r.addonSlug === "soundmail" && /\/reviewers\/review\/soundmail$/.test(r.reviewUrl)));
}
// an add-on without a slug: the log links to /reviewers/review/None. The row is left out and counted
const noSlugDoc = new JSDOM(`<table id="log-listing"><tbody>
  <tr data-addonid="7"><td>Nov. 3, 2026, 8 p.m.</td><td><a href="">Nameless</a> 1.0 <a href="/en-US/reviewers/review/None">Approved</a></td><td>Jess</td></tr>
  <tr class="comments hide"><td>&nbsp;</td><td colspan="4">ok</td></tr>
  <tr data-addonid="8"><td>Nov. 3, 2026, 9 p.m.</td><td><a href="">Named</a> 1.0 <a href="/en-US/reviewers/review/named">Approved</a></td><td>Jess</td></tr>
  <tr class="comments hide"><td>&nbsp;</td><td colspan="4">ok</td></tr>
</tbody></table>`).window.document;
const ns = P.parseLogPage(noSlugDoc, "https://addons.thunderbird.net/en-US/reviewers/reviewlog");
assert.strictEqual(ns.noSlug, 1);
assert.deepStrictEqual(ns.records.map((r) => r.addonSlug), ["named"]);
assert.strictEqual(ns.unlisted, 0);
// other events are kept
const otherDoc = new JSDOM(`<table id="log-listing"><tbody>
  <tr data-addonid="9"><td>Nov. 3, 2026, 8 p.m.</td><td><a href="">X</a> 1.0 <a href="/en-US/reviewers/review/x">More information requested</a></td><td>Jess</td></tr>
  <tr class="comments hide"><td>&nbsp;</td><td colspan="4">q</td></tr>
  <tr data-addonid="9"><td>Nov. 4, 2026, 8 p.m.</td><td><a href="">X</a> 1.0 <a href="/en-US/reviewers/review/x">Rejected</a></td><td>Jess</td></tr>
  <tr class="comments hide"><td>&nbsp;</td><td colspan="4">no</td></tr>
</tbody></table>`).window.document;
const oe = P.parseLogPage(otherDoc, "https://addons.thunderbird.net/en-US/reviewers/reviewlog");
assert.deepStrictEqual(oe.records.map((r) => r.event), ["More information requested", "Rejected"]);

// the review queue pages
const queueRow = (id, slug, name, version, waiting, icons = "") => `<tr data-addon="${id}" class="addon-row" id="addon-${id}"><td><div class="addon-locked"></div></td><td><a href="https://addons.thunderbird.net/en-US/reviewers/review/${slug}">${name} <em>${version}</em></a></td><td>Extension</td><td>${waiting}</td><td>${icons}</td><td>&nbsp;</td></tr>`;
const queuePage = (rows, tab = "New (3)", extra = "") => new JSDOM(`<html><body><ul class="tabnav"><li class="selected"><a href="/en-US/reviewers/queue/new">${tab}</a></li><li><a href="/en-US/reviewers/queue/updates">Updates (11)</a></li></ul>${extra}<table id="addon-queue" class="data-grid"><thead><tr><th>Add-on</th></tr></thead><tbody>${rows}</tbody></table></body></html>`).window.document;
const BASE = "https://addons.thunderbird.net/en-US/reviewers/queue/new";
const q = P.parseQueuePage(queuePage([
  queueRow(990305, "empty-spam-trash", "Empty Spam &amp; Trash", "1.1.0", "24 days", '<div class="app-icon ed-sprite-info" title="More Information Requested"></div><div class="app-icon ed-sprite-webextension" title="WebExtension"></div><div class="app-icon" title="Needs Sensitive Data Access Review"></div>'),
  queueRow(990348, "e-invoice-viewer", "e-Invoice Viewer", "1.2.1", "12 hours"),
  queueRow(1, "%D7%A2%D8%B9-x", "Name with a slug that is encoded", "0.1", "1 day")
].join("")), BASE);
assert.strictEqual(q.items.length, 3);
assert.strictEqual(q.total, 3);
assert.strictEqual(q.next, null);
assert.deepStrictEqual(q.items[0], {
  siteAddonId: "990305", slug: "empty-spam-trash", name: "Empty Spam & Trash", version: "1.1.0", waiting: "24 days",
  flags: ["More Information Requested", "Needs Sensitive Data Access Review"], reviewUrl: "https://addons.thunderbird.net/en-US/reviewers/review/empty-spam-trash"
}, "the type icon is no flag, the entity is decoded, the version is not part of the name");
assert.deepStrictEqual(q.items[1].flags, []);
assert.strictEqual(q.items[2].slug, "%D7%A2%D8%B9-x", "the slug stays as it is in the URL");
// rows that can not be used are counted, and a row of an add-on without a slug is ignored
const bad = P.parseQueuePage(queuePage([queueRow(5, "None", "No slug", "1.0", "1 day"), queueRow("", "x", "No id", "1.0", "1 day"), queueRow(6, "y", "No version", "", "1 day").replace("<em></em>", ""), queueRow(7, "ok", "Fine", "2.0", "2 days")].join(""), "Updates (4)"), BASE);
assert.deepStrictEqual(bad.items.map((i) => i.slug), ["ok"]);
assert.strictEqual(bad.skipped, 3);
// a further page
assert.strictEqual(P.parseQueuePage(queuePage(queueRow(1, "a", "A", "1.0", "1 day"), "New (101)", '<ol class="pagination"><li><a href="?page=2" rel="next">Next</a></li></ol>'), BASE).next, "https://addons.thunderbird.net/en-US/reviewers/queue/new?page=2");
assert.strictEqual(P.parseQueuePage(queuePage(queueRow(1, "a", "A", "1.0", "1 day"), "New (101)", '<ol class="pagination"><li><a href="?page=2">Next</a></li></ol>'), BASE).next, "https://addons.thunderbird.net/en-US/reviewers/queue/new?page=2", "a link that says Next");
assert.strictEqual(P.parseQueuePage(new JSDOM("<html><body>Please log in</body></html>").window.document, BASE).items.length, 0, "a page without the queue");
// the saved page of the new queue, if it is there
const QUEUE_SAMPLE = sample("Reviewer Tools __ Add-ons for Firefox_new.html");
if (fs.existsSync(QUEUE_SAMPLE)) {
  const sample = P.parseQueuePage(new JSDOM(fs.readFileSync(QUEUE_SAMPLE, "utf8")).window.document, BASE);
  assert.strictEqual(sample.items.length, 76);
  assert.strictEqual(sample.total, 76, "the number in the tab is the number of rows");
  assert.strictEqual(sample.skipped, 0);
  assert(sample.items.every((i) => i.slug && i.name && i.version && i.siteAddonId && i.waiting), "every row has all its fields");
  assert.strictEqual(sample.items.filter((i) => i.flags.includes("More Information Requested")).length, 5);
}
console.log("parser tests ok");
