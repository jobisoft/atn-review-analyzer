/*
 * Parses one page of the add-on review log (table#log-listing) and one page of a review queue (table#addon-queue).
 * Plain script, so the content script and the tests can both load it.
 */
(function (root) {
  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };

  // /reviewers/review/<slug> (listed) and /reviewers/review-unlisted/<slug> (unlisted versions)
  const REVIEW_HREF = /\/reviewers\/review(?:-[a-z]+)?\/[^/]/;

  const UNLISTED_HREF = /\/reviewers\/review-unlisted\//;
  const NO_SLUG = "None"; // the log links to /reviewers/review/None for an add-on that has no slug. There is no page for it.

  const pad = (n) => String(n).padStart(2, "0");

  /**
   * Converts "Nov. 3, 2026, 11:31 p.m." (also "8 p.m.", "noon", "midnight",
   * and a missing time) to "2026-11-03T23:31:00". The page shows no time zone,
   * so the result is the wall time as displayed. Returns null if unparseable.
   */
  function parseDate(raw) {
    const m = /^([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})(?:,\s*(.+))?$/.exec((raw || "").trim());
    if (!m) {
      return null;
    }
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (!month) {
      return null;
    }
    let hour = 0;
    let minute = 0;
    if (m[4]) {
      const t = m[4].trim().toLowerCase().replace(/\./g, "");
      if (t === "noon") {
        hour = 12;
      } else if (t === "midnight") {
        hour = 0;
      } else {
        const tm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(t);
        if (!tm) {
          return null;
        }
        hour = Number(tm[1]) % 12 + (tm[3] === "pm" ? 12 : 0);
        minute = Number(tm[2] || 0);
      }
    }
    return `${m[3]}-${pad(month)}-${pad(Number(m[2]))}T${pad(hour)}:${pad(minute)}:00`;
  }

  const clean = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

  function lastPathSegment(href) {
    try {
      return new URL(href, "https://example.invalid/").pathname.split("/").filter(Boolean).pop() || "";
    } catch (e) {
      return "";
    }
  }

  function absoluteUrl(href, base) {
    try {
      return new URL(href, base).href;
    } catch (e) {
      return "";
    }
  }

  /**
   * Returns { records, warnings, unlisted, noSlug, pageCount, total }. unlisted and noSlug count the rows that were left out.
   * A record is { dateRaw, date, event, reviewer, comment, addonName,
   * addonVersion, addonSlug, siteAddonId, reviewUrl }. No record gets an id here.
   */
  function parseLogPage(doc, baseHref = "https://example.invalid/") {
    const table = doc.querySelector("table#log-listing");
    const records = [];
    const warnings = [];
    let unlisted = 0;
    let noSlug = 0;

    if (table) {
      for (const row of table.querySelectorAll("tbody > tr[data-addonid]")) {
        const cells = row.querySelectorAll(":scope > td");
        const eventCell = cells[1];
        const links = eventCell ? [...eventCell.querySelectorAll("a")] : [];
        const reviewLink = links.find((a) => REVIEW_HREF.test(a.getAttribute("href") || ""));
        // Rows about unlisted versions (/reviewers/review-unlisted/) only point to comments. They are ignored.
        if (reviewLink && UNLISTED_HREF.test(reviewLink.getAttribute("href") || "")) {
          unlisted++;
          continue;
        }
        // An add-on without a slug has no review page of its own, so nothing can be matched. The row is ignored as well.
        if (reviewLink && lastPathSegment(reviewLink.getAttribute("href")) === NO_SLUG) {
          noSlug++;
          continue;
        }
        const nameLink = links.find((a) => a !== reviewLink);
        const versionText = eventCell
          ? [...eventCell.childNodes]
              .filter((n) => n.nodeType === 3)
              .map((n) => n.textContent.trim())
              .filter(Boolean)
              .join(" ")
          : "";

        let commentRow = row.nextElementSibling;
        while (commentRow && !commentRow.classList.contains("comments")) {
          if (commentRow.hasAttribute("data-addonid")) {
            commentRow = null;
          } else {
            commentRow = commentRow.nextElementSibling;
          }
        }
        const commentCell = commentRow ? commentRow.querySelector("td[colspan]") : null;

        const record = {
          dateRaw: clean(cells[0]),
          date: null,
          event: clean(reviewLink),
          reviewer: clean(cells[2]),
          comment: commentCell ? commentCell.textContent.replace(/\r\n?/g, "\n").trim() : "",
          addonName: clean(nameLink),
          addonVersion: versionText,
          addonSlug: reviewLink ? lastPathSegment(reviewLink.getAttribute("href")) : "",
          reviewUrl: reviewLink ? absoluteUrl(reviewLink.getAttribute("href"), baseHref) : "",
          siteAddonId: row.getAttribute("data-addonid") || ""
        };
        record.date = parseDate(record.dateRaw);

        if (!record.date) {
          warnings.push(`unparseable date "${record.dateRaw}"`);
        }
        if (!record.event) {
          warnings.push(`no event in the row of "${record.addonName}"`);
        }
        if (!record.reviewer) {
          warnings.push(`no reviewer in the row of "${record.addonName}"`);
        }
        records.push(record);
      }
    }

    let pageCount = 1;
    for (const a of doc.querySelectorAll("ol.pagination a[href]")) {
      try {
        const n = Number(new URL(a.getAttribute("href"), "https://example.invalid/").searchParams.get("page"));
        if (Number.isInteger(n) && n > pageCount) {
          pageCount = n;
        }
      } catch (e) {
        // ignore malformed links
      }
    }

    let total = null;
    const strongs = doc.querySelectorAll(".num-results strong");
    if (strongs.length >= 3) {
      const n = Number(strongs[2].textContent.replace(/[^\d]/g, ""));
      total = Number.isFinite(n) ? n : null;
    }

    return { hasTable: !!table, records, warnings, unlisted, noSlug, pageCount, total };
  }

  // icons of a queue row that only tell the type of the add-on, they are no flags
  const TYPE_ICONS = /^(WebExtension|Extension|Static Theme|Theme|Dictionary|Language Pack|Search Engine|Legacy Extension)$/i;

  /**
   * Returns { items, total, next, skipped } for a page of /reviewers/queue/new or /reviewers/queue/updates. An item is
   * { siteAddonId, slug, name, version, waiting, flags, reviewUrl }: waiting is the text of the waiting time column ("24 days"),
   * flags are the titles of the icons of the row ("More Information Requested"). total is the number in the selected tab
   * ("New (76)"), next the address of a further page or null. Rows without add-on id, slug or version, and rows of an add-on
   * without a slug, are left out and counted in skipped.
   */
  function parseQueuePage(doc, baseHref = "https://example.invalid/") {
    const items = [];
    let skipped = 0;
    for (const row of doc.querySelectorAll("table#addon-queue tbody > tr.addon-row")) {
      const cells = row.querySelectorAll(":scope > td");
      const link = [...row.querySelectorAll("a[href]")].find((a) => REVIEW_HREF.test(a.getAttribute("href") || ""));
      const em = link && link.querySelector("em");
      const slug = link ? lastPathSegment(link.getAttribute("href")) : "";
      const siteAddonId = row.getAttribute("data-addon") || "";
      const version = clean(em);
      if (!link || !em || !slug || slug === NO_SLUG || !version || !siteAddonId) {
        skipped++;
        continue;
      }
      const name = link.cloneNode(true);
      name.querySelector("em").remove();
      items.push({
        siteAddonId,
        slug,
        name: clean(name),
        version,
        waiting: clean(cells[3]),
        flags: [...row.querySelectorAll("[title]")].map((el) => el.getAttribute("title").trim()).filter((t) => t && !TYPE_ICONS.test(t)),
        reviewUrl: absoluteUrl(link.getAttribute("href"), baseHref)
      });
    }

    let total = null;
    const tab = /\((\d+)\)/.exec(clean(doc.querySelector("ul.tabnav li.selected a")));
    if (tab) {
      total = Number(tab[1]);
    }

    const nextLink = doc.querySelector("a[rel~='next'][href]") || [...doc.querySelectorAll(".pagination a[href]")].find((a) => /^\s*next\b/i.test(a.textContent));
    return { items, total, next: nextLink ? absoluteUrl(nextLink.getAttribute("href"), baseHref) || null : null, skipped };
  }

  /** Builds the URL of one log page from the current page URL. */
  function buildPageUrl(baseHref, start, end, page) {
    const url = new URL(baseHref);
    url.search = "";
    url.hash = "";
    if (start) {
      url.searchParams.set("start", start);
    }
    if (end) {
      url.searchParams.set("end", end);
    }
    url.searchParams.set("page", String(page));
    return url.href;
  }

  const api = { parseDate, parseLogPage, parseQueuePage, buildPageUrl };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.ReviewLogParser = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
