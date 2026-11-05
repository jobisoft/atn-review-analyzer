// Run: NODE_PATH=<dir with jsdom>/node_modules node test/surface.test.mjs
import assert from "assert";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<div id=c></div>");
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle;
// jsdom has no canvas: a context that only remembers what is painted
const calls = [];
const context = new Proxy({}, { get: (target, name) => (name in target ? target[name] : (...args) => calls.push([name, ...args])), set: (target, name, value) => { target[name] = value; return true; } });
dom.window.HTMLCanvasElement.prototype.getContext = () => context;
const { AGE_WEEK_COLORS, ageWeekColor, ageWeekCss, buildScene, columns3d, columnsOf, paintScene, pickTitle, projector, surfaceGraph, visibleSides } = await import("../lib/surface.js");

// the projection: seen from straight above (elevation 90) the heights do not move the point, and the depth is the age axis
const top = projector({ azimuth: 0, elevation: 90 });
assert.deepStrictEqual([top(3, 5, 0).x, top(3, 5, 7).x], [3, 3]);
assert.ok(Math.abs(top(3, 5, 0).y - top(3, 5, 7).y) < 1e-9, "from above the height does nothing");
// from the side (elevation 0) the age axis does not move up and down, the height does
const side = projector({ azimuth: 0, elevation: 0 });
assert.ok(Math.abs(side(0, 5, 0).y - side(0, 9, 0).y) < 1e-9);
assert.strictEqual(side(0, 0, 4).y, -4, "up is up");
// a point further along the age axis is nearer to the viewer when it is not turned
const p = projector({ azimuth: 0, elevation: 40 });
assert.ok(p(0, 9, 0).depth > p(0, 1, 0).depth);
// turned a quarter, the weeks take that role
const q = projector({ azimuth: -90, elevation: 40 });
assert.ok(q(9, 0, 0).depth > q(1, 0, 0).depth);

// the sides that are seen
assert.deepStrictEqual(visibleSides(0), { plusU: false, minusU: false, plusV: true, minusV: false });
assert.deepStrictEqual(visibleSides(30), { plusU: false, minusU: true, plusV: true, minusV: false });
assert.deepStrictEqual(visibleSides(180), { plusU: false, minusU: false, plusV: false, minusV: true });

// the columns: only cells with something in them
const week = (d, counts) => ({ start: new Date(2026, 0, d), counts });
const weeks = [week(5, [0, 2, 0, 1]), week(12, [0, 0, 0, 0]), week(19, [3, 0, 0, 0])];
assert.deepStrictEqual(columnsOf(weeks), [{ u: 0, v: 1, n: 2 }, { u: 0, v: 3, n: 1 }, { u: 2, v: 0, n: 3 }]);

// the scene: a face for each side that is seen and a top, from the back to the front
const spec = { columns: [{ u: 0, v: 0, value: 5, hue: 10, title: "back" }, { u: 1, v: 3, value: 2, title: "front" }], sizeU: 3, sizeV: 4, maxValue: 5, width: 300, height: 300 };
const scene = buildScene(spec, { azimuth: 0, elevation: 30 });
assert.deepStrictEqual(scene.boxes.map((b) => b.title), ["back", "front"], "the column with the smaller v is further away and comes first");
assert.deepStrictEqual(scene.boxes[0].faces.map((f) => f.light), [30, 52], "straight from the front: the front side and the top");
assert.ok(scene.boxes.every((b) => b.faces.every((f) => f.points.every(([x, y]) => x >= 0 && x <= 300 && y >= 0 && y <= 300))), "everything is inside the picture");
const turned = buildScene(spec, { azimuth: 180, elevation: 30 });
assert.deepStrictEqual(turned.boxes.map((b) => b.title), ["front", "back"], "seen from behind the order is the other way");
// from the side the floor is a line, from above it is the whole floor
const spanY = (s) => Math.max(...s.floor.map((f) => f[1])) - Math.min(...s.floor.map((f) => f[1]));
assert.ok(spanY(buildScene(spec, { azimuth: 0, elevation: 0 })) < 0.05, "seen from the side the floor is a line");
assert.ok(spanY(buildScene(spec, { azimuth: 0, elevation: 90 })) > 20);
// what is under the mouse
const tops = scene.boxes[1].faces.at(-1).points;
const middle = [tops.reduce((s, [x]) => s + x, 0) / 4, tops.reduce((s, [, y]) => s + y, 0) / 4];
assert.strictEqual(pickTitle(scene, ...middle), "front");
assert.strictEqual(pickTitle(scene, 0, 0), "");

// the canvas: one element, painted, a tooltip under the mouse, a turn by dragging, and back by a double click
const c = document.getElementById("c");
surfaceGraph(c, weeks, { edges: [0, 1, 2, 3], max: 3, target: { days: 2, label: "2 days" } });
const canvas = c.querySelector("canvas");
assert.strictEqual(c.querySelectorAll("canvas").length, 1, "one canvas, not a polygon for every face");
assert.ok(calls.some(([name, text]) => name === "fillText" && text === "2 days"), "the dotted line has its label");
assert.strictEqual(calls.filter(([name]) => name === "fill").length >= 1 + 3 * 2, true, "the floor and the faces are filled");
const first = JSON.stringify(c.__scene());
const fire = (type, x, y) => canvas.dispatchEvent(Object.assign(new dom.window.Event(type, { bubbles: true }), { clientX: x, clientY: y, pointerId: 1 }));
fire("pointerdown", 100, 100);
fire("pointermove", 220, 100);
fire("pointerup", 220, 100);
assert.notStrictEqual(JSON.stringify(c.__scene()), first, "dragging turns the picture");
canvas.dispatchEvent(new dom.window.Event("dblclick", { bubbles: true }));
assert.strictEqual(JSON.stringify(c.__scene()), first, "a double click puts it back");
fire("pointerdown", 0, 500);
fire("pointermove", 0, 0); // far up: it stops at the side
assert.ok(spanY(c.__scene()) < 0.05, "dragging all the way to the side gives the line and not less");
fire("pointermove", 0, 5000); // far down: it stops at the top
assert.ok(spanY(c.__scene()) > 20, "and from above it is the whole floor");
fire("pointerup", 0, 5000);
// zoom and move: the buttons, Ctrl and the wheel around the pointer, Ctrl and drag (the same key)
const bounds2 = (s) => { const xs = s.floor.map((f) => f[0]); const ys = s.floor.map((f) => f[1]); return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), x: Math.min(...xs), y: Math.min(...ys) }; };
canvas.dispatchEvent(new dom.window.Event("dblclick", { bubbles: true }));
const base = bounds2(c.__scene());
const [zoomIn, zoomOut, back] = c.querySelectorAll(".surface-tools button");
zoomIn.click();
assert.ok(Math.abs(bounds2(c.__scene()).w / base.w - 1.15) < 1e-6, "the plus button zooms in by 15 percent");
zoomOut.click();
assert.ok(Math.abs(bounds2(c.__scene()).w / base.w - 1) < 1e-6, "and the minus button out again");
for (let i = 0; i < 40; i++) zoomIn.click();
assert.ok(bounds2(c.__scene()).w / base.w <= 12.0001, "the zoom stops at 12 times");
back.click();
assert.ok(Math.abs(bounds2(c.__scene()).w - base.w) < 1e-6, "the reset button puts it back");
const wheel = (deltaY, ctrlKey, x = 100, y = 100) => { const e = Object.assign(new dom.window.Event("wheel", { bubbles: true, cancelable: true }), { deltaY, ctrlKey, clientX: x, clientY: y }); canvas.dispatchEvent(e); return e; };
assert.strictEqual(wheel(-100, false).defaultPrevented, false, "the wheel alone is left to the page");
assert.ok(Math.abs(bounds2(c.__scene()).w - base.w) < 1e-6);
// one notch of the wheel (100 pixels, or 3 lines in Firefox) is a small step, not a doubling
const notchPixels = wheel(-100, true);
const afterNotch = bounds2(c.__scene()).w / base.w;
assert.ok(afterNotch > 1.15 && afterNotch < 1.3, `one notch is about 22 percent (${afterNotch})`);
back.click();
const lineWheel = Object.assign(new dom.window.Event("wheel", { bubbles: true, cancelable: true }), { deltaY: -3, deltaMode: 1, ctrlKey: true, clientX: 100, clientY: 100 });
canvas.dispatchEvent(lineWheel);
assert.ok(Math.abs(bounds2(c.__scene()).w / base.w - afterNotch) < 0.03, "3 lines are the same as a notch of 100 pixels");
back.click();
const zoomed = wheel(-100, true);
assert.strictEqual(zoomed.defaultPrevented, true, "Ctrl and the wheel zoom and do not scroll the page");
assert.ok(bounds2(c.__scene()).w > base.w * 1.1, "zoomed in");
// around the pointer: the point of the floor under it does not move (the picture is 324 wide in jsdom, so a pointer at x = 100 is at x = 100)
back.click();
const before = c.__scene().floor[0];
const pointerX = before[0];
const pointerY = before[1];
wheel(-100, true, pointerX, pointerY);
const after = c.__scene().floor[0];
assert.ok(Math.abs(after[0] - pointerX) < 1e-6 && Math.abs(after[1] - pointerY) < 1e-6, "the corner under the pointer stays where it is");
back.click();
const moved0 = bounds2(c.__scene());
canvas.dispatchEvent(Object.assign(new dom.window.Event("pointerdown", { bubbles: true }), { clientX: 100, clientY: 100, ctrlKey: true, pointerId: 1 }));
fire("pointermove", 130, 120);
fire("pointerup", 130, 120);
const moved1 = bounds2(c.__scene());
assert.ok(Math.abs(moved1.x - moved0.x) > 1 && Math.abs(moved1.w - moved0.w) < 1e-6, "Ctrl and drag moves the picture without turning it");
back.click();
// Cmd does the same on a Mac
const metaWheel = Object.assign(new dom.window.Event("wheel", { bubbles: true, cancelable: true }), { deltaY: -100, metaKey: true, clientX: 100, clientY: 100 });
canvas.dispatchEvent(metaWheel);
assert.strictEqual(metaWheel.defaultPrevented, true);
assert.ok(bounds2(c.__scene()).w > base.w * 1.1, "Cmd and the wheel zoom");
back.click();
surfaceGraph(c, [], { edges: [0], max: 1 });
assert.strictEqual(c.textContent, "No data yet");

// the rows can be weeks of age: the tooltip and the labels say so
const ww = document.createElement("div");
surfaceGraph(ww, [week(5, [0, 4]), week(12, [1, 0])], { edges: [0, 1], max: 4, rows: { suffix: "w", word: "weeks", every: 1 } });
assert.match(ww.__scene().boxes[0].title, /^week from 2026-01-\d\d, \d weeks old: \d add-ons$/);
assert.ok(ww.__scene().texts.some((t) => t.text === "1 w"));
// labels on the edges between the rows, as the analysis page has them: 1w is between the first and the second row
const lt = document.createElement("div");
surfaceGraph(lt, [week(5, [2, 0, 0, 0, 1])], { edges: [0, 1, 2, 3, 4], max: 2, rows: { atEdges: true, label: (k) => `${k}w`, describe: (age) => `less than ${age + 1} weeks old`, show: (k) => k >= 1 && (k <= 2 || k % 5 === 0), gridEvery: 1 } });
assert.deepStrictEqual(lt.__scene().texts.filter((x) => x.anchor !== "center").map((x) => x.text), ["1w", "2w", "5w"], "the edge after the last row (5) is there too");
assert.match(lt.__scene().boxes[0].title, /^week from 2026-01-05, less than 1 weeks old: 2 add-ons$/);
// the edge labels are at the edges: the distance between the first and the second is one row
const ys = lt.__scene().texts.filter((x) => x.anchor !== "center");
assert.ok(ys[0].y !== ys[1].y || ys[0].x !== ys[1].x, "the labels are at different places");

// and they are really on the edge: the "1w" label is at the far edge of the first row, where a column of that row ends
const edgeSpec = { columns: [{ u: 0, v: 0, value: 2 }], sizeU: 3, sizeV: 4, maxValue: 2, ticksV: [{ at: 1, text: "1w" }], width: 300, height: 300 };
const edgeScene = buildScene(edgeSpec, { azimuth: 0, elevation: 30 });
const tick = edgeScene.texts.find((x) => x.text === "1w");
const corners = edgeScene.boxes[0].faces.flatMap((f) => f.points);
assert.ok(corners.some(([x, y]) => Math.abs(x - (tick.x + 6)) < 1e-6 || Math.abs(x - (tick.x - 6)) < 1e-6) && corners.some(([x, y]) => Math.abs(y - (tick.y - 3)) < 1e-6), "the label is at the corner of the first row, not in the middle of it");
// the picture with the age in weeks is coloured by the row: green, yellow, orange, red and dark red for the rest, the opacity stays by the number
assert.deepStrictEqual([0, 1, 2, 3, 4, 9].map((r) => ageWeekColor(r).hue), [120, 55, 30, 0, 0, 0]);
assert.ok(ageWeekColor(9).shift < 0 && ageWeekColor(3).shift === 0, "older than 4 weeks is darker than red");
assert.strictEqual(AGE_WEEK_COLORS.length, 5);
assert.match(ageWeekCss(1), /^hsl\(55 /);
const byAge = document.createElement("div");
surfaceGraph(byAge, [week(5, [4, 0, 1, 0, 0, 3]), week(12, [0, 0, 0, 0, 0, 0])], { edges: [0, 1, 2, 3, 4, 5], max: 4, colorBy: "age-weeks" });
assert.deepStrictEqual(byAge.__scene().boxes.map((b) => b.hue).sort((a, b) => a - b), [0, 30, 120], "the hue follows the row and not the number");
const byCount = document.createElement("div");
surfaceGraph(byCount, [week(5, [4, 0, 1, 0, 0, 3])], { edges: [0, 1, 2, 3, 4, 5], max: 4 });
assert.ok(new Set(byCount.__scene().boxes.map((b) => b.hue)).size === 3 && byCount.__scene().boxes.some((b) => b.hue === 0), "by the number the most is red");
const darker = byAge.__scene().boxes.find((b) => b.faces.at(-1).light < 52);
assert.ok(darker, "the dark red top is darker than the others");

// the general chart: any columns, any labels, no weeks and no ages
const g = document.createElement("div");
columns3d(g, { columns: [{ u: 0, v: 0, value: 5, hue: 10, title: "first" }, { u: 1, v: 1, value: 2 }], sizeU: 3, sizeV: 2, maxValue: 9, ticksU: [{ at: 0.5, text: "A" }], ticksV: [{ at: 0.5, text: "x" }], lineV: { at: 1, label: "limit" }, view: { azimuth: 0, elevation: 30 } });
assert.deepStrictEqual(g.__scene().texts.map((t) => t.text), ["A", "x"]);
assert.strictEqual(g.__scene().line.label, "limit");
// without canvas there is a message and no failure
dom.window.HTMLCanvasElement.prototype.getContext = () => null;
const none = document.createElement("div");
columns3d(none, { columns: [], sizeU: 1, sizeV: 1, maxValue: 1 });
assert.match(none.textContent, /needs canvas/);
console.log("surface tests ok");
