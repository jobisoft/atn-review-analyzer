/* Small SVG chart helpers. No libraries. Colors come from CSS classes. */

const SVG_NS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

export function categoryOf(event) {
  if (event === "Approved") {
    return "approved";
  }
  if (event === "Rejected") {
    return "rejected";
  }
  if (event === "Awaiting Review") { // a version that waits in the review queue
    return "waiting";
  }
  return "other";
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86400000;

function startOf(date, unit) {
  const d = new Date(date);
  if (unit === "month") {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return unit === "week" ? new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7)) : day;
}

function addUnit(date, unit, n = 1) {
  if (unit === "month") {
    return new Date(date.getFullYear(), date.getMonth() + n, 1);
  }
  if (unit === "year") {
    return new Date(date.getFullYear() + n, 0, 1);
  }
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + (unit === "week" ? 7 * n : n));
}

/**
 * Counts per day, week (Monday first) or month, depending on the time span, or per the given unit. Empty buckets stay in.
 * range: { start, end } as days (YYYY-MM-DD), the graph covers exactly these days. A missing one is taken from the events.
 * key: the field with the time of an event, "date" (when it happened) or "tSubmission". Events without it are left out.
 * fixedUnit: "day", "week" or "month" to use that unit whatever the time span.
 */
export function bucketEvents(events, range = {}, key = "date", fixedUnit = "") {
  const dated = events.filter((e) => e[key]);
  if (dated.length === 0 && !(range.start && range.end)) {
    return { unit: "month", buckets: [] };
  }
  let min = Infinity;
  let max = -Infinity;
  for (const e of dated) {
    const t = new Date(e[key]).getTime();
    min = Math.min(min, t);
    max = Math.max(max, t);
  }
  if (range.start) {
    min = new Date(`${range.start}T00:00:00`).getTime();
  }
  if (range.end) {
    max = new Date(`${range.end}T23:59:59`).getTime();
  }
  if (!(min <= max)) {
    return { unit: "month", buckets: [] };
  }
  const spanDays = (max - min) / DAY_MS;
  const unit = fixedUnit || (spanDays <= 90 ? "day" : spanDays <= 800 ? "week" : "month");
  const buckets = [];
  const index = new Map();
  for (let d = startOf(min, unit); d.getTime() <= max; d = addUnit(d, unit)) {
    index.set(d.getTime(), buckets.length);
    buckets.push({ start: d, end: addUnit(d, unit), approved: 0, rejected: 0, other: 0, waiting: 0, items: [] });
  }
  for (const e of dated) {
    const bucket = index.get(startOf(e[key], unit).getTime());
    if (bucket !== undefined) { // an event outside the range has no bucket
      buckets[bucket][categoryOf(e.event)]++;
      buckets[bucket].items.push(e);
    }
  }
  return { unit, buckets };
}

export function niceStep(rough) {
  const pow = 10 ** Math.floor(Math.log10(rough));
  const f = rough / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

/** Ticks on real calendar boundaries (days, months, years), as few as fit into maxTicks. */
export function timeTicks(t0, t1, maxTicks) {
  const options = [
    ["day", 1], ["day", 2], ["day", 7], ["month", 1], ["month", 2], ["month", 3], ["month", 6],
    ["year", 1], ["year", 2], ["year", 5], ["year", 10]
  ];
  for (const [unit, n] of options) {
    let d = unit === "year" ? new Date(new Date(t0).getFullYear(), 0, 1)
      : unit === "month" ? new Date(new Date(t0).getFullYear(), new Date(t0).getMonth(), 1)
        : new Date(new Date(t0).getFullYear(), new Date(t0).getMonth(), new Date(t0).getDate());
    if (unit === "month") {
      while (d.getMonth() % n !== 0) {
        d = addUnit(d, "month", 1);
      }
    } else if (unit === "year") {
      while (d.getFullYear() % n !== 0) {
        d = addUnit(d, "year", 1);
      }
    }
    while (d.getTime() < t0) {
      d = addUnit(d, unit, n);
    }
    const ticks = [];
    for (; d.getTime() <= t1 && ticks.length <= 400; d = addUnit(d, unit, n)) {
      ticks.push(new Date(d));
    }
    if (ticks.length <= maxTicks) {
      return { unit, ticks };
    }
  }
  return { unit: "year", ticks: [new Date(t0)] };
}

export function tickLabel(d, unit) {
  if (unit === "year") {
    return String(d.getFullYear());
  }
  return unit === "month" ? `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}` : `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

const PAD = { left: 44, right: 10, top: 8, bottom: 38 };
let frames = 0; // makes the id of every clip path different

/**
 * The frame of a graph on a time axis: grid and labels of the y axis (0 to top in steps of step, and a line at top itself, the label of a line
 * is levelLabel(value) if given), ticks on calendar boundaries and the titles. pixels: the drawing keeps its size, the page may scroll it, else it is scaled to its box.
 * What lies beyond top is drawn as it is and has to be cut off by the clip path (id in the result). Returns { svg, x, y, plotW, plotH } with x(time) and y(value) in the units of the drawing.
 */
function frame({ width, height, buckets, unit, top, step, yTitle, label, pixels = false, levelLabel = null, rightPad = PAD.right }) {
  const plotW = width - PAD.left - rightPad;
  const plotH = height - PAD.top - PAD.bottom;
  const t0 = buckets[0].start.getTime();
  const t1 = buckets[buckets.length - 1].start.getTime();
  const x = (t) => (t1 === t0 ? PAD.left + plotW / 2 : PAD.left + ((t - t0) / (t1 - t0)) * plotW);
  const y = (v) => PAD.top + plotH - (v / top) * plotH;
  const levels = [];
  for (let v = 0; v <= top + step / 1000; v += step) {
    levels.push(v);
  }
  if (levels[levels.length - 1] < top - step / 1000) {
    levels.push(top); // a top that is no multiple of the step
  }
  const clip = `clip-${++frames}`;
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, width: pixels ? width : "100%", role: "img", "aria-label": label });
  const clipPath = el("clipPath", { id: clip });
  clipPath.append(el("rect", { x: PAD.left, y: PAD.top, width: plotW, height: plotH }));
  svg.append(clipPath);
  levels.forEach((v, i) => {
    svg.append(el("line", { x1: PAD.left, x2: width - rightPad, y1: y(v), y2: y(v), class: i === 0 ? "axis-line" : "grid" }));
    svg.append(el("text", { x: PAD.left - 4, y: y(v) + 3, class: "axis", "text-anchor": "end" }, levelLabel ? levelLabel(v) : String(Math.round(v * 1e6) / 1e6)));
  });
  svg.append(el("text", { x: 0, y: 0, class: "axis axis-title", "text-anchor": "middle", transform: `translate(9 ${PAD.top + plotH / 2}) rotate(-90)` }, yTitle));
  const { unit: tickUnit, ticks } = timeTicks(t0, t1, Math.max(2, Math.floor(plotW / 52)));
  for (const d of ticks) {
    const tx = x(d.getTime());
    svg.append(el("line", { x1: tx, x2: tx, y1: PAD.top + plotH, y2: PAD.top + plotH + 3, class: "axis-line" }));
    svg.append(el("text", { x: tx, y: PAD.top + plotH + 13, class: "axis", "text-anchor": "middle" }, tickLabel(d, tickUnit)));
  }
  svg.append(el("text", { x: PAD.left + plotW / 2, y: height - 3, class: "axis axis-title", "text-anchor": "middle" }, "Date"));
  return { svg, x, y, plotW, plotH, unit, clip };
}

/** An invisible column per bucket carries the tooltip. text(bucket) is the tooltip. */
function hoverColumns(f, buckets, text) {
  const slot = buckets.length === 1 ? f.plotW : f.plotW / (buckets.length - 1);
  for (const b of buckets) {
    const col = el("rect", { x: f.x(b.start.getTime()) - slot / 2, y: PAD.top, width: slot, height: f.plotH, class: "hover" });
    col.append(el("title", {}, text(b)));
    f.svg.append(col);
  }
}

/** The day of a date at local midnight as YYYY-MM-DD (toISOString would give the day before east of Greenwich). */
const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Stacked line graph on a real time axis: approved at the bottom, rejected on top of it, other on top of that, pending (orange) on top.
 * The x position is the date, the y value is the number of events per day, week or month (shown in the label).
 * range: { start, end } (days) fixes the time axis, by default it covers the events. key: "date" or "tSubmission", see bucketEvents.
 * unit: "day", "week" or "month" instead of the one that fits the time span.
 * totalLabel: a tooltip with only the period and the total ("week from 2026-10-26: 57 submitted"), else it says how many of each kind.
 */
export function timeline(container, events, { width = 324, height = 170, range = {}, key = "date", totalLabel = "", unit: fixedUnit = "" } = {}) {
  container.replaceChildren();
  const { unit, buckets } = bucketEvents(events, range, key, fixedUnit);
  if (buckets.length === 0) {
    container.textContent = "No data yet";
    return;
  }
  const stacks = buckets.map((b) => ({
    rejected: b.rejected, other: b.rejected + b.other, approved: b.rejected + b.other + b.approved, waiting: b.rejected + b.other + b.approved + b.waiting
  })); // from the bottom: rejected, other, approved, pending
  const rawMax = Math.max(1, ...stacks.map((p) => p.waiting));
  const step = niceStep(rawMax / 4);
  const top = Math.ceil(rawMax / step) * step;
  const f = frame({ width, height, buckets, unit, top, step, yTitle: `Events per ${unit}`, label: `Review activity, events per ${unit}` });
  const { svg, x, y } = f;
  const t0 = buckets[0].start.getTime();
  const t1 = buckets[buckets.length - 1].start.getTime();
  const point = (p, i, cat) => `${x(buckets[i].start.getTime()).toFixed(1)} ${y(p[cat]).toFixed(1)}`;
  const base = PAD.top + f.plotH;
  for (const cat of ["waiting", "approved", "other", "rejected"]) { // top layer first, lower layers over it
    const pts = stacks.map((p, i) => point(p, i, cat));
    svg.append(el("path", {
      d: `M ${x(t0).toFixed(1)} ${base} L ${pts.join(" L ")} L ${x(t1).toFixed(1)} ${base} Z`, class: `area ${cat}`
    }));
  }
  for (const cat of ["waiting", "approved", "other", "rejected"]) {
    svg.append(el("path", { d: `M ${stacks.map((p, i) => point(p, i, cat)).join(" L ")}`, class: `line ${cat}` }));
    if (buckets.length <= 40) {
      stacks.forEach((p, i) => svg.append(el("circle", { cx: x(buckets[i].start.getTime()), cy: y(p[cat]), r: 1.8, class: `dot ${cat}` })));
    }
  }
  hoverColumns(f, buckets, (b) => (totalLabel
    ? `${unit} from ${day(b.start)}: ${b.approved + b.rejected + b.other + b.waiting} ${totalLabel}`
    : `${unit} from ${day(b.start)}: ${b.approved} approved, ${b.rejected} rejected, ${b.other} other${b.waiting ? `, ${b.waiting} pending` : ""}`));
  container.append(svg);
}

const round2 = (v) => Math.round(v * 100) / 100;

/** The largest bar and the largest size of the graphs of what came and went. Two graphs that are compared get the extent of both (mergeExtents). */
export const flowExtent = (weeks) => ({ biggest: Math.max(1, ...weeks.map((w) => Math.max(w.arrived, w.approved + w.rejected))), sizeTop: Math.max(1, ...weeks.map((w) => w.size)) });

/** The extent that covers all of the extents, for graphs that must have the same axes. */
export const mergeExtents = (extents) => Object.fromEntries(Object.keys(extents[0]).map((key) => [key, (key === "lowest" ? Math.min : Math.max)(...extents.map((e) => e[key]))]));

const PLOT_PAD = PAD.top + PAD.bottom; // what a graph needs besides its plot, vertically

/** The lines of the axes of the graphs that count add-ons: one every 10, and at most this many in the highest graph. */
export const FLOW_STEP = 10;
const FLOW_MAX_LINES = 40;

/**
 * The scale of the three graphs of Review Queue Activity that count add-ons (the size of the queue, and the bars of what came and went): the same number of pixels for one add-on in all of them.
 * extent: { biggest, sizeTop } (see flowExtent). plotTotal: the pixels of the plots of the size graph and the bars graph together. Returns { step, sizeMax, half, k }, k is the pixels for one add-on.
 */
export function flowScale({ biggest, sizeTop }, plotTotal) {
  const most = Math.max(sizeTop, biggest);
  const step = most / FLOW_STEP > FLOW_MAX_LINES ? niceStep(most / FLOW_MAX_LINES) : FLOW_STEP; // a line every 10 add-ons, coarser only when that would be more than FLOW_MAX_LINES lines
  const sizeMax = Math.ceil(sizeTop / step) * step; // the size runs from 0 to sizeMax
  const half = Math.ceil(biggest / step) * step; // the bars from -half to half
  return { step, sizeMax, half, k: plotTotal / (sizeMax + 2 * half) };
}

/** The size of a queue at the end of every week as a line. weeks: [{ start, size, ... }] from weeklyFlow. scale: from flowScale, it sets the height of the graph. */
export function sizeGraph(container, weeks, { width = 324, scale, pixels = false } = {}) {
  container.replaceChildren();
  if (weeks.length === 0) {
    container.textContent = "No data yet";
    return;
  }
  const { step, sizeMax, k } = scale;
  const f = frame({ width, height: sizeMax * k + PLOT_PAD, buckets: weeks, unit: "week", top: sizeMax, step, yTitle: "Add-ons in the queue", label: "Size of the queue at the end of every week", pixels });
  f.svg.append(el("path", { d: `M ${weeks.map((w) => `${f.x(w.start.getTime()).toFixed(1)} ${f.y(w.size).toFixed(1)}`).join(" L ")}`, class: "line size" }));
  hoverColumns(f, weeks, (w) => `week from ${day(w.start)}: ${w.size} in the queue at the end of the week`);
  container.append(f.svg);
}

/** What came into a queue and what left it per week: bars up for the submissions, bars down for the first decisions (rejected next to the zero line, approved below it). Same inputs as sizeGraph. */
export function flowBarsGraph(container, weeks, { width = 324, scale, pixels = false } = {}) {
  container.replaceChildren();
  if (weeks.length === 0) {
    container.textContent = "No data yet";
    return;
  }
  const { step, half, k } = scale;
  const f = frame({ width, height: 2 * half * k + PLOT_PAD, buckets: weeks, unit: "week", top: 2 * half, step, yTitle: "Submitted up, decided down", label: "Submissions and decisions of the queue per week", pixels, levelLabel: (v) => String(Math.round(Math.abs(v - half) * 1e6) / 1e6) });
  const { svg, x, y } = f;
  svg.append(el("line", { x1: PAD.left, x2: PAD.left + f.plotW, y1: y(half), y2: y(half), class: "axis-line" })); // the zero line
  const slot = weeks.length === 1 ? f.plotW : f.plotW / (weeks.length - 1);
  const bar = Math.max(1.5, Math.min(10, slot * 0.35));
  const rect = (cx, a, b, cls) => el("rect", { x: cx - bar, y: y(half + Math.max(a, b)), width: bar * 2, height: Math.abs(a - b) * k, class: cls });
  const group = el("g", { "clip-path": `url(#${f.clip})` });
  for (const w of weeks) {
    const cx = x(w.start.getTime());
    group.append(rect(cx, 0, w.arrived, "flow-in"));
    group.append(rect(cx, 0, -w.rejected, "flow-rejected"));
    group.append(rect(cx, -w.rejected, -w.rejected - w.approved, "flow-approved"));
  }
  svg.append(group);
  hoverColumns(f, weeks, (w) => `week from ${day(w.start)}: ${w.arrived} submitted, ${w.approved} approved, ${w.rejected} rejected`);
  container.append(svg);
}

/** The lines of the axis of the review time graph: one every this many days. */
export const REVIEW_TIME_STEP = 10;

/** The highest value of reviewTimeGraph: the largest mean or median. Two graphs that are compared get the larger of both. */
export const reviewTimeExtent = (weeks) => ({ highest: Math.max(1, ...weeks.flatMap((w) => [w.median ?? 0, w.mean ?? 0])) });

/**
 * How long the add-ons of each week have waited: the median (a solid line) and the mean (a dashed line) in days. weeks: [{ start, n, reviewed, waiting, median, mean }] from weeklyReviewTime, a week
 * without any add-on in the queue has no point and the line breaks there. extent: { highest }, for graphs that must have the same axis.
 */
export function reviewTimeGraph(container, weeks, { width = 324, height = 240, pixels = false, extent = reviewTimeExtent(weeks) } = {}) {
  container.replaceChildren();
  if (weeks.length === 0) {
    container.textContent = "No data yet";
    return;
  }
  const step = REVIEW_TIME_STEP;
  const top = Math.ceil(extent.highest / step) * step;
  const f = frame({ width, height, buckets: weeks, unit: "week", top, step, yTitle: "Days waited", label: "Median and mean time waited per week", pixels });
  for (const [key, cls] of [["mean", "mean-time"], ["median", "median-time"]]) {
    let run = [];
    const runs = [];
    for (const w of weeks) {
      if (w[key] === null) {
        runs.push(run);
        run = [];
      } else {
        run.push(`${f.x(w.start.getTime()).toFixed(1)} ${f.y(w[key]).toFixed(1)}`);
      }
    }
    runs.push(run);
    for (const points of runs.filter((r) => r.length)) {
      f.svg.append(points.length === 1
        ? el("circle", { cx: points[0].split(" ")[0], cy: points[0].split(" ")[1], r: 2, class: `dot-${cls}` })
        : el("path", { d: `M ${points.join(" L ")}`, class: `line ${cls}` }));
    }
  }
  hoverColumns(f, weeks, (w) => (w.n
    ? `week from ${day(w.start)}: median ${round2(w.median)} days, mean ${round2(w.mean)} days, ${w.n} add-ons (${w.reviewed} reviewed, ${w.waiting} still waiting)`
    : `week from ${day(w.start)}: nothing in the queue`));
  container.append(f.svg);
}

// The colour and the opacity of a column of the 3D pictures both say how many add-ons it holds: from green and OPACITY_LOW for the rarest to red and OPACITY_HIGH for the most. Change them to play with it.
export const OPACITY_LOW = 0.3;
export const OPACITY_HIGH = 1;
const HEAT_STEEPNESS = 4; // the curve of the heat is the inverse of a logarithm: a single add-on stays faint and the heat rises fast where many are. 0 would be a straight line, 6 hides the rare cells even more
/** The heat from 0 to 1 of a cell with n add-ons, the busiest cell has max. It is (e^(k x) - 1) / (e^k - 1) with x = n / max and k = HEAT_STEEPNESS. */
export const heatStrength = (n, max) => {
  const x = Math.min(1, Math.max(0, n / max));
  return HEAT_STEEPNESS === 0 ? x : Math.expm1(HEAT_STEEPNESS * x) / Math.expm1(HEAT_STEEPNESS);
};
export const heatOpacity = (t) => OPACITY_LOW + (OPACITY_HIGH - OPACITY_LOW) * t;

/** The colour for a position t from 0 (green) to 1 (red). */
export const heatHue = (t) => Math.round(120 * (1 - t)); // from green (0) to red (1)
