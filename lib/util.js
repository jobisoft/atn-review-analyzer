/* Small helpers shared by the extension pages and the background page. */

/** The promise, or `fallback` if it did not settle within `ms`. The timer is cleared, a rejection of the promise passes through. */
export function withTimeout(promise, ms, fallback = null) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** "2026-11-03T23:31:00" as "2026-11-03 23:31". Anything else (null, a text) is returned as it is, null as "". */
export function formatTime(time) {
  return time ? time.replace("T", " ").slice(0, 16) : "";
}

/** Offers a text as a file to save. */
export function downloadText(filename, mime, content) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Today as YYYY-MM-DD, in local time. */
/** The start of the scan range if nothing else is chosen. The popup and the analysis page both start with it. */
export const DEFAULT_START = "2025-01-01";

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
