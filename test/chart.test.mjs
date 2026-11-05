// Run: node test/chart.test.mjs   (the drawing needs a DOM, the bucketing and the ticks do not)
import assert from "assert";
import { bucketEvents, heatStrength, niceStep, timeTicks } from "../lib/chart.js";

const ev = (date, event = "Approved") => ({ date, event });

// short span: days, empty days are kept
let r = bucketEvents([ev("2026-11-01T10:00:00"), ev("2026-11-04T08:00:00", "Rejected"), ev("2026-11-04T09:00:00", "Other thing")]);
assert.strictEqual(r.unit, "day");
assert.strictEqual(r.buckets.length, 4);
assert.deepStrictEqual(r.buckets.map((b) => b.approved + b.rejected + b.other), [1, 0, 0, 2]);
assert.strictEqual(r.buckets[3].rejected, 1);
assert.strictEqual(r.buckets[3].other, 1);

// about two years: weeks, starting on Monday
r = bucketEvents([ev("2025-01-01T10:00:00"), ev("2026-11-03T10:00:00")]);
assert.strictEqual(r.unit, "week");
assert.strictEqual(r.buckets[0].start.getDay(), 1, "weeks start on Monday");
assert.strictEqual(r.buckets[0].start.getFullYear(), 2024); // Wed 2025-01-01 belongs to the week of Mon 2024-12-30
assert.strictEqual(r.buckets.reduce((n, b) => n + b.approved, 0), 2);

// many years: months
r = bucketEvents([ev("2020-01-15T10:00:00"), ev("2026-11-03T10:00:00")]);
assert.strictEqual(r.unit, "month");
assert.strictEqual(r.buckets[0].start.getDate(), 1);
assert.strictEqual(r.buckets.length, 6 * 12 + 11);

// events without a date are ignored, nothing at all gives no buckets
assert.strictEqual(bucketEvents([ev(null)]).buckets.length, 0);
assert.strictEqual(bucketEvents([]).buckets.length, 0);

// ticks sit on calendar boundaries and respect the limit
const t0 = new Date(2025, 0, 1).getTime();
const t1 = new Date(2026, 10, 3).getTime();
let t = timeTicks(t0, t1, 7);
assert.strictEqual(t.unit, "month");
assert(t.ticks.length <= 7 && t.ticks.length >= 3);
assert(t.ticks.every((d) => d.getDate() === 1 && d.getMonth() % 3 === 0 || d.getDate() === 1), "ticks on the first of a month");
t = timeTicks(new Date(2020, 0, 1).getTime(), t1, 7);
assert.strictEqual(t.unit, "year");
t = timeTicks(new Date(2026, 10, 1).getTime(), new Date(2026, 10, 6).getTime(), 7);
assert.strictEqual(t.unit, "day");

assert.strictEqual(niceStep(0.7), 1);
assert.strictEqual(niceStep(3), 5);
assert.strictEqual(niceStep(12), 20);
assert.strictEqual(niceStep(60), 100);
console.log("chart tests ok");

// a range fixes the time axis: days without events stay in, events outside have no bucket
r = bucketEvents([ev("2026-11-02T10:00:00")], { start: "2026-11-01", end: "2026-11-04" });
assert.strictEqual(r.unit, "day");
assert.strictEqual(r.buckets.length, 4, "1 to 4 November");
assert.deepStrictEqual(r.buckets.map((b) => b.approved), [0, 1, 0, 0]);
r = bucketEvents([], { start: "2026-11-01", end: "2026-11-03" });
assert.strictEqual(r.buckets.length, 3, "an empty range still has its days");
r = bucketEvents([ev("2026-11-10T10:00:00")], { start: "2026-11-01", end: "2026-11-03" });
assert.deepStrictEqual(r.buckets.map((b) => b.approved), [0, 0, 0], "an event outside the range is not counted");
assert.strictEqual(bucketEvents([ev("2026-11-02T10:00:00")], { start: "2026-11-05", end: "2026-11-03" }).buckets.length, 0, "start after end");
r = bucketEvents([ev("2026-11-02T10:00:00"), ev("2026-11-04T10:00:00")], { start: "2026-11-01" });
assert.strictEqual(r.buckets.length, 4, "only a start: the end comes from the events");
console.log("chart range tests ok");

// buckets carry their events
r = bucketEvents([ev("2026-11-02T10:00:00"), ev("2026-11-02T12:00:00", "Rejected"), ev("2026-11-03T10:00:00")], { start: "2026-11-01", end: "2026-11-03" });
assert.deepStrictEqual(r.buckets.map((b) => b.items.length), [0, 2, 1]);

console.log("chart box plot tests ok");

// the time of an event can be its submission
r = bucketEvents([{ date: "2026-11-02T10:00:00", tSubmission: "2026-10-30T08:00:00", event: "Approved" }, { date: "2026-11-02T11:00:00", tSubmission: null, event: "Rejected" }, { date: "2026-11-03T10:00:00", event: "Approved" }], {}, "tSubmission");
assert.strictEqual(r.buckets.reduce((n, b) => n + b.items.length, 0), 1, "only the event with a submission time");
assert.strictEqual(r.buckets[0].start.getDate(), 30);
r = bucketEvents([{ date: "2026-11-02T10:00:00", tSubmission: "2026-10-30T08:00:00", event: "Approved" }], { end: "2026-11-02" }, "tSubmission");
assert.strictEqual(r.buckets.length, 4, "30 October to 2 November, the start comes from the submission");
console.log("chart submission tests ok");

// a fixed unit
r = bucketEvents([ev("2026-11-02T10:00:00")], { start: "2026-11-01", end: "2026-11-04" }, "date", "week");
assert.strictEqual(r.unit, "week");
assert.deepStrictEqual(r.buckets.map((b) => b.approved), [0, 1], "weeks of 26 October and 2 November, Monday first");
r = bucketEvents([ev("2026-11-02T10:00:00")], { start: "2025-01-01", end: "2026-11-04" }, "date", "week");
assert.strictEqual(r.unit, "week", "also for a range that would be months");
assert.strictEqual(bucketEvents([ev("2026-11-02T10:00:00")], { start: "2026-11-01", end: "2026-11-04" }).unit, "day", "without it the time span decides");
console.log("chart fixed unit tests ok");

// the heat is the inverse of a logarithm: nothing at 0, full at the busiest cell, a single add-on stays faint and many rise fast
assert.strictEqual(heatStrength(0, 20), 0);
assert.strictEqual(heatStrength(20, 20), 1);
assert.strictEqual(heatStrength(30, 20), 1, "more than the maximum is the maximum");
assert.ok(heatStrength(1, 20) < 0.05, "a single add-on among 20 is almost nothing");
assert.ok(heatStrength(10, 20) < 0.15, "half of the maximum is far from half the heat");
assert.ok(heatStrength(15, 20) > heatStrength(10, 20) * 2, "and it rises faster the more there are");
let last = -1;
for (let n = 0; n <= 20; n++) {
  assert.ok(heatStrength(n, 20) > last, "always rising");
  last = heatStrength(n, 20);
}
// the log of the heat is the straight line the other way: applying log1p to the heat gives back a straight line in n
const k = 4;
for (const n of [2, 5, 11]) {
  assert.ok(Math.abs(Math.log1p(heatStrength(n, 20) * Math.expm1(k)) - k * (n / 20)) < 1e-9, "inverse of log1p");
}
console.log("heat tests ok");
