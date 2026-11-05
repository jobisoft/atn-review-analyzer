// Run: node test/transfer.test.mjs
import assert from "assert";
import { buildExport, cleanEntry, cleanEvent, cleanPage, isBadEvent, isDay, isUuid, isWallTime, parseImport } from "../lib/transfer.js";

const rec = {
  id: "00000000-0000-4000-8000-000000000001", date: "2025-01-02T03:04:00", dateRaw: "Jan. 2, 2025, 3:04 a.m.",
  event: "Approved", reviewer: "Jess", comment: "ok\nline 2", addonName: "A", addonVersion: "1.0", addonSlug: "a",
  siteAddonId: "42", reviewUrl: "https://addons.thunderbird.net/en-US/reviewers/review/a", scannedAt: "2026-11-04T08:00:00.000Z"
};
const entry = {
  id: "00000000-0000-4000-8000-0000000000bb", addonSlug: "a", version: "1.0.0", headerDateText: "Jan. 2, 2025", state: "Approved",
  fetchedAt: "2026-11-04T08:00:00.000Z", oldest: true, html: '<table id="review-files"></table>'
};

// small checks
assert(isUuid(rec.id) && !isUuid("x") && !isUuid(5));
assert(isWallTime("2026-11-03T23:31:00") && !isWallTime("2026-11-03T23:31:00Z") && !isWallTime("2026-11-03"));
assert(isDay("") && isDay("2026-11-03") && !isDay("2026-11-3") && !isDay(null));

// events
assert.deepStrictEqual(cleanEvent(rec), { ...rec });
// the rows that a scan removes: no event, no slug and no version, nothing less
assert.strictEqual(isBadEvent({ event: "", addonSlug: "", addonVersion: "", addonName: "SoundMail", date: "2026-07-07T11:12:00", reviewer: "John" }), true, "the row of an older parser");
assert.strictEqual(isBadEvent({ ...rec }), false, "a good row");
for (const [what, patch] of [["an event name", { event: "Approved" }], ["a slug", { addonSlug: "a" }], ["a version", { addonVersion: "1.0" }]]) {
  assert.strictEqual(isBadEvent({ event: "", addonSlug: "", addonVersion: "", ...patch }), false, `a row with ${what} stays`);
}
assert.strictEqual(isBadEvent({ ...rec, event: "" }), false, "an event without a name but with add-on and version stays");
assert.strictEqual(isBadEvent({ ...rec, addonSlug: "", addonVersion: "" }), false, "an event with a name stays");
assert.strictEqual(cleanEvent({ ...rec, id: "x" }).id, null, "a malformed id is dropped");
assert.strictEqual(cleanEvent({ ...rec, date: "garbage" }).date, null);
assert.strictEqual(cleanEvent({ ...rec, scannedAt: "nope" }).scannedAt, null);
assert.strictEqual(cleanEvent({ ...rec, event: "" }), null, "a row without an event (an unlisted version, read by an older parser) is dropped");
assert.strictEqual(cleanEvent({ ...rec, addonSlug: "" }), null, "a row without a slug is dropped");
assert.strictEqual(cleanEvent({ ...rec, dateRaw: "" }), null);
assert.strictEqual(cleanEvent({ ...rec, comment: 5 }), null);
assert.strictEqual(cleanEvent({ ...rec, comment: "x".repeat(200001) }), null);
assert.strictEqual(cleanEvent({ ...rec, addonSlug: "None" }), null);
assert.strictEqual(cleanEvent(null), null);
assert.strictEqual(cleanEvent({ ...rec, reviewUrl: "x".repeat(2001) }).reviewUrl, "");
assert(!("tSubmission" in cleanEvent(rec)), "no cells for an event that was not looked up");

// the three cells: present means done, null means nothing to find
const done = cleanEvent({ ...rec, tSubmission: "2025-01-01T09:00:00", tWait: 1.234, queue: "new" });
assert.deepStrictEqual([done.tSubmission, done.tWait, done.queue], ["2025-01-01T09:00:00", 1.23, "new"]);
const nothing = cleanEvent({ ...rec, tSubmission: null, tWait: null, queue: null });
assert.deepStrictEqual([nothing.tSubmission, nothing.tWait, nothing.queue], [null, null, null]);
const odd = cleanEvent({ ...rec, tSubmission: "x", tWait: -1, queue: "maybe" });
assert.deepStrictEqual([odd.tSubmission, odd.tWait, odd.queue], [null, null, null], "bad values become null");

// entries
assert.deepStrictEqual(cleanEntry(entry), entry);
assert.strictEqual(cleanEntry({ ...entry, addonSlug: "None" }), null);
assert.strictEqual(cleanEntry({ ...entry, version: "" }), null);
assert.strictEqual(cleanEntry({ ...entry, html: "" }), null);
assert.strictEqual(cleanEntry({ ...entry, html: "x".repeat(5 * 1024 * 1024 + 1) }), null);
assert.strictEqual(cleanEntry({ ...entry, id: "x" }).id, null);
assert.strictEqual(cleanEntry({ ...entry, oldest: "yes" }).oldest, false, "only a real true counts");
assert.strictEqual(cleanEntry({ ...entry, oldest: undefined }).oldest, false);

// whole pages
const page = { addonSlug: "a", url: "https://x/y", fetchedAt: "2026-11-04T08:00:00.000Z", html: "<html>x</html>" };
assert.deepStrictEqual(cleanPage(page), page);
assert.strictEqual(cleanPage({ ...page, html: "" }), null);
assert.strictEqual(cleanPage({ ...page, addonSlug: "None" }), null);
assert.strictEqual(cleanPage({ ...page, url: undefined }).url, "");

// export and import
const file = buildExport([rec, { ...rec, id: "00000000-0000-4000-8000-000000000002", tSubmission: "2025-01-01T09:00:00", tWait: 1.2, queue: "update" }], [entry]);
const exported = JSON.parse(file);
assert.strictEqual(exported.version, 8);
assert(!("fingerprint" in exported.records[0]));
assert(!("tSubmission" in exported.records[0]) && exported.records[1].queue === "update", "cells only for events that have them");
assert(!("reviewPages" in exported) && !("readFailures" in exported));
const back = parseImport(file);
assert.strictEqual(back.events.length, 2);
assert.strictEqual(back.events[1].tWait, 1.2);
assert.deepStrictEqual(back.entries, [entry]);
assert.deepStrictEqual([back.ignored, back.invalid, back.legacyPages.length], [0, 0, 0]);

// older files: whole pages are returned to be cut, failures are ignored, no cells
const legacy = parseImport(JSON.stringify({ format: "reviewlog-export", version: 3, records: [rec], reviewPages: [page, { addonSlug: "z" }], readFailures: [{ url: "x" }] }));
assert.strictEqual(legacy.legacyPages.length, 1);
assert.strictEqual(legacy.invalid, 1, "a page without html is unreadable");
assert.strictEqual(legacy.events[0].tSubmission, undefined);

// rows without a slug are ignored in every list, other unreadable items are counted
const mixed = parseImport(JSON.stringify({ format: "reviewlog-export", version: 5, records: [rec, { ...rec, addonSlug: "None" }, { foo: 1 }],
  reviewEntries: [entry, { ...entry, addonSlug: "None" }, { addonSlug: "a" }] }));
assert.deepStrictEqual([mixed.events.length, mixed.entries.length, mixed.ignored, mixed.invalid], [1, 1, 2, 2]);

// refused files
assert.throws(() => parseImport("{"), /not valid JSON/);
assert.throws(() => parseImport("[]"), /not an export/);
assert.throws(() => parseImport(JSON.stringify({ format: "reviewlog-export", version: 9, records: [] })), /version 9/);
assert.throws(() => parseImport(JSON.stringify({ format: "reviewlog-export", version: 5 })), /no record list/);

console.log("transfer tests ok");

// type: one of the four types is kept, anything else is dropped, absent stays absent
for (const v of ["webextension", "experiment", "theme", "legacy"]) {
  assert.strictEqual(cleanEvent({ ...rec, type: v }).type, v);
}
for (const v of ["yes", 1, null, undefined]) {
  assert(!("type" in cleanEvent({ ...rec, type: v })), `dropped: ${v}`);
}
assert(!("type" in cleanEvent(rec)), "absent stays absent");
// a file of the versions up to 6 has isExperiment: true is an Experiment, false a WebExtension, null no type
assert.strictEqual(cleanEvent({ ...rec, isExperiment: true }).type, "experiment");
assert.strictEqual(cleanEvent({ ...rec, isExperiment: false }).type, "webextension");
assert(!("type" in cleanEvent({ ...rec, isExperiment: null })));
assert(!("isExperiment" in cleanEvent({ ...rec, isExperiment: true })), "the old field is not kept");
{
  const out = JSON.parse(buildExport([{ ...rec, type: "theme" }, { ...rec, dateRaw: "x" }], []));
  assert.strictEqual(out.records[0].type, "theme");
  assert(!("type" in out.records[1]), "no field for an event without a type");
  assert.strictEqual(parseImport(JSON.stringify(out)).events[0].type, "theme", "survives the round trip");
}
// the manifest text of an entry is kept (up to 1 MB), anything else is dropped
assert.strictEqual(cleanEntry({ ...entry, manifest: '{"a":1}' }).manifest, '{"a":1}');
assert(!("manifest" in cleanEntry({ ...entry, manifest: 5 })));
assert(!("manifest" in cleanEntry({ ...entry, manifest: "x".repeat(1024 * 1024 + 1) })));
assert(!("manifest" in cleanEntry(entry)), "absent stays absent");
{
  const out = JSON.parse(buildExport([], [{ ...entry, manifest: '{"a":1}' }, entry]));
  assert.strictEqual(out.reviewEntries[0].manifest, '{"a":1}');
  assert(!("manifest" in out.reviewEntries[1]));
  assert.strictEqual(parseImport(JSON.stringify(out)).entries[0].manifest, '{"a":1}', "survives the round trip");
}

// a waiting row (queue): no date, the reviewer Nobody, the queue of the queue even before its cells are known
const waiting = { ...rec, dateRaw: "waiting", date: null, event: "Awaiting Review", reviewer: "Nobody", queue: "new" };
const w = cleanEvent(waiting);
assert(w && w.date === null && w.queue === "new" && !("tSubmission" in w), "kept without cells");
assert.strictEqual(cleanEvent({ ...waiting, queue: "wrong" }).queue, undefined, "a wrong queue is dropped");
{
  const out = JSON.parse(buildExport([waiting, { ...waiting, tSubmission: "2026-10-28T13:25:00", tWait: null, queue: "update", type: "experiment" }], []));
  assert.strictEqual(out.records[0].queue, "new");
  assert(!("tSubmission" in out.records[0]));
  assert.strictEqual(out.records[1].tSubmission, "2026-10-28T13:25:00");
  const back = parseImport(JSON.stringify(out)).events;
  assert.strictEqual(back[0].queue, "new");
  assert.strictEqual(back[1].type, "experiment");
  assert.strictEqual(back[1].date, null);
}
console.log("type transfer tests ok");

// a file of the versions up to 7 has kind: it is read as the queue
{
  const old = { ...rec, tSubmission: "2026-10-28T13:25:00", tWait: 1, kind: "update" };
  const e = cleanEvent(old);
  assert.strictEqual(e.queue, "update");
  assert(!("kind" in e), "the old field is not kept");
  assert.strictEqual(cleanEvent({ ...rec, tSubmission: "2026-10-28T13:25:00", tWait: 1, kind: "wrong" }).queue, null);
  console.log("queue from kind ok");
}
