import { parseImport } from "../lib/transfer.js";

const $ = (id) => document.getElementById(id);

// how many items go into one message. Entries and whole pages are large.
const CHUNK = { events: 500, entries: 40, pages: 10 };

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

/** Sends the items in chunks and adds up the numbers of the answers. */
async function sendInChunks(cmd, key, items, size, onProgress) {
  const total = {};
  for (let i = 0; i < items.length; i += size) {
    const answer = await browser.runtime.sendMessage({ cmd, [key]: items.slice(i, i + size) });
    for (const [name, value] of Object.entries(answer)) {
      total[name] = (total[name] || 0) + value;
    }
    onProgress(Math.min(items.length, i + size), items.length);
  }
  return total;
}

function summary(events, entries, ignored, invalid) {
  const parts = [`${events.added || 0} added`, `${events.skipped || 0} already stored`];
  if (invalid + (events.invalid || 0) + (entries.invalid || 0)) {
    parts.push(`${invalid + (events.invalid || 0) + (entries.invalid || 0)} unreadable entries ignored`);
  }
  if (ignored) {
    parts.push(`${ignored} without a slug ignored`);
  }
  const kept = entries.kept || 0;
  return `Done: ${parts.join(", ")}. Review entries: ${entries.added || 0} added, ${entries.updated || 0} updated, ${kept} kept (an entry fetched later is kept).`;
}

$("file").addEventListener("change", () => {
  $("import").disabled = $("file").files.length === 0;
  setStatus("");
});

$("import").addEventListener("click", async () => {
  const file = $("file").files[0];
  if (!file) {
    return;
  }
  $("import").disabled = true;
  $("file").disabled = true;
  $("analyze").hidden = true;
  try {
    setStatus("Reading the file...");
    const data = parseImport(await file.text());
    $("bar").hidden = false;
    const progress = (what) => (done, total) => {
      $("bar").max = Math.max(1, total);
      $("bar").value = done;
      setStatus(`${done} of ${total} ${what} processed...`);
    };
    if (data.anonymous) {
      await browser.runtime.sendMessage({ cmd: "markAnonymous" });
    }
    const events = await sendInChunks("importEvents", "events", data.events, CHUNK.events, progress("events"));
    const entries = await sendInChunks("importEntries", "entries", data.entries, CHUNK.entries, progress("review entries"));
    const pages = await sendInChunks("importLegacyPages", "pages", data.legacyPages, CHUNK.pages, progress("review pages"));
    for (const [name, value] of Object.entries(pages)) { // a whole page of an older file ends up as entries
      entries[name] = (entries[name] || 0) + value;
    }
    setStatus(summary(events, entries, data.ignored, data.invalid));
    $("analyze").hidden = false;
  } catch (e) {
    setStatus(e.message || String(e), true);
  } finally {
    $("bar").hidden = true;
    $("file").disabled = false;
    $("import").disabled = $("file").files.length === 0;
  }
});

$("analyze").addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("analysis/analysis.html") });
});
