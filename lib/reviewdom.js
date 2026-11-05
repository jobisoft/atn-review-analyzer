/*
 * The display copy of a stored entry (one version of a review page): a balanced table that is safe to put into a page,
 * with red boxes around the dates that give the submission. Nothing here is stored.
 *
 * The submission is the day of the header, and the time of the earliest row without a label (by the developer) on that
 * day that is not later than the event. Without such a row only the header day is known, and only the header date is boxed.
 */
import "./parser.js";
import "./reviewpage.js";

const RP = () => globalThis.ReviewPage;

const CLASS_PREFIX = "rv-"; // on every class of the copy, so the classes of the site can not collide with the ones of the page
const RED = "red-box";

function defaultEnv() {
  return { doc: document, parse: (html) => new DOMParser().parseFromString(html, "text/html") };
}

/** Wraps the first occurrence of a date text below root in a span with the given class. */
function box(root, dateText, className) {
  const words = dateText.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(words.join("\\s+"));
  const walker = root.ownerDocument.createTreeWalker(root, 4); // text nodes
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const m = pattern.exec(node.textContent);
    if (m) {
      node.splitText(m.index + m[0].length);
      const hit = node.splitText(m.index);
      const span = root.ownerDocument.createElement("span");
      span.className = className;
      hit.replaceWith(span);
      span.append(hit);
      return;
    }
  }
}

/**
 * The copy of the entry for an event ({ date }). Returns { block, version, state } or null if the HTML is not an entry.
 * env: { doc, parse }, the document that builds the copy and the HTML parser, the page and its DOMParser by default.
 */
export function renderEntry(html, event, env = defaultEnv()) {
  const entry = RP().readEntry(html, env.parse);
  if (!entry || !entry.bodyRow) {
    return null;
  }
  const submission = RP().submissionOf(entry, event.date);
  if (submission) {
    box(entry.headerRow.querySelector("th"), entry.headerDateText, RED);
    if (submission.precision === "time") {
      const row = entry.typeless.find((a) => a.when === submission.time);
      box(row.div, row.whenText, RED);
    }
  }
  const block = env.doc.createElement("table");
  block.className = `${CLASS_PREFIX}block`;
  const tbody = env.doc.createElement("tbody");
  for (const row of [entry.headerRow, entry.bodyRow]) {
    tbody.append(RP().copyElement(row, env.doc, CLASS_PREFIX));
  }
  block.append(tbody);
  return { block, version: entry.version, state: entry.state };
}
