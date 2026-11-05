/*
 * Runs on the review log page. A scan walks the pages of the log, then fetches the review details of the add-ons that
 * need them, with the session of the logged in user. It only fetches: what to store and which page to fetch next is
 * decided by the background page.
 */
(() => {
  if (globalThis.__reviewLogCollector) {
    return;
  }
  globalThis.__reviewLogCollector = true;

  const P = globalThis.ReviewLogParser;
  const PAGE_DELAY_MS = 300;
  const RETRIES = 2;
  const REVIEW_PATH = /\/reviewers\/review(?:-[a-z]+)?\//; // listed and unlisted review pages

  const blankState = () => ({
    phase: "running", // idle, running, done, cancelled, error
    stage: "log", // log, details
    page: 0, pages: 0, siteTotal: null, added: 0, skipped: 0, warnings: 0, unlisted: 0, noSlug: 0,
    detailIndex: 0, detailTotal: 0, detailStored: 0, detailPage: 0, detailFailed: 0, detailNoAccess: 0, detailError: "",
    queueNew: 0, queueUpdates: 0, queueAdded: 0, queueError: "", badRemoved: 0,
    fileIndex: 0, fileTotal: 0, fileFailed: 0, fileError: "", fileTypes: {}, fileUnknown: 0,
    message: ""
  });
  const state = { runId: 0, ...blankState(), phase: "idle" }; // runId counts the scans, so a poller can tell a new result from the last
  let cancelRequested = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (msg) => browser.runtime.sendMessage(msg);

  // every address that is requested, with the HTTP status (0: no answer). The background page keeps them for the request log.
  let requests = [];
  function logRequest(url, status) {
    requests.push({ t: new Date().toISOString(), url: String(url), status });
    if (requests.length >= 200) {
      flushRequests().catch(() => {});
    }
  }
  async function flushRequests() {
    const items = requests;
    requests = [];
    for (let i = 0; i < items.length; i += 500) {
      await send({ cmd: "requestLog", items: items.slice(i, i + 500) });
    }
  }

  /**
   * Fetches a same-origin page as text. check(text, response) may throw to reject the answer.
   * An error has `status` (the HTTP status) and `final` (true if asking again will not help).
   */
  async function fetchText(url, check) {
    let lastError;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      let res = null;
      try {
        try {
          res = await fetch(url, { credentials: "same-origin" });
        } finally {
          logRequest(url, res ? res.status : 0);
        }
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          // a missing or forbidden page will not appear by asking again
          err.final = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
          throw err;
        }
        return check(await res.text(), res);
      } catch (e) {
        e.status = res ? res.status : undefined;
        lastError = e;
        if (e.final) {
          break;
        }
        await sleep(1000 * (attempt + 1));
      }
    }
    throw lastError;
  }

  function fetchLogPage(url) {
    return fetchText(url, (text) => {
      const parsed = P.parseLogPage(new DOMParser().parseFromString(text, "text/html"), url);
      if (!parsed.hasTable) {
        throw new Error("no review log table in the response (logged out?)");
      }
      return parsed;
    });
  }

  /** The URL of page `page` of the history. The URL behind the event link is used if it is usable, else it is built from the slug. */
  function reviewPageUrl(target, page) {
    let url;
    try {
      url = new URL(target.url);
    } catch (e) {
      url = null;
    }
    if (!url || url.origin !== location.origin || !REVIEW_PATH.test(url.pathname)) {
      url = new URL(location.href);
      // the slug comes from a URL path, so it is encoded already. Encoding it again would turn "%E3" into "%25E3" (404)
      url.pathname = url.pathname.replace(/reviewlog\/?$/, `review/${target.slug}`);
    }
    url.search = "";
    url.hash = "";
    if (page > 1) {
      url.searchParams.set("page", String(page));
    }
    return url.href;
  }

  function fetchReviewPage(url) {
    return fetchText(url, (text, res) => {
      const path = new URL(res.url).pathname;
      if (path.includes("/reviewers/queue")) {
        // the site shows no review page to this user (for example for the reviewer's own add-ons)
        throw Object.assign(new Error(`redirected to ${path}`), { final: true, noAccess: true });
      }
      if (!REVIEW_PATH.test(path)) {
        throw Object.assign(new Error(`redirected to ${path}`), { final: true });
      }
      if (!text.trim()) {
        throw new Error("empty response");
      }
      return text;
    });
  }

  /** The address of the first page of a review queue ("new" or "updates"), next to the review log. */
  function queueUrl(name) {
    const url = new URL(location.href);
    url.pathname = url.pathname.replace(/reviewlog\/?$/, `queue/${name}`);
    url.search = "";
    url.hash = "";
    return url.href;
  }

  const MAX_QUEUE_PAGES = 20;

  /**
   * Phase 2: the two review queues (new submissions, updates). Every version that waits is sent to the background page, which
   * makes a row "Awaiting Review" of it. A queue that can not be read is reported, the scan goes on. Returns true if cancelled.
   */
  async function readQueues() {
    state.stage = "queue";
    for (const [queue, name] of [["new", "new"], ["update", "updates"]]) {
      try {
        let url = queueUrl(name);
        for (let page = 0; url && page < MAX_QUEUE_PAGES; page++) {
          if (cancelRequested) {
            return true;
          }
          const parsed = await fetchText(url, (text) => {
            const doc = new DOMParser().parseFromString(text, "text/html");
            if (!doc.querySelector("table#addon-queue")) {
              throw new Error("no queue table in the response (logged out?)");
            }
            return P.parseQueuePage(doc, url);
          });
          const { added } = await send({ cmd: "queueRead", queue, items: parsed.items });
          state.queueAdded += added;
          state[queue === "new" ? "queueNew" : "queueUpdates"] += parsed.items.length;
          url = parsed.next;
          if (url) {
            await sleep(PAGE_DELAY_MS);
          }
        }
      } catch (e) {
        state.queueError = `${name}: ${e.message || e}`;
      }
    }
    return cancelRequested;
  }

  /** Phase 1: all pages of the log in the range. Returns true if it was cancelled. */
  async function scanLog({ start, end }) {
    let page = 1;
    let url = P.buildPageUrl(location.href, start, end, page);
    let parsed = await fetchLogPage(url);
    state.pages = parsed.pageCount;
    state.siteTotal = parsed.total;
    while (parsed.records.length > 0) {
      state.page = page;
      state.warnings += parsed.warnings.length;
      state.unlisted += parsed.unlisted;
      state.noSlug += parsed.noSlug;
      const res = await send({ cmd: "addEvents", records: parsed.records });
      state.added += res.added;
      state.skipped += res.skipped;
      if (page >= state.pages) {
        return false;
      }
      if (cancelRequested) {
        return true;
      }
      await sleep(PAGE_DELAY_MS);
      page++;
      url = P.buildPageUrl(location.href, start, end, page);
      parsed = await fetchLogPage(url);
      state.pages = Math.max(state.pages, parsed.pageCount);
    }
    return false;
  }

  /** The history of one add-on, page by page as long as the background page asks for the next one. */
  async function walkAddon(target) {
    if (!(await send({ cmd: "reviewStart", slug: target.slug })).fetch) {
      return;
    }
    let page = 1;
    while (page && !cancelRequested) {
      state.detailPage = page;
      let html;
      try {
        html = await fetchReviewPage(reviewPageUrl(target, page));
      } catch (e) {
        if (e.noAccess) {
          state.detailNoAccess++;
          await send({ cmd: "reviewGone", slug: target.slug, redirected: true });
        } else if (e.status === 404 && page === 1) {
          await send({ cmd: "reviewGone", slug: target.slug, redirected: false });
        } else {
          throw e; // the events stay without cells, the next scan tries again
        }
        return;
      }
      page = (await send({ cmd: "reviewPage", slug: target.slug, page, html })).next;
      await sleep(PAGE_DELAY_MS);
    }
  }

  /** Phase 2, the only place that fetches review details: every add-on that has events without cells. Returns true if cancelled. */
  async function fetchDetails() {
    state.stage = "details"; // the check of the stored data comes first and can take a moment
    const { targets, fromStored } = await send({ cmd: "pendingSlugs" });
    Object.assign(state, { stage: "details", detailTotal: targets.length, detailStored: fromStored });
    for (const target of targets) {
      if (cancelRequested) {
        return true;
      }
      state.detailIndex++;
      try {
        await walkAddon(target);
      } catch (e) {
        state.detailFailed++;
        state.detailError = `${target.slug}: ${e.message || e}`;
      }
    }
    return cancelRequested;
  }

  /** The raw text of a file of a version (a redirect to the file in the package). A page instead of a file (a login page, an error page) is an error. */
  function fetchFile(url) {
    return fetchText(url, (body) => {
      if (/^\s*</.test(body) && !/<(?:\w+:)?RDF[\s>]/i.test(body)) {
        throw new Error("the answer is a web page, not a file");
      }
      return body;
    });
  }

  /**
   * The type of one version: its manifest.json is read and the background page tells the type. If the file is not there (4xx) the version may be a legacy add-on,
   * which has install.rdf. If neither is there nothing is stored, and the version is asked again at the next scan. Any other failure leaves it pending as well.
   * Returns the type, or null.
   */
  async function readType(target) {
    try {
      const text = await fetchFile(target.url);
      return (await send({ cmd: "manifestText", slug: target.slug, version: target.version, text })).type;
    } catch (e) {
      if (!e.final) {
        throw e;
      }
    }
    const rdf = await fetchFile(target.installUrl).catch((e) => {
      if (!e.final) {
        throw e;
      }
      return null;
    });
    if (rdf === null || !/<(?:\w+:)?RDF[\s>]/i.test(rdf)) {
      return null;
    }
    await send({ cmd: "fileResult", slug: target.slug, version: target.version, type: "legacy" });
    return "legacy";
  }

  /**
   * Phase 3: the versions that have events without a type. Their manifest.json or install.rdf is read, see readType. Returns true if cancelled.
   */
  async function checkFiles() {
    state.stage = "files";
    const { targets } = await send({ cmd: "pendingFiles" });
    state.fileTotal = targets.length;
    for (const target of targets) {
      if (cancelRequested) {
        return true;
      }
      state.fileIndex++;
      let type;
      try {
        if (new URL(target.url).origin !== location.origin) {
          throw Object.assign(new Error("not on this site"), { final: true });
        }
        type = await readType(target);
      } catch (e) {
        state.fileFailed++;
        state.fileError = `${target.slug} ${target.version}: ${e.message || e} (${target.url})`;
        continue; // the version stays pending
      }
      if (type) {
        state.fileTypes[type] = (state.fileTypes[type] || 0) + 1;
      } else {
        state.fileUnknown++;
      }
      await sleep(PAGE_DELAY_MS);
    }
    return cancelRequested;
  }

  const listOf = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

  function doneMessage(inRange) {
    const parts = [`${state.added} new, ${state.skipped} already stored.`];
    const ignored = [state.unlisted && `${state.unlisted} unlisted`, state.noSlug && `${state.noSlug} without a slug`].filter(Boolean);
    const expected = state.siteTotal - state.unlisted - state.noSlug;
    if (state.siteTotal !== null) {
      parts.push(expected === inRange
        ? `Matches the ${state.siteTotal} entries the site reports${ignored.length ? ` (${ignored.join(", ")} rows ignored)` : ""}.`
        : `The site reports ${state.siteTotal} entries${ignored.length ? `, of which ${listOf(ignored)} were ignored` : ""}, ${inRange} are stored for this range.`);
    }
    if (state.warnings) {
      parts.push(`${state.warnings} rows had unreadable fields.`);
    }
    if (state.badRemoved) {
      parts.push(`${state.badRemoved} rows without event, add-on and version were removed.`);
    }
    if (state.queueNew || state.queueUpdates || state.queueError) {
      parts.push(`Queue: ${state.queueNew} new and ${state.queueUpdates} updates waiting, ${state.queueAdded} added${state.queueError ? `, could not be read: ${state.queueError}` : ""}.`);
    }
    if (state.detailStored) {
      parts.push(`Review details of ${state.detailStored} add-ons were filled in from stored data.`);
    }
    parts.push(state.detailTotal === 0
      ? "Review details are up to date."
      : `Review details fetched for ${state.detailTotal} add-ons${state.detailFailed ? `, ${state.detailFailed} could not be read (last: ${state.detailError}), they are tried again at the next scan` : ""}${state.detailNoAccess ? `, ${state.detailNoAccess} not accessible` : ""}.`);
    if (state.fileTotal) {
      const found = Object.entries(state.fileTypes).map(([type, n]) => `${n} ${type}`);
      parts.push(`Type check of ${state.fileTotal} versions: ${found.length ? found.join(", ") : "none found"}, ${state.fileUnknown} without manifest.json or install.rdf (not stored, asked again at the next scan)${state.fileFailed ? `, ${state.fileFailed} could not be read (last: ${state.fileError}), they are tried again at the next scan` : ""}.`);
    }
    return parts.join(" ");
  }

  async function scan({ start, end }) {
    cancelRequested = false;
    Object.assign(state, blankState(), { runId: state.runId + 1 });
    try {
      let cancelled = await scanLog({ start, end });
      const { inRange, removed } = await send({ cmd: "finishScan", start, end });
      state.badRemoved = removed;
      cancelled = cancelled || (await readQueues()) || (await fetchDetails()) || (await checkFiles());
      await send({ cmd: "cleanupWaiting" }); // the review entries are up to date now: a waiting version that is disabled or deleted is not waiting
      state.message = cancelled
        ? `Cancelled. ${state.added} new events were stored${state.stage === "files" ? `, type check: file ${state.fileIndex} of ${state.fileTotal}` : state.stage === "queue" ? ", reading the queues" : state.stage === "details" ? `, review details: add-on ${state.detailIndex} of ${state.detailTotal}` : ` after log page ${state.page}`}.`
        : doneMessage(inRange);
      state.phase = cancelled ? "cancelled" : "done"; // last, so a poller never sees it without the message
    } catch (e) {
      state.message = state.stage === "files" ? `Type check: ${e.message || e}` : state.stage === "details" ? `Review details: ${e.message || e}` : `Log page ${state.page + 1}: ${e.message || e}`;
      state.phase = "error";
    } finally {
      await flushRequests().catch(() => {});
      send({ cmd: "scanEnded" }).catch(() => {}); // the tab is free again (done, cancelled or failed)
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    switch (msg && msg.cmd) {
      case "status":
        return Promise.resolve({
          onLogPage: !!document.querySelector("table#log-listing") || !!document.querySelector("#log-filter"),
          state: { ...state }
        });
      case "scan":
        if (state.phase === "running") {
          return Promise.resolve({ started: false });
        }
        scan(msg);
        return Promise.resolve({ started: true });
      case "cancel":
        cancelRequested = true;
        return Promise.resolve({ ok: true });
      default:
        return undefined;
    }
  });
})();
