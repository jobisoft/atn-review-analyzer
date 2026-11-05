// Run: NODE_PATH=<dir with jsdom>/node_modules node test/reviewdom.test.mjs
import assert from "assert";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
globalThis.ReviewLogParser = require("../lib/parser.js");
globalThis.ReviewPage = require("../lib/reviewpage.js");
const { renderEntry } = await import("../lib/reviewdom.js");

const parse = (html) => new JSDOM(html).window.document;
const env = { doc: parse("<!doctype html><body></body>"), parse };

const row = (label, who, when) => `<tr><th>${label}</th><td><div>By <a href="/u/" onclick="x()">${who}</a> on ${when}</div></td></tr>`;
const version = (v, day, rows) => `<table id="review-files"><tbody><tr class="listing-header"><th colspan="2">Version ${v} &middot; ${day} <span class="light">&middot; Approved</span></th></tr>
<tr class="listing-body"><td class="files"><ul><li>files</li></ul></td><td><table class="activity">
<tr><th>Notes for Reviewers</th><td class="activity_approval"><div class="history-notes">Please test.</div></td></tr>${rows}</table></td></tr></tbody></table>`;
const html = version("1.1.0", "Oct. 17, 2026", row("", "Dev", "Oct. 17, 2026, 8:05 a.m.") + row("Approved", "Jess", "Oct. 21, 2026, 11:31 p.m."));

// a submission with a time: the header day and the row are boxed
let r = renderEntry(html, { date: "2026-10-21T23:31:00" }, env);
assert.strictEqual(r.version, "1.1.0");
assert.strictEqual(r.state, "Approved");
assert.strictEqual(r.block.tagName, "TABLE");
assert.deepStrictEqual([...r.block.querySelectorAll(".rv-red-box")].map((e) => e.textContent), ["Oct. 17, 2026", "Oct. 17, 2026, 8:05 a.m."]);
assert.strictEqual(r.block.querySelectorAll("[class*='box']").length, 2, "nothing else is boxed");

// no row on the day of the header (or only later than the event): only the day is known, only the header date is boxed
r = renderEntry(html, { date: "2026-10-17T07:00:00" }, env);
assert.deepStrictEqual([...r.block.querySelectorAll(".rv-red-box")].map((e) => e.textContent), ["Oct. 17, 2026"]);

// the copy is safe and its classes carry a prefix
assert.strictEqual(r.block.querySelectorAll("script, img, a, iframe").length, 0);
assert(![...r.block.querySelectorAll("*")].some((e) => [...e.attributes].some((a) => !["class", "colspan", "rowspan"].includes(a.name))));
assert(![...r.block.querySelectorAll("[class]")].some((e) => [...e.classList].some((c) => !c.startsWith("rv-"))));
assert(r.block.textContent.includes("Please test."));

// something that is not an entry
assert.strictEqual(renderEntry("<html><body>nothing</body></html>", { date: "2026-10-17T07:00:00" }, env), null);

console.log("reviewdom tests ok");
