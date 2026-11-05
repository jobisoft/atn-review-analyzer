// Run: node test/anon.test.mjs
import assert from "assert";
import { anonymousEvents, anonymousJson, newKey } from "../lib/anon.js";
import { buildExport, parseImport } from "../lib/transfer.js";

const key = newKey();
assert.match(key, /^[0-9a-f]{64}$/);
assert.notStrictEqual(newKey(), key);

const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const ev = (n, slug, version, reviewer, event, date, extra = {}) => ({
  id: id(n), addonSlug: slug, addonVersion: version, addonName: `Name of ${slug}`, reviewer, event, date, dateRaw: date ? "July 7, 2026, 11:12 a.m." : "waiting",
  comment: `secret comment ${n}`, reviewUrl: `https://x/reviewers/review/${slug}`, siteAddonId: "987", scannedAt: "2026-11-04T08:18:12.199Z", ...extra
});
const events = [
  ev(1, "mail-merge", "1.0", "Jess Reviewer", "Approved", "2026-10-02T10:00:00", { queue: "new", tSubmission: "2026-10-01T09:00:00", tWait: 1.04, type: "webextension" }),
  ev(2, "mail-merge", "1.1", "Jess Reviewer", "Rejected", "2026-10-05T10:00:00", { queue: "update", tSubmission: "2026-10-04T09:00:00", tWait: 1.04, type: "experiment" }),
  ev(3, "other-addon", "1.0", "Nobody", "Awaiting Review", null, { queue: "new", tSubmission: "2026-11-01T00:00:00", tWait: null, type: undefined }),
  ev(4, "other-addon", "2.0", "John Bieling", "Approved", "2026-10-03T10:00:00", { queue: null, tSubmission: null, tWait: null, type: undefined })
];

const anon = await anonymousEvents(events, key);
assert.strictEqual(anon.length, 4);
// only the reviewers and the comments change
for (const [i, e] of anon.entries()) {
  const { reviewer, comment, ...rest } = e;
  const { reviewer: r0, comment: c0, ...rest0 } = events[i];
  assert.deepStrictEqual(rest, rest0, "everything else is as stored: add-on, name, version, dates, cells");
  assert.strictEqual(comment, "");
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
assert.ok(uuid.test(anon[0].reviewer) && uuid.test(anon[3].reviewer), "reviewers are UUIDs");
assert.strictEqual(anon[0].reviewer, anon[1].reviewer, "one reviewer, one id");
assert.notStrictEqual(anon[0].reviewer, anon[3].reviewer, "two reviewers, two ids");
assert.strictEqual(anon[2].reviewer, "Nobody", "the placeholder of a waiting version is not a person");
// consistent with the same key, different with another
assert.deepStrictEqual((await anonymousEvents(events, key)).map((e) => e.reviewer), anon.map((e) => e.reviewer));
assert.notStrictEqual((await anonymousEvents(events, newKey()))[0].reviewer, anon[0].reviewer);
// the input is not changed
assert.strictEqual(events[0].reviewer, "Jess Reviewer");
assert.strictEqual(events[0].comment, "secret comment 1");

// the file has the shape of the normal export and another profile can import it
const text = await anonymousJson(events, key);
for (const secret of ["Jess", "Reviewer", "John", "Bieling", "secret comment"]) {
  assert.ok(!text.includes(secret), `${secret} is not in the file`);
}
const file = JSON.parse(text);
assert.deepStrictEqual([file.format, file.version, file.anonymous, file.count, file.reviewEntryCount, file.reviewEntries], [JSON.parse(buildExport([])).format, JSON.parse(buildExport([])).version, true, 4, 0, []]);
assert.strictEqual(JSON.parse(buildExport(events)).anonymous, undefined, "a normal export is not marked");
const imported = parseImport(text);
assert.strictEqual(imported.anonymous, true);
assert.deepStrictEqual([imported.events.length, imported.ignored, imported.invalid], [4, 0, 0], "every row is accepted by the import");
assert.strictEqual(parseImport(buildExport(events)).anonymous, false);
const back = imported.events.find((e) => e.id === id(1));
assert.deepStrictEqual([back.addonSlug, back.addonName, back.addonVersion, back.tWait, back.type, back.queue, back.comment], ["mail-merge", "Name of mail-merge", "1.0", 1.04, "webextension", "new", ""]);
assert.strictEqual(imported.events.find((e) => e.id === id(3)).date, null, "a waiting version has no date");
console.log("anon tests ok");
