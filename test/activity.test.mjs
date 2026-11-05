// Run: NODE_PATH=<dir with jsdom>/node_modules node test/activity.test.mjs
import assert from "assert";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<div id=a></div><div id=b></div><div id=c></div>");
globalThis.document = dom.window.document;
const { FLOW_STEP, flowBarsGraph, flowExtent, flowScale, REVIEW_TIME_STEP, reviewTimeExtent, reviewTimeGraph, sizeGraph } = await import("../lib/chart.js");

const week = (d, arrived, approved, rejected, size) => ({ start: new Date(2026, 0, d), arrived, approved, rejected, size });
const weeks = [week(5, 4, 2, 1, 10), week(12, 9, 3, 3, 12), week(19, 1, 6, 4, 2)];
const extent = flowExtent(weeks);
assert.deepStrictEqual(extent, { biggest: 10, sizeTop: 12 });
const scale = flowScale(extent, 400);
assert.ok(Math.abs(scale.k * (scale.sizeMax + 2 * scale.half) - 400) < 1e-9, "the size and the bars together use the plot pixels");
assert.ok(scale.sizeMax >= 12 && scale.half >= 10 && scale.sizeMax % scale.step === 0 && scale.half % scale.step === 0, "whole steps");

// a line every 10 add-ons, however high it goes (up to a number of lines that can be read)
assert.strictEqual(FLOW_STEP, 10);
assert.strictEqual(scale.step, 10);
assert.deepStrictEqual([flowScale({ biggest: 4, sizeTop: 138 }, 400).step, flowScale({ biggest: 120, sizeTop: 138 }, 400).step], [10, 10], "the lines stay 10 apart for a queue of 138");
assert.ok(flowScale({ biggest: 4, sizeTop: 1000 }, 400).step > 10, "and are coarser only when they would be more than 40 lines");
// the size graph and the bars graph have the same pixels for one add-on: their plots are as high as their ranges say
const viewHeight = (box) => Number(box.querySelector("svg").getAttribute("viewBox").split(" ")[3]);
const [a, b] = [document.getElementById("a"), document.getElementById("b")];
sizeGraph(a, weeks, { width: 400, scale });
flowBarsGraph(b, weeks, { width: 400, scale });
const pad = 46;
assert.ok(Math.abs((viewHeight(a) - pad) / scale.sizeMax - scale.k) < 1e-9, "pixels per add-on in the size graph");
assert.ok(Math.abs((viewHeight(b) - pad) / (2 * scale.half) - scale.k) < 1e-9, "and in the bars graph");
assert.strictEqual(a.querySelectorAll("path.line.size").length, 1);
assert.strictEqual(b.querySelectorAll("rect.flow-in").length, 3);
assert.strictEqual(b.querySelectorAll("rect.flow-rejected").length, 3);
assert.match(a.querySelector("rect.hover title").textContent, /^week from 2026-01-05: 10 in the queue at the end of the week$/);
// the height of a bar is its count times the scale
const bar = [...b.querySelectorAll("rect.flow-in")][1];
assert.ok(Math.abs(Number(bar.getAttribute("height")) - 9 * scale.k) < 1e-6, "9 submitted are 9 add-ons high");
// the graphs of the two queues can have the same axes: the same scale gives the same heights
const other = document.getElementById("c");
sizeGraph(other, [week(5, 1, 1, 1, 3)], { width: 400, scale });
assert.strictEqual(viewHeight(other), viewHeight(a), "a smaller queue has the same graph on the same scale");
sizeGraph(other, [], { width: 400, scale });
assert.strictEqual(other.textContent, "No data yet");

// the review time: a line for the median and one for the mean, they break where a week has no review
const times = [{ start: new Date(2026, 0, 5), n: 3, reviewed: 2, waiting: 1, median: 2, mean: 4 }, { start: new Date(2026, 0, 12), n: 0, reviewed: 0, waiting: 0, median: null, mean: null }, { start: new Date(2026, 0, 19), n: 1, reviewed: 0, waiting: 1, median: 5, mean: 5 }, { start: new Date(2026, 0, 26), n: 2, reviewed: 2, waiting: 0, median: 6, mean: 7 }];
assert.deepStrictEqual(reviewTimeExtent(times), { highest: 7 });
const t = document.createElement("div");
reviewTimeGraph(t, times, { width: 400 });
assert.strictEqual(t.querySelectorAll("path.line.median-time").length, 1, "the median: one line for the last two weeks");
assert.strictEqual(t.querySelectorAll("circle.dot-median-time").length, 1, "and a point for the first week, which is alone");
assert.strictEqual(t.querySelectorAll("path.line.mean-time").length, 1);
const titles = [...t.querySelectorAll("rect.hover title")].map((x) => x.textContent);
assert.strictEqual(titles[0], "week from 2026-01-05: median 2 days, mean 4 days, 3 add-ons (2 reviewed, 1 still waiting)");
assert.strictEqual(titles[1], "week from 2026-01-12: nothing in the queue");
assert.strictEqual(titles[2], "week from 2026-01-19: median 5 days, mean 5 days, 1 add-ons (0 reviewed, 1 still waiting)");
// the same axis for two graphs: the larger highest value
const axis = (box) => [...box.querySelectorAll("text.axis")].map((x) => x.textContent).filter((x) => /^\d+$/.test(x)).join();
const t2 = document.createElement("div");
reviewTimeGraph(t2, [{ start: new Date(2026, 0, 5), n: 1, reviewed: 1, waiting: 0, median: 1, mean: 1 }], { width: 400, extent: reviewTimeExtent(times) });
const t3 = document.createElement("div");
reviewTimeGraph(t3, times, { width: 400, extent: reviewTimeExtent(times) });
assert.strictEqual(axis(t2), axis(t3), "with the same extent the axes are the same");
// the axis of the review time has a line every 10 days, however high it goes
assert.strictEqual(REVIEW_TIME_STEP, 10);
const high = document.createElement("div");
reviewTimeGraph(high, [{ start: new Date(2026, 0, 5), n: 1, reviewed: 1, waiting: 0, median: 98, mean: 70 }], { width: 400 });
assert.strictEqual(axis(high), "0,10,20,30,40,50,60,70,80,90,100", "10 days apart up to the next whole step above 98");
const low = document.createElement("div");
reviewTimeGraph(low, [{ start: new Date(2026, 0, 5), n: 1, reviewed: 1, waiting: 0, median: 1.4, mean: 2.2 }], { width: 400 });
assert.strictEqual(axis(low), "0,10", "and 10 days is also the step of a graph with short reviews");
console.log("activity tests ok");
