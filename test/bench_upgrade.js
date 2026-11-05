// Times the upgrade of a version 6 database with all stored review pages of a real export (staged as bench.json).
const SITE = "http://127.0.0.1:8770";
const t = (label, ms) => ({ name: label, ok: true, detail: String(ms) });
async function main() {
  const data = await (await fetch("bench.json")).json();
  const { upgradeSchema, convertLegacyPages } = await import("./lib/db.js");
  const name = "bench-upgrade";
  const checks = [];
  await new Promise((res) => { const d = indexedDB.deleteDatabase(name); d.onsuccess = d.onerror = res; });
  await new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 6);
    req.onupgradeneeded = () => {
      const d = req.result;
      const ev = d.createObjectStore("events", { keyPath: "id" });
      ev.createIndex("date", "date");
      ev.createIndex("fingerprint", "fingerprint", { unique: true });
      d.createObjectStore("meta", { keyPath: "key" });
      const pages = d.createObjectStore("reviewPages", { keyPath: "id" });
      pages.createIndex("addonSlug", "addonSlug", { unique: true });
      for (const p of data.reviewPages) pages.add(p);
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
  const t0 = performance.now();
  const upgraded = await new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 8);
    req.onupgradeneeded = (ev) => upgradeSchema(req.result, req.transaction, ev.oldVersion);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked"));
  });
  const ms = Math.round(performance.now() - t0);
  const t1 = performance.now();
  await convertLegacyPages(upgraded);
  checks.push(t("conversion ms", Math.round(performance.now() - t1)));
  const n = await new Promise((res) => { const q = upgraded.transaction("reviewEntries").objectStore("reviewEntries").count(); q.onsuccess = () => res(q.result); });
  checks.push(t(`upgrade of ${data.reviewPages.length} pages took ms, entries=${n}`, ms));
  await fetch(`${SITE}/report`, { method: "POST", body: JSON.stringify({ type: "finished", checks }) });
}
main().catch((e) => fetch(`${SITE}/report`, { method: "POST", body: JSON.stringify({ type: "finished", checks: [], error: String(e.stack || e) }) }));
