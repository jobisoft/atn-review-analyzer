// Run: NODE_PATH=<dir with jsdom>/node_modules node test/queue.test.mjs
import assert from "assert";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
globalThis.ReviewLogParser = require("../lib/parser.js");
globalThis.ReviewPage = require("../lib/reviewpage.js");
const { AGE_WEEK_EDGES, queueItems, weeklyFlow, weeklyOldestAge, weeklyReviewTime } = await import("../lib/queue.js");

const T = (s) => Date.parse(`${s}Z`);
const dec = (slug, version, event, tSubmission, date, queue = "new") => ({ addonSlug: slug, addonVersion: version, event, tSubmission, date, queue });
const wait = (slug, version, tSubmission, queue = "new") => ({ addonSlug: slug, addonVersion: version, event: "Awaiting Review", date: null, tSubmission, queue });

const events = [
  dec("a", "1", "Approved", "2026-10-26T10:00:00", "2026-10-28T10:00:00"),
  dec("a", "1", "More information requested", "2026-10-26T10:00:00", "2026-10-27T10:00:00"), // not a decision
  dec("b", "1", "Rejected", "2026-10-27T10:00:00", "2026-11-03T10:00:00"),
  dec("b", "1", "Approved", "2026-10-27T10:00:00", "2026-11-05T10:00:00"), // the second decision does not count
  dec("c", "1", "Approved", "2026-10-28T10:00:00", "2026-10-29T10:00:00", "update"),
  dec("d", "1", "Rejected", "2026-10-29T10:00:00", "2026-10-30T10:00:00"),
  dec("e", "1", "Approved", null, "2026-10-30T10:00:00"), // no submission time
  wait("w", "1", "2026-10-31T12:00:00"),
  wait("a", "1", "2026-10-26T10:00:00"), // decided in the meantime: the waiting row does not count
  wait("u", "1", "2026-11-02T12:00:00", "update")
];
let items = queueItems(events, "new");
assert.deepStrictEqual(items.map((i) => [i.start, i.end]).sort((a, b) => a[0] - b[0]), [
  [T("2026-10-26T10:00:00"), T("2026-10-28T10:00:00")],
  [T("2026-10-27T10:00:00"), T("2026-11-03T10:00:00")],
  [T("2026-10-29T10:00:00"), T("2026-10-30T10:00:00")],
  [T("2026-10-31T12:00:00"), Infinity]
], "first decisions only, no version without a submission, the waiting one stays");
// nothing is left out: an old version that was rejected long after its submission is in the queue all that time
assert.deepStrictEqual(queueItems([dec("old", "1", "Rejected", "2014-02-24T00:00:00", "2026-07-07T11:03:00")], "new"), [{ start: T("2014-02-24T00:00:00"), end: T("2026-07-07T11:03:00"), decision: "Rejected" }]);
// a later review of a version that was decided before has no wait (tWait null) and was not in the queue
assert.deepStrictEqual(queueItems([{ ...dec("re", "1", "Rejected", "2014-02-24T00:00:00", "2026-07-07T11:03:00"), tWait: null }], "new"), [], "a version that was decided before leaves the queue only once");
assert.deepStrictEqual(queueItems(events, "update").map((i) => [i.start, i.end]).sort((a, b) => a[0] - b[0]), [[T("2026-10-28T10:00:00"), T("2026-10-29T10:00:00")], [T("2026-11-02T12:00:00"), Infinity]]);

// weeks of 26 October and 2 November (local Mondays at midnight)
const weeks = [new Date(2026, 9, 26), new Date(2026, 10, 2)];
const now = T("2026-11-04T00:00:00"); // the second week is cut off on Wednesday
// the days (now is Wednesday 00:00 of the second week), the days are local days
const days = Array.from({ length: 10 }, (_, i) => new Date(2026, 9, 26 + i));
const sizeAt = (list, day) => { const at = Math.min(T(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}T00:00:00`) + 86400000, now); return list.filter(({ start, end }) => start < at && end > at).length; };
assert.deepStrictEqual(days.slice(0, 9).map((d) => sizeAt(items, d)), [1, 2, 1, 2, 1, 2, 2, 2, 1], "a, b, d and w come and go");

// the flow: arrivals, first decisions and the size at the end of the week
const flow = weeklyFlow(queueItems(events, "new"), weeks, now);
assert.deepStrictEqual(flow.map((f) => [f.arrived, f.approved, f.rejected, f.size]), [[4, 1, 1, 2], [0, 0, 1, 1]], "week of 26 October: a, b, d and w arrive, a (approved) and d (rejected) leave, b and w are left. Week of 2 November: b is rejected on Tuesday, w is left");
assert.strictEqual(weeklyFlow(queueItems(events, "new"), weeks, T("2026-10-27T00:00:00")).length, 1, "a week that has not begun is left out");
// the age in whole weeks, per week: every add-on that was in the queue at any time of the week counts once, with its age when it left, or at the end of Sunday
const week26 = [new Date(2026, 9, 26)];
const wk = weeklyOldestAge([
  { start: T("2026-10-06T12:00:00"), end: Infinity }, // waits all week: 26.5 days old at the end of Sunday (2 November 00:00), so 3 weeks old
  { start: T("2026-10-27T06:00:00"), end: T("2026-10-29T12:00:00") }, // reviewed on Thursday, 2.25 days old, less than 1 week
  { start: T("2026-10-28T01:00:00"), end: T("2026-10-28T20:00:00") }, // in and out on the same day, 0.8 days old: it counts
  { start: T("2026-10-19T12:00:00"), end: T("2026-11-03T10:00:00") }, // 13.5 days old at the end of Sunday, reviewed next week: less than 2 weeks
  { start: T("2026-10-12T00:00:00"), end: T("2026-10-25T23:00:00") }, // left before the week: not in it
  { start: T("2026-11-02T08:00:00"), end: Infinity } // came after the week: not in it
], week26, T("2026-11-10T00:00:00"));
assert.strictEqual(wk.length, 1);
assert.deepStrictEqual(wk[0].counts.slice(0, 5), [2, 1, 0, 1, 0], "row i holds the add-ons less than i + 1 weeks old: two in the first row, one in the second, one in the fourth");
assert.ok(wk[0].counts.every((n) => Number.isInteger(n)), "whole add-ons, no fractions");
assert.strictEqual(wk[0].counts.reduce((a, b) => a + b, 0), 4, "each add-on that was in the queue in the week counts once, also the one that was there for hours only");
// the same add-on counts again in the next week, at its new age
const two = weeklyOldestAge([{ start: T("2026-10-06T12:00:00"), end: Infinity }], [new Date(2026, 9, 26), new Date(2026, 10, 2)], T("2026-11-10T00:00:00"));
assert.deepStrictEqual([two[0].counts.findIndex((n) => n), two[1].counts.findIndex((n) => n)], [3, 4], "3 weeks old at the end of the first week and 4 at the end of the next");
// the week that is not over ends at now
const partial = weeklyOldestAge([{ start: T("2026-11-02T00:00:00"), end: Infinity }], [new Date(2026, 10, 2)], T("2026-11-04T12:00:00"));
assert.strictEqual(partial[0].counts[0], 1, "2.5 days old now");
assert.strictEqual(weeklyOldestAge([{ start: T("2025-01-01T00:00:00"), end: Infinity }], week26, T("2026-11-10T00:00:00"))[0].counts[AGE_WEEK_EDGES.length - 1], 1, "the last row is that old and older");
assert.deepStrictEqual(weeklyOldestAge([], week26, T("2026-10-27T12:00:00"))[0].counts.every((n) => n === 0), true);
assert.strictEqual(AGE_WEEK_EDGES.length, 36, "36 weeks of age, the last row is that old and older");
// a group that is reviewed together keeps its height: 12 add-ons submitted together are 12 blocks in every week they are in the queue, and move up a row
const group = Array.from({ length: 12 }, (_, i) => ({ start: T("2026-10-12T00:05:00") + i * 60000, end: T("2026-10-28T15:10:00") }));
const groupWeeks = weeklyOldestAge(group, [new Date(2026, 9, 12), new Date(2026, 9, 19), new Date(2026, 9, 26)], T("2026-11-10T00:00:00"));
assert.deepStrictEqual(groupWeeks.map((w) => w.counts.findIndex((n) => n)), [0, 1, 2], "less than 1, 2 and 3 weeks old (the last one at the time it left)");
assert.deepStrictEqual(groupWeeks.map((w) => w.counts.reduce((a, b) => a + b, 0)), [12, 12, 12], "12 blocks in each of the three weeks, no spike when they leave");
// how long the add-ons of a week have waited: everything in the queue at some time of the week, at its age when it was reviewed or at the end of Sunday
const dayMs = 86400000;
const span = (startAt, days) => ({ start: T(startAt), end: T(startAt) + days * dayMs });
const rt = weeklyReviewTime([
  span("2026-10-20T00:00:00", 6.5), // reviewed on 26 October 12:00
  span("2026-10-24T00:00:00", 4), // reviewed on 28 October
  span("2026-10-20T00:00:00", 3), // reviewed on 23 October
  span("2026-10-30T00:00:00", 1), // reviewed on 31 October
  { start: T("2026-10-25T00:00:00"), end: Infinity } // still waiting
], [new Date(2026, 9, 19), new Date(2026, 9, 26), new Date(2026, 10, 2)], T("2026-11-05T00:00:00"));
assert.deepStrictEqual(rt.map((w) => [w.n, w.reviewed, w.waiting]), [[4, 1, 3], [4, 3, 1], [1, 0, 1]], "everything that was in the queue in the week, reviewed in it or not");
assert.deepStrictEqual([rt[0].median, rt[0].mean], [2.5, 3], "first week: 6 (to the end of Sunday), 2, 3 and 1 days");
assert.deepStrictEqual([rt[1].median, rt[1].mean], [5.25, 19.5 / 4], "second week: 6.5, 4, 1 and the one that waits 8 days at the end of Sunday");
assert.deepStrictEqual([rt[2].median, rt[2].mean], [11, 11], "third week, which ends now: nothing was decided and the waiting one is 11 days old, the week is not empty");
const stuck = weeklyReviewTime([{ start: T("2026-10-01T00:00:00"), end: Infinity }, { start: T("2026-10-10T00:00:00"), end: Infinity }], [new Date(2026, 9, 26), new Date(2026, 10, 2)], T("2026-11-09T00:00:00"));
assert.ok(stuck[1].median > stuck[0].median && stuck[0].reviewed === 0, "a week without a decision shows older and older add-ons");
const even = weeklyReviewTime([span("2026-10-26T00:00:00", 1), span("2026-10-26T00:00:00", 3)], [new Date(2026, 9, 26)], T("2026-11-05T00:00:00"));
assert.strictEqual(even[0].median, 2, "the median of two is between them");
assert.deepStrictEqual(weeklyReviewTime([], [new Date(2026, 9, 26)], T("2026-11-05T00:00:00"))[0], { start: new Date(2026, 9, 26), n: 0, reviewed: 0, waiting: 0, median: null, mean: null }, "no add-on in the queue: no point");
assert.strictEqual(weeklyReviewTime([span("2026-10-26T00:00:00", 1)], [new Date(2026, 10, 2)], T("2026-10-27T00:00:00")).length, 0, "a week that has not begun is left out");
// the anonymous file gives the same queue: only the reviewers and the comments differ
const { anonymousJson, newKey } = await import("../lib/anon.js");
const { parseImport } = await import("../lib/transfer.js");
const full = [...events, dec("x", "9", "Approved", "2026-10-26T10:00:00", "2026-10-26T12:00:00"), { ...dec("x", "9", "Rejected", "2026-10-26T10:00:00", "2026-11-01T12:00:00"), tWait: null }]
  .map((e, i) => ({ id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, dateRaw: e.date ? "July 7, 2026, 11:12 a.m." : "waiting", reviewer: "R", addonName: "n", comment: "c", siteAddonId: "1", type: "webextension", tWait: e.tWait === undefined ? 1 : e.tWait, ...e }));
const fromFile = parseImport(await anonymousJson(full, newKey())).events;
for (const queue of ["new", "update"]) {
  const sorted = (list) => [...list].sort((a, b) => a.start - b.start || a.end - b.end);
  assert.deepStrictEqual(sorted(queueItems(fromFile, queue)), sorted(queueItems(full, queue)), `the ${queue} queue of the anonymous file is the same (the order of the items does not matter)`);
}
console.log("queue tests ok");
