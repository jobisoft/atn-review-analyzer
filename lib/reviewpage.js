/*
 * Reads the review page of an add-on (https://.../reviewers/review/<slug>).
 *
 * The page lists the versions, newest first, ten per page. A version is a header row ("Version 1.0.0 · July 27, 2026 ·
 * Approved") and a body row that follows it (files, notes and an activity table). An activity row has a label (Approved,
 * Rejected, Reviewer Reply, ...) and "By <name> on <date, time>". Rows without a label are by the developer.
 *
 * An entry is one version: the header row and the body row, kept as the HTML of a small table
 *   <table id="review-files"><tbody> header row, body row </tbody></table>
 * exactly as the site sent it. Nothing is removed when it is stored. The copy that the analysis page shows is made safe
 * by copyElement (scripts, handlers, images and links removed), and the stored HTML is only ever parsed, never inserted.
 *
 * Plain script (global ReviewPage), like parser.js: the content script, the extension pages, the background page
 * (side-effect import) and the tests all load the same file.
 */
(function (root) {
  const parseDate = (text) => {
    const parser = typeof module === "object" && module.exports ? require("./parser.js") : root.ReviewLogParser;
    return parser.parseDate(text);
  };

  const HEADER = /^Version\s+(.+?)\s+·\s+(.+?)(?:\s+·\s+(.*))?$/;
  const ACTIVITY_BY = /^By\s+(.*?)\s+on\s+(.+)$/;

  // markup that is kept in the safe copy that is shown. Everything else is flattened to its text or dropped.
  const ALLOWED = new Set(["TABLE", "TBODY", "THEAD", "TR", "TH", "TD", "DIV", "SPAN", "UL", "OL", "LI", "STRONG", "B", "EM", "I", "BR", "PRE", "CODE", "P", "H3", "H4", "SMALL"]);
  const DROPPED = new Set(["SCRIPT", "STYLE", "IMG", "IFRAME", "OBJECT", "EMBED", "FORM", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "SVG", "LINK", "META", "NOSCRIPT", "VIDEO", "AUDIO", "CANVAS", "TEMPLATE"]);

  const clean = (text) => text.replace(/\s+/g, " ").trim();

  const parseHtml = (html) => new DOMParser().parseFromString(html, "text/html");

  /**
   * Appends a safe copy of the content of node to out. Links become spans, only class, colspan and rowspan are kept.
   * classPrefix is put before every class name, so the classes of the site can not collide with the ones of the page that shows the copy.
   */
  function copyContent(node, out, doc, classPrefix) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out.append(doc.createTextNode(child.textContent));
      } else if (child.nodeType === 1) {
        const tag = child.tagName.toUpperCase();
        if (DROPPED.has(tag)) {
          continue;
        }
        if (tag === "A") {
          const span = doc.createElement("span");
          span.className = `${classPrefix}link`;
          copyContent(child, span, doc, classPrefix);
          out.append(span);
        } else if (ALLOWED.has(tag)) {
          out.append(copyElement(child, doc, classPrefix));
        } else {
          copyContent(child, out, doc, classPrefix);
        }
      }
    }
  }

  function copyElement(el, doc, classPrefix) {
    const copy = doc.createElement(el.tagName.toLowerCase());
    const classes = (el.getAttribute("class") || "").split(/\s+/).filter((c) => /^[A-Za-z0-9_-]+$/.test(c));
    if (classes.length) {
      copy.className = classes.map((c) => `${classPrefix}${c}`).join(" ");
    }
    for (const attr of ["colspan", "rowspan"]) {
      const value = el.getAttribute(attr);
      if (value && /^\d{1,2}$/.test(value)) {
        copy.setAttribute(attr, value);
      }
    }
    copyContent(el, copy, doc, classPrefix);
    return copy;
  }

  /**
   * The versions of a table#review-files. Each one: { version, headerDateText, state, headerDay, headerRow, bodyRow,
   * activities: [{ label, by, whenText, when, row, div }], typeless }. `when` is "YYYY-MM-DDTHH:MM:00" or null,
   * `typeless` are the dated activities without a label (by the developer), oldest first. Rows with the notes have no date and are skipped.
   */
  function readVersions(table) {
    const versions = [];
    let current = null;
    for (const tr of table ? table.rows : []) { // the rows of this table only, not of the tables inside
      if (tr.classList.contains("listing-header")) {
        const th = tr.querySelector("th");
        const m = HEADER.exec(clean(th ? th.textContent : ""));
        current = {
          version: m ? m[1] : clean(th ? th.textContent : ""),
          headerDateText: m ? m[2] : "",
          state: m && m[3] ? m[3] : "",
          headerDay: m ? (parseDate(m[2]) || "").slice(0, 10) : "",
          headerRow: tr, bodyRow: null, activities: [], typeless: []
        };
        versions.push(current);
      } else if (tr.classList.contains("listing-body") && current && !current.bodyRow) {
        current.bodyRow = tr;
        const activity = tr.querySelector("table.activity");
        for (const row of activity ? activity.rows : []) {
          const td = row.querySelector(":scope > td");
          const th = row.querySelector(":scope > th");
          if (!td || !th || td.querySelector(".history-notes") || td.classList.contains("activity_approval")) {
            continue;
          }
          const div = td.querySelector(":scope > div");
          const m = div ? ACTIVITY_BY.exec(clean(div.textContent)) : null;
          current.activities.push({
            label: clean(th.textContent), by: m ? m[1] : "", whenText: m ? m[2] : "", when: m ? parseDate(m[2]) : null, row, div
          });
        }
        current.typeless = current.activities
          .filter((a) => a.label === "" && a.when)
          .sort((a, b) => (a.when < b.when ? -1 : 1));
      }
    }
    return versions;
  }

  /** Cuts a review page into entries. Returns { entries: [{ version, headerDateText, state, html }], more }. */
  function sliceReviewPage(html, parse = parseHtml) {
    const doc = parse(html);
    const entries = [];
    const seen = new Set();
    for (const v of readVersions(doc.querySelector("table#review-files"))) {
      if (!v.bodyRow || seen.has(v.version)) {
        continue;
      }
      seen.add(v.version);
      const table = doc.createElement("table");
      table.id = "review-files";
      const tbody = doc.createElement("tbody");
      tbody.append(v.headerRow.cloneNode(true), v.bodyRow.cloneNode(true)); // as fetched, it is made safe when it is shown
      table.append(tbody);
      entries.push({ version: v.version, headerDateText: v.headerDateText, state: v.state, html: table.outerHTML });
    }
    // a link to older versions. The last page has a link to newer ones, which does not count.
    const paging = doc.querySelector("#review-files-paginate");
    const more = !!paging && [...paging.querySelectorAll("a")].some((a) => /\bolder\b/i.test(a.textContent));
    return { entries, more };
  }

  /** The version of one stored entry (see readVersions), or null. */
  function readEntry(html, parse = parseHtml) {
    return readVersions(parse(html).querySelector("table#review-files"))[0] || null;
  }

  /**
   * The submission of a version for an event at eventTime: the day of the header, and the time of the earliest row
   * without a label on that day that is not later than the event (without an event time, as for a waiting version, the earliest one). If there is none, 00:00 of that day.
   * Returns { time, precision: "time" | "day" } or null if the header has no date.
   */
  function submissionOf(entry, eventTime) {
    if (!entry.headerDay) {
      return null;
    }
    const row = entry.typeless.find((a) => a.when.slice(0, 10) === entry.headerDay && (!eventTime || a.when <= eventTime));
    return row ? { time: row.when, precision: "time" } : { time: `${entry.headerDay}T00:00:00`, precision: "day" };
  }

  /** Does the entry have the row of an event (label and time)? */
  function hasRow(entry, label, eventTime) {
    return entry.activities.some((a) => a.label === label && a.when === eventTime);
  }

  /** Is there an Approved row before the time in any of the entries? */
  function approvedBefore(entries, time) {
    return [...entries].some((e) => e.activities.some((a) => a.label === "Approved" && a.when && a.when < time));
  }

  const api = { sliceReviewPage, readVersions, readEntry, submissionOf, hasRow, approvedBefore, copyElement, copyContent, parseHtml };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.ReviewPage = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
