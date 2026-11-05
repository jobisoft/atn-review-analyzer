// Run: NODE_PATH=<dir with jsdom>/node_modules node test/reviewpage.test.js
const assert = require("assert");
const { JSDOM } = require("jsdom");
const RP = require("../lib/reviewpage.js");

const parse = (html) => new JSDOM(html).window.document;

const row = (label, who, when) => `<tr><th>${label}</th><td><div>By <a href="/u/x/" onclick="x()">${who}</a> on ${when}</div></td></tr>`;
const notes = '<tr><th>Notes for Reviewers</th><td class="activity_approval"><div class="history-notes">Please test.<script>window.pwned=1</script></div></td></tr>';
const version = (v, day, state, rows) => `<tr class="listing-header"><th colspan="2">Version ${v} &middot; ${day} <span class="light">&middot; ${state}</span></th></tr>
<tr class="listing-body"><td class="files"><ul><li><a href="javascript:alert(1)">All Platforms</a><img src=x onerror="window.pwned=1"></li></ul></td>
<td><table class="activity">${rows}</table></td></tr>`;
const page = (versions, paging = "") => `<!doctype html><html><body><div id="review-files-paginate">${paging}</div>
<table id="review-files" class="item-history">${versions.join("\n")}</table></body></html>`;
const older = '<ol class="pagination"><li><a rel="prev" href="?page=2#history">Older</a></li><li>Results <strong>1</strong>&ndash;<strong>10</strong> of <strong>33</strong></li></ol>';

const v3 = version("1.1.0", "Oct. 17, 2026", "Approved",
  notes + row("", "Dev", "Oct. 17, 2026, 8:05 a.m.") + row("Reviewer Reply", "Jess", "Oct. 18, 2026, 9 a.m.") +
  row("", "Dev", "Oct. 17, 2026, 7:15 a.m.") + row("Approved", "Jess", "Oct. 21, 2026, 11:31 p.m.", "x"));
const v2 = version("1.0.1", "Sept. 2, 2025", "Deleted", row("", "Dev", "Sept. 2, 2025, 6:46 a.m.") + row("Rejected", "Jess", "Sept. 3, 2025, noon"));
const v1 = version("1.0.0", "Aug. 1, 2025", "Disabled by Mozilla", row("", "Dev", "Aug. 3, 2025, 9 a.m.") + row("Approved", "John Bieling", "Aug. 4, 2025, 10 a.m."));

// slicing: one entry per version, in the order of the page, and whether older versions exist
let r = RP.sliceReviewPage(page([v3, v2, v1], older), parse);
assert.deepStrictEqual(r.entries.map((e) => [e.version, e.headerDateText, e.state]), [
  ["1.1.0", "Oct. 17, 2026", "Approved"], ["1.0.1", "Sept. 2, 2025", "Deleted"], ["1.0.0", "Aug. 1, 2025", "Disabled by Mozilla"]]);
assert.strictEqual(r.more, true);
assert.strictEqual(RP.sliceReviewPage(page([v3, v1]), parse).more, false);
const newer = '<ol class="pagination"><li><a rel="next" href="?page=1#history">Newer</a></li><li>Results <strong>31</strong>&ndash;<strong>33</strong> of <strong>33</strong></li></ol>';
assert.strictEqual(RP.sliceReviewPage(page([v1], newer), parse).more, false, "the last page links to newer versions only");
assert.deepStrictEqual(RP.sliceReviewPage(page([v3, v3, v1]), parse).entries.map((e) => e.version), ["1.1.0", "1.0.0"], "a version twice is kept once");
assert.deepStrictEqual(RP.sliceReviewPage("<html><body>nothing</body></html>", parse), { entries: [], more: false });

// an entry is one version as a small table, stored as the site sent it. The copy that is shown is made safe
const entry = r.entries[0];
assert(entry.html.startsWith('<table id="review-files"><tbody><tr class="listing-header">'));
assert.strictEqual((entry.html.match(/listing-header/g) || []).length, 1);
assert(!entry.html.includes("1.0.1"));
assert(entry.html.includes('<a href="javascript:alert(1)">All Platforms</a>') && entry.html.includes("<script>") && entry.html.includes('onclick="x()"'), "nothing is removed when it is stored");
assert(entry.html.includes("Please test.") && entry.html.includes('class="history-notes"'));
{
  const doc = parse("<!doctype html><body></body>");
  const copy = RP.copyElement(parse(entry.html).querySelector("table"), doc, "rv-");
  assert(!/<script|<img|<a |onclick|onerror|javascript:/i.test(copy.outerHTML), copy.outerHTML);
  assert(copy.outerHTML.includes('<span class="rv-link">Dev</span>'), "links become text in the copy that is shown");
}

// reading an entry
const e = RP.readEntry(entry.html, parse);
assert.strictEqual(e.version, "1.1.0");
assert.strictEqual(e.headerDay, "2026-10-17");
assert.strictEqual(e.state, "Approved");
assert.deepStrictEqual(e.typeless.map((a) => a.when), ["2026-10-17T07:15:00", "2026-10-17T08:05:00"], "typeless rows, oldest first");
assert.strictEqual(e.activities.filter((a) => a.label === "Approved").length, 1);
assert.strictEqual(RP.readEntry("<html><body>x</body></html>", parse), null);

// the submission: day of the header, time of the earliest typeless row of that day that is not later than the event
assert.deepStrictEqual(RP.submissionOf(e, "2026-10-21T23:31:00"), { time: "2026-10-17T07:15:00", precision: "time" });
assert.deepStrictEqual(RP.submissionOf(e, "2026-10-17T07:30:00"), { time: "2026-10-17T07:15:00", precision: "time" });
assert.deepStrictEqual(RP.submissionOf(e, "2026-10-17T07:00:00"), { time: "2026-10-17T00:00:00", precision: "day" }, "a row after the event can not be the submission");
const old = RP.readEntry(RP.sliceReviewPage(page([v1]), parse).entries[0].html, parse);
assert.deepStrictEqual(RP.submissionOf(old, "2025-08-04T10:00:00"), { time: "2025-08-01T00:00:00", precision: "day" }, "a row on another day than the header gives no time");
assert.strictEqual(RP.submissionOf({ headerDay: "", typeless: [] }, "2026-01-01T00:00:00"), null);
// a waiting version has no event time: the earliest developer row of the header day
assert.deepStrictEqual(RP.submissionOf(e, null), { time: "2026-10-17T07:15:00", precision: "time" });
assert.deepStrictEqual(RP.submissionOf(old, null), { time: "2025-08-01T00:00:00", precision: "day" });

// rows and approvals
assert.strictEqual(RP.hasRow(e, "Approved", "2026-10-21T23:31:00"), true);
assert.strictEqual(RP.hasRow(e, "Approved", "2026-10-21T23:32:00"), false);
assert.strictEqual(RP.hasRow(e, "Rejected", "2026-10-21T23:31:00"), false);
const all = r.entries.map((x) => RP.readEntry(x.html, parse));
assert.strictEqual(RP.approvedBefore(all, "2026-10-21T23:31:00"), true, "the approval of 1.0.0 is earlier");
assert.strictEqual(RP.approvedBefore(all, "2025-08-04T10:00:00"), false, "the approval itself is not before itself");
assert.strictEqual(RP.approvedBefore([], "2030-01-01T00:00:00"), false);

// the copy for display gets a prefix on every class
const doc = parse("<!doctype html><body></body>");
const copy = RP.copyElement(parse(entry.html).querySelector("tr.listing-header"), doc, "rv-");
assert(copy.className.includes("rv-listing-header"));
assert.strictEqual(copy.outerHTML.includes('class="listing-header"'), false);

console.log("reviewpage tests ok");
