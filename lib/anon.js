/*
 * The anonymous data set: the events as they are stored, with the reviewers replaced by fake UUIDs and without the comments. It has the shape of the normal export
 * (format version 6, without review entries, with "anonymous": true), so another profile can import it and show it like real data.
 *
 * A reviewer UUID is made from the name and a secret key (HMAC SHA-256) that stays in the database of the add-on. It is always the same for the same reviewer in this
 * database (also in a later export), different for different ones, and it can not be turned back or guessed from a list of names. "Nobody", the placeholder of a waiting
 * version, is not a person and stays as it is.
 */
import { getMeta, setMeta } from "./db.js";
import { buildExport } from "./transfer.js";

/** A new secret key: 32 random bytes as hex. */
export const newKey = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));

/** The UUID (version 4 layout) that HMAC SHA-256 of the text with the key gives. */
async function uuidOf(cryptoKey, text) {
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(text))).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The events with fake reviewers and empty comments. Everything else is as stored. keyHex is the secret key (see newKey). */
export async function anonymousEvents(events, keyHex) {
  const cryptoKey = await crypto.subtle.importKey("raw", hexToBytes(keyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const cache = new Map();
  const reviewerId = async (name) => {
    if (!name || name === "Nobody") {
      return name;
    }
    if (!cache.has(name)) {
      cache.set(name, await uuidOf(cryptoKey, `reviewer\u001f${name}`));
    }
    return cache.get(name);
  };
  const out = [];
  for (const e of events) {
    out.push({ ...e, reviewer: await reviewerId(e.reviewer), comment: "" });
  }
  return out;
}

/** The text of the anonymous file: an export of the anonymous events, without review entries, marked as anonymous. */
export async function anonymousJson(events, keyHex) {
  return buildExport(await anonymousEvents(events, keyHex), [], { anonymous: true });
}

/** The text of the anonymous file for these events. The key for the fake UUIDs is made once and stays in the database. */
export async function anonymousFile(events) {
  let key = await getMeta("anonKey");
  if (!key) {
    key = newKey();
    await setMeta("anonKey", key);
  }
  return anonymousJson(events, key);
}
