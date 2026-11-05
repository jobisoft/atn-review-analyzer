/*
 * The analysis page. It only shows what is stored: it never fetches anything and never fills a cell itself.
 * The review entry of an event is looked up in the database when its details are opened.
 */
import { getAllEvents, getEntriesOf, getReviewEntry } from "../lib/db.js";
import { renderEntry } from "../lib/reviewdom.js";
import { bucketEvents, categoryOf, flowBarsGraph, flowExtent, flowScale, mergeExtents, reviewTimeExtent, reviewTimeGraph, sizeGraph, timeline } from "../lib/chart.js";
import { anonymousFile } from "../lib/anon.js";
import { AGE_WEEK_COLORS, ageWeekCss, surfaceGraph } from "../lib/surface.js";
import { parseImport } from "../lib/transfer.js";
import { AGE_WEEK_EDGES, queueItems, weeklyFlow, weeklyOldestAge, weeklyReviewTime } from "../lib/queue.js";
import { WAITING_EVENT } from "../lib/facts.js";
import { DEFAULT_START, downloadText, formatTime, today } from "../lib/util.js";

const $ = (id) => document.getElementById(id);
const ANON = new URLSearchParams(location.search).has("anon"); // the page of the anonymous data: everything is made from the anonymous data set only
const shortId = (id) => (ANON && /^[0-9a-f]{8}-/.test(id) ? String(id).slice(0, 8) : id); // a fake reviewer UUID is shown by its first 8 characters

const CSV_COLUMNS = ["id", "date", "dateRaw", "event", "reviewer", "addonName", "addonVersion", "addonSlug", "siteAddonId", "tSubmission", "tWait", "queue", "type", "comment"];

let all = [];
let filtered = [];
let grouped = []; // the events of the two tables: the range and the filter of the tables
let listed = []; // the events of the records table: the range, the filter of the records and its text
let activityBase = []; // the events of Review Queue Activity: the type choice of its filter
let submitted = []; // the events that match the filters with the range applied to the submission time, for the graphs of the submissions
let sortKey = "date";
let sortDir = -1;

function cell(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) {
    node.className = className;
  }
  return node;
}

/** The name of an event on the page. The stored event of a version in the queue stays "Awaiting Review" (it is part of the identity of the row), the page says Pending. */
const eventLabel = (event) => (event === WAITING_EVENT ? "Pending" : event);

function fillSelect(select, values, label = shortId) {
  const keep = select.value;
  select.replaceChildren(new Option("All", ""));
  for (const v of values) {
    select.append(new Option(label(v), v));
  }
  select.value = values.includes(keep) ? keep : "";
}

/** The Text filter of the records: words that must all be found, in the add-on name and the comment. A first "n:" limits it to the name, a first "c:" to the comment. */
function textMatcher(value) {
  const raw = value.toLowerCase().trim();
  const prefix = /^[nc]:/.test(raw) ? raw[0] : "";
  const terms = (prefix ? raw.slice(2) : raw).split(/\s+/).filter(Boolean);
  return (e) => terms.every((t) => (prefix !== "c" && (e.addonName || "").toLowerCase().includes(t)) || (prefix !== "n" && (e.comment || "").toLowerCase().includes(t)));
}

/**
 * The events that match the filters. The range applies everywhere. Review Activity, the tables and the records also take the reviewer, the queue and the
 * events of the filter of Review Activity, Submission Activity the ones of its own filter (the same choices, separate boxes). The queue takes nothing else.
 */
function applyFilter(sections = ALL_SECTIONS) {
  const f = { start: $("f-start").value, end: $("f-end").value };
  const choice = (prefix) => ({ reviewer: $(`${prefix}-reviewer`).value, event: $(`${prefix}-event`).value, queue: $(`${prefix}-queue`).value, type: $(`${prefix}-type`).value });
  const inRange = (time) => {
    const day = time ? time.slice(0, 10) : "";
    return (!f.start || (day && day >= f.start)) && (!f.end || (day && day <= f.end));
  };
  const matcher = (c) => (e) => (!c.reviewer || e.reviewer === c.reviewer) && (!c.event || e.event === c.event) && (!c.queue || (e.queue || "unknown") === c.queue) && (!c.type || typeOf(e) === c.type);
  const reviewMatch = matcher(choice("f"));
  const submissionMatch = matcher(choice("s"));
  // a waiting row has no date of the review, it counts on the day it was submitted
  // the queue needs every submission: who reviewed it, what happened to it and its queue do not select it (the graphs split by queue), only the type choice of its own filter does
  const activityType = $("a-type").value;
  activityBase = all.filter((e) => !activityType || typeOf(e) === activityType);
  filtered = all.filter((e) => reviewMatch(e) && inRange(e.date || (e.event === WAITING_EVENT ? e.tSubmission : null)));
  submitted = all.filter((e) => submissionMatch(e) && inRange(e.tSubmission)); // the same range, on the day of the submission
  // the records have a choice for every field of the table: reviewer, event, queue, type and the text (name and comment)
  const text = textMatcher($("c-text").value);
  const recordMatch = matcher(choice("c"));
  const groupMatch = matcher(choice("g"));
  const reviewed = (e) => inRange(e.date || (e.event === WAITING_EVENT ? e.tSubmission : null));
  listed = all.filter((e) => recordMatch(e) && reviewed(e) && text(e));
  grouped = all.filter((e) => groupMatch(e) && reviewed(e));
  render(sections);
}

const percent = (a, b) => (b ? `${Math.round((a / b) * 100)} %` : "-");

/** The column of the tables an event counts in: approved, rejected, pending (a version that waits in the queue) or other. */
const tally = (e) => {
  const category = categoryOf(e.event);
  return category === "waiting" ? "pending" : category;
};

function renderTable(table, headers, rows) {
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headers.forEach((h, i) => headRow.append(cell("th", h, i > 0 ? "num" : "")));
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    row.forEach((v, i) => tr.append(cell("td", String(v), i > 0 ? "num" : "")));
    tbody.append(tr);
  }
  table.replaceChildren(thead, tbody);
}

/** The choice of the type filters for an event: its type, "unknown" if it has none (its files were not found yet). */
function typeOf(e) {
  return e.type || "unknown";
}

function renderGroups() {
  const byReviewer = new Map();
  const byEvent = new Map();
  const count = (map, key, e) => {
    const c = map.get(key) || { total: 0, approved: 0, rejected: 0, pending: 0, other: 0 };
    c.total++;
    c[tally(e)]++;
    map.set(key, c);
  };
  for (const e of grouped) {
    count(byReviewer, e.reviewer, e);
    count(byEvent, e.event, e);
  }
  const reviewerRows = [...byReviewer.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, r]) => [shortId(name), r.total, r.approved, r.rejected, r.pending, r.other, percent(r.approved, r.approved + r.rejected)]);
  renderTable($("reviewers"), ["Reviewer", "Total", "Approved", "Rejected", "Pending", "Other", "Approval rate"], reviewerRows);

  const eventRows = [...byEvent.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, c]) => [name ? eventLabel(name) : "(none)", c.total, percent(c.total, grouped.length)]);
  renderTable($("eventtypes"), ["Event", "Count", "Share"], eventRows);
}

/** The events of the records table in its order. Events without a value come last, except the waiting ones by date (see below). */
function sortedRecords() {
  const missing = (v) => v === undefined || v === null || v === "";
  // a waiting version has not been reviewed yet, so by the date it is the newest of all, the first when the newest come first
  const valueOf = (e) => (sortKey === "date" && !e.date && e.event === WAITING_EVENT ? "9999-12-31T23:59:59" : e[sortKey]);
  return [...listed].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (missing(av) || missing(bv)) {
      return Number(missing(av)) - Number(missing(bv));
    }
    return av < bv ? -sortDir : av > bv ? sortDir : 0;
  });
}

function maxRows() {
  const v = $("rec-max").value;
  return v === "all" ? Infinity : Number(v);
}

/** What the cell of an event shows when its entry is not there. */
async function missingEntryMessage(e) {
  const version = e.addonVersion || "(none)";
  const entries = e.addonSlug ? await getEntriesOf(e.addonSlug) : [];
  if (entries.length === 0) {
    return "No review page is stored for this add-on.";
  }
  return entries.some((x) => x.oldest)
    ? `Version ${version} is not on the review page of this add-on.`
    : `Version ${version} is not stored: only the newest versions of this add-on are stored, the older ones are on later pages of its history.`;
}

/** The review entry of an event, looked up by add-on slug and version when the details are opened. */
async function showEntry(details) {
  if (details.dataset.done) {
    return;
  }
  details.dataset.done = "1";
  const e = details.__event;
  const body = document.createElement("div");
  body.className = "ui-entry";
  details.append(body);
  try {
    const entry = e.addonSlug ? await getReviewEntry(e.addonSlug, e.addonVersion) : null;
    const shown = entry ? renderEntry(entry.html, e) : null;
    body.append(shown ? shown.block : cell("div", entry ? "The stored entry can not be read." : await missingEntryMessage(e), "muted"));
  } catch (err) {
    body.append(cell("div", `Could not read the review entry: ${err.message || err}`, "muted"));
  }
}

/** The type of the add-on, empty if it has none (neither manifest.json nor install.rdf was found, the next scan asks again). */
function typeCell(e) {
  const td = cell("td", e.type || "");
  if (!e.type) {
    td.title = "not known, the files of the version were not found";
  }
  return td;
}

function recordRow(e) {
  const tr = document.createElement("tr");
  const comment = cell("div", e.comment, "comment-text collapsed");
  comment.title = "Click to expand";
  const details = document.createElement("details");
  details.__event = e;
  details.append(cell("summary", "Show"));
  const cells = [
    cell("td", formatTime(e.date) || e.dateRaw, "date nowrap"),
    cell("td", eventLabel(e.event), `event-${categoryOf(e.event)}`),
    cell("td", shortId(e.reviewer)),
    cell("td", e.addonVersion ? `${e.addonName} ${shortId(e.addonVersion)}` : e.addonName),
    cell("td", formatTime(e.tSubmission), "date nowrap"),
    cell("td", typeof e.tWait === "number" ? String(e.tWait) : "", "num"),
    cell("td", e.queue || "unknown"),
    typeCell(e),
    cell("td", ""),
    cell("td", "", "ui-entry-cell")
  ];
  cells[8].append(comment);
  cells[9].append(details);
  cells[8].classList.add("not-anon");
  cells[9].classList.add("not-anon");
  tr.append(...cells);
  return tr;
}

function renderRecords() {
  const shown = sortedRecords().slice(0, maxRows());
  $("records").tBodies[0].replaceChildren(...shown.map(recordRow));
  $("shown").textContent = `(${shown.length} of ${listed.length})`;
}

const TIMELINE_HEIGHT = 240;
const SURFACE_HEIGHT = 460; // the pictures of the queue age are as wide as the page
const AGE_WEEK_STRETCH = 1.5; // a week of age is this many times as wide as a week of the time axis (36 rows of age against about 90 weeks of time)
const FLOW_PLOT = 420; // pixels of the plots of the size graph and the bars graph together: the same scale for add-ons in both, so every count can be seen


/** The size and range of a graph in its box: as wide as the box, on the days of the range of the filter bar (no end: until today), always in weeks. */
const chartOptions = (id) => ({ width: Math.max(320, $(id).clientWidth), range: { start: $("f-start").value, end: $("f-end").value || today() }, unit: "week" });

/** Review Activity: the events by the date of the review, one graph. */
function renderReview() {
  timeline($("timeline"), filtered, { ...chartOptions("timeline"), height: TIMELINE_HEIGHT }); // the same graph as in the popup
}

/** Submission Activity: the events by the date of the submission, one graph. */
function renderSubmission() {
  const options = (id) => ({ ...chartOptions(id), key: "tSubmission", height: TIMELINE_HEIGHT, totalLabel: "submitted" });
  timeline($("submissions"), submitted, options("submissions"));
}

const round1 = (n) => Math.round(n * 10) / 10;

/** The key of the picture with the age in weeks: the colour of a column is its age in weeks, its height and opacity are the number of add-ons. */
function renderWeekLegend(box, busiest) {
  const item = (text, color) => {
    const span = document.createElement("span");
    span.className = "swatch";
    if (color) {
      span.style.setProperty("--swatch", color);
    }
    span.textContent = text;
    return span;
  };
  const names = ["less than 1 week", "less than 2 weeks", "less than 3 weeks", "less than 4 weeks", "4 weeks and older"];
  const second = item(`Height and opacity: add-ons. The most: ${round1(busiest.new)} in the new queue, ${round1(busiest.update)} in the update queue (the opacity of each picture is relative to its own)`);
  second.classList.add("next-line"); // below the colours
  box.replaceChildren(item("Colour: age"), ...AGE_WEEK_COLORS.map((_, i) => item(names[i], ageWeekCss(i))), second);
}

/** The Mondays of the weeks from the first to the last day. */
const bucketWeeks = (range) => bucketEvents([], range, "date", "week").buckets.map((b) => b.start);

/**
 * Review Queue Activity, three rows, the new queue left and the update queue right: the size of the queue, what came and went, and how long the reviews took. The two graphs of a row have the same axes
 * (the extent of both), and the first two rows the same number of pixels for one add-on.
 */
function renderActivity() {
  const end = $("f-end").value || today();
  const now = Date.now();
  const flows = {};
  const times = {};
  for (const queue of ["new", "update"]) {
    const items = queueItems(activityBase, queue);
    const first = Math.min(Infinity, ...items.map((i) => i.start));
    const startDay = $("f-start").value || (Number.isFinite(first) ? new Date(first).toISOString().slice(0, 10) : "");
    const weeks = startDay ? bucketWeeks({ start: startDay, end }) : [];
    flows[queue] = weeklyFlow(items, weeks, now);
    times[queue] = weeklyReviewTime(items, weeks, now);
  }
  const extent = mergeExtents(["new", "update"].map((queue) => (flows[queue].length ? flowExtent(flows[queue]) : { biggest: 1, sizeTop: 1 })));
  const scale = flowScale(extent, FLOW_PLOT);
  const timeExtent = mergeExtents(["new", "update"].map((queue) => (times[queue].length ? reviewTimeExtent(times[queue]) : { highest: 1 })));
  for (const queue of ["new", "update"]) {
    sizeGraph($(`size-${queue}`), flows[queue], { width: chartOptions(`size-${queue}`).width, scale });
    flowBarsGraph($(`bars-${queue}`), flows[queue], { width: chartOptions(`bars-${queue}`).width, scale });
    reviewTimeGraph($(`time-${queue}`), times[queue], { width: chartOptions(`time-${queue}`).width, height: TIMELINE_HEIGHT, extent: timeExtent });
  }
}

/** The 3D picture of the ages of the queue, in weeks, for the new queue and the update queue. */
function renderAge() {
  const [newAge, updateAge] = [chartOptions("ageweeks-new"), chartOptions("ageweeks-update")];
  const items = { new: queueItems(activityBase, "new"), update: queueItems(activityBase, "update") };
  const first = Math.min(Infinity, ...Object.values(items).flat().map((i) => i.start));
  const startDay = $("f-start").value || (Number.isFinite(first) ? new Date(first).toISOString().slice(0, 10) : "");
  const end = $("f-end").value || today();
  const weeks = startDay ? bucketWeeks({ start: startDay, end }) : [];
  const now = Date.now();
  const inWeeks = { new: weeklyOldestAge(items.new, weeks, now), update: weeklyOldestAge(items.update, weeks, now) };
  const ownWeeks = (queue) => Math.max(1, ...inWeeks[queue].flatMap((w) => w.counts)); // the busiest cell of one queue: the opacity is relative to it
  const busiestWeeks = Math.max(ownWeeks("new"), ownWeeks("update")); // the height has the same scale for both
  // the labels sit on the edges between the rows (1w between green and yellow: green is less than one week), a line for every week of age
  const weekRows = { atEdges: true, label: (k) => `${k}w`, describe: (age) => `less than ${age + 1} ${age === 0 ? "week" : "weeks"} old`, show: (k) => k >= 1 && (k <= 4 || k % 4 === 0), gridEvery: 1 };
  renderWeekLegend($("ageweeks-legend"), { new: ownWeeks("new"), update: ownWeeks("update") });
  const picture = (queue, container, options) => surfaceGraph($(container), inWeeks[queue], {
    ...options, width: Math.max(320, $(container).clientWidth), edges: AGE_WEEK_EDGES, rows: weekRows, colorBy: "age-weeks", stretchV: AGE_WEEK_STRETCH,
    max: busiestWeeks, opacityMax: ownWeeks(queue), blockSize: 1, height: SURFACE_HEIGHT
  });
  picture("new", "ageweeks-new", newAge);
  picture("update", "ageweeks-update", updateAge);
}

/** How much of what is stored the range and the other filters leave. */
function renderSpan() {
  if (all.length === 0) {
    return;
  }
  // waiting rows have no date of the review, so there may be no first and last day (and the graphs must still be drawn)
  const dates = filtered.map((e) => e.date).filter(Boolean).sort();
  const shown = `${filtered.length.toLocaleString()} of ${all.length.toLocaleString()} stored events shown`;
  $("span").textContent = filtered.length
    ? `${shown}${dates.length ? `, ${dates[0].slice(0, 10)} to ${dates[dates.length - 1].slice(0, 10)}` : ""}`
    : `None of the ${all.length.toLocaleString()} stored events is in the range or matches the filters.`;
}

/** The sections that can be drawn on their own, so that a change in the filter of one of them does not draw the others again. */
const SECTION_PARTS = {
  review: [renderSpan, renderReview],
  submission: [renderSubmission],
  activity: [renderActivity, renderAge], // the age is a part of Review Queue Activity and has its filter
  groups: [renderGroups],
  records: [renderRecords]
};
const ALL_SECTIONS = Object.keys(SECTION_PARTS);
const renderGraphs = () => render(["review", "submission", "activity"]);

function render(sections = ALL_SECTIONS) {
  // each part on its own, so that one that fails does not leave the others with the old picture
  for (const part of sections.flatMap((section) => SECTION_PARTS[section])) {
    try {
      part();
    } catch (e) {
      console.error(`analysis: ${part.name} failed`, e);
      $("span").textContent = `${part.name} failed: ${e.message || e}`;
    }
  }
}

/** CSV cell. Leading = + - @ are neutralised because the comments come from a web page. */
function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return `"${s.replace(/"/g, '""')}"`;
}

function exportCsv() {
  const lines = [CSV_COLUMNS.map(csvCell).join(",")];
  for (const e of sortedRecords()) {
    lines.push(CSV_COLUMNS.map((c) => csvCell(e[c])).join(","));
  }
  downloadText(`reviewlog-${today()}.csv`, "text/csv", lines.join("\r\n"));
}

function bindEvents() {
  // the bar at the top changes everything, the filter of a section only that section
  const formSections = { filters: ALL_SECTIONS, "f-review": ["review"], "f-submission": ["submission"], "f-activity": ["activity"], "f-groups": ["groups"], "f-records": ["records"] };
  for (const [id, sections] of Object.entries(formSections)) {
    $(id).addEventListener("input", () => applyFilter(sections));
    $(id).addEventListener("submit", (e) => e.preventDefault());
    $(id).addEventListener("reset", () => setTimeout(() => applyFilter(sections), 0));
  }
  $("rec-max").addEventListener("change", renderRecords);
  // "toggle" does not bubble, so it is caught on the way down
  $("records").tBodies[0].addEventListener("toggle", (ev) => {
    ev.target.querySelector("summary").textContent = ev.target.open ? "Hide" : "Show"; // the label stays Show/Hide
    if (ev.target.open) {
      showEntry(ev.target); // the entry is read from the database now, not when the table is drawn
    }
  }, true);
  $("records").tBodies[0].addEventListener("click", (e) => {
    if (e.target.classList.contains("comment-text")) {
      e.target.classList.toggle("collapsed");
    }
  });
  $("records").tHead.addEventListener("click", (e) => {
    const key = e.target.dataset && e.target.dataset.sort;
    if (key) {
      sortDir = key === sortKey ? -sortDir : 1;
      sortKey = key;
      renderRecords();
    }
  });
  $("export-json").addEventListener("click", () => {
    downloadText(`reviewlog-${today()}.json`, "application/json", JSON.stringify(sortedRecords(), null, 2));
  });
  $("export-csv").addEventListener("click", exportCsv);
  let resizing = null;
  window.addEventListener("resize", () => { // the text of the graph keeps its size, so it is drawn again at the new width
    clearTimeout(resizing);
    resizing = setTimeout(renderGraphs, 150);
  });
}

/** A waiting row is not shown for a version that has another entry in the log. An interrupted scan may have left both. */
function withoutDecidedWaiting(events) {
  const key = (e) => `${e.addonSlug}\u001f${e.addonVersion}`;
  const known = new Set(events.filter((e) => e.event !== WAITING_EVENT).map(key));
  return events.filter((e) => e.event !== WAITING_EVENT || !known.has(key(e)));
}

async function init() {
  try {
    all = withoutDecidedWaiting(await getAllEvents());
    if (ANON) { // the same page, fed by the anonymous file as another profile reads it and nothing else
      document.body.classList.add("anon");
      document.title = "Review Log Analysis, anonymous data";
      all = parseImport(await anonymousFile(all)).events;
    }
  } catch (e) {
    $("span").textContent = `Could not read the stored data: ${e.message || e}`;
    return;
  }
  $("span").textContent = all.length ? "" : "No events stored yet. Open the review log page and press Scan in the toolbar popup.";
  // the range starts as in the popup, Reset brings it back
  const saved = await browser.storage.local.get(["start", "end"]);
  for (const [id, value] of [["f-start", saved.start || DEFAULT_START], ["f-end", saved.end || ""]]) {
    $(id).value = value;
    $(id).defaultValue = value;
  }
  const reviewers = [...new Set(all.map((e) => e.reviewer))].sort();
  const eventNames = [...new Set(all.map((e) => e.event).filter(Boolean))].sort();
  for (const prefix of ["f", "s", "c", "g"]) { // the filters of Review Activity, Submission Activity, the records and the tables
    fillSelect($(`${prefix}-reviewer`), reviewers);
    fillSelect($(`${prefix}-event`), eventNames, eventLabel);
  }
  bindEvents();
  applyFilter();
}

init();
