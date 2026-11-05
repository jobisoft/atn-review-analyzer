/*
 * The size of the review queue over time, calculated from the events when it is wanted (nothing is stored for it).
 *
 * A version is in the queue from its submission (tSubmission) until its first decision (an Approved or Rejected event). A version
 * that waits now (a row "Awaiting Review") is in it until now. 
 *
 * A decision without a wait time (tWait null) is a later review of a version that was decided before, the version was not in the queue then.
 */
import { WAITING_EVENT } from "./facts.js";

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

const utc = (wall) => Date.parse(`${wall}Z`); // the times of the log have no time zone, they are all read the same way

/**
 * The versions of one queue ("new" or "update") that were in the queue: [{ start, end }] in milliseconds, end is Infinity for a version
 * that waits now, decision is the event of the first decision (Approved or Rejected, none for a waiting one). Events without a submission time or without a queue are left out.
 */
export function queueItems(events, queue) {
  const decisions = new Map(); // version -> its first decision
  for (const e of events) {
    if ((e.event === "Approved" || e.event === "Rejected") && e.date && e.tWait !== null) { // no wait: a later review of a version that was decided before
      const key = `${e.addonSlug}\u001f${e.addonVersion}`;
      const old = decisions.get(key);
      if (!old || e.date < old.date) {
        decisions.set(key, e);
      }
    }
  }
  const items = [];
  for (const [, e] of decisions) {
    if (e.queue === queue && e.tSubmission) {
      const start = utc(e.tSubmission);
      const end = utc(e.date);
      if (end >= start) {
        items.push({ start, end, decision: e.event });
      }
    }
  }
  for (const e of events) {
    if (e.event === WAITING_EVENT && e.queue === queue && e.tSubmission && !decisions.has(`${e.addonSlug}\u001f${e.addonVersion}`)) {
      items.push({ start: utc(e.tSubmission), end: Infinity });
    }
  }
  return items;
}

/**
 * What came into the queue and what left it in every week: [{ start (a Date), arrived, approved, rejected, size }]. arrived is the number of submissions in the
 * week, approved and rejected the number of first decisions in it, size the size of the queue at the end of the week (now for the week that is not over).
 */
export function weeklyFlow(items, weeks, now = Date.now()) {
  return weeks.filter((date) => Date.parse(`${isoDay(date)}T00:00:00Z`) < now).map((date) => {
    const from = Date.parse(`${isoDay(date)}T00:00:00Z`);
    const to = Math.min(from + WEEK_MS, now);
    const flow = { start: date, arrived: 0, approved: 0, rejected: 0, size: 0 };
    for (const { start, end, decision } of items) {
      flow.arrived += start >= from && start < to;
      if (end !== Infinity && end >= from && end < to) {
        flow[decision === "Approved" ? "approved" : "rejected"]++;
      }
      flow.size += start < to && end > to;
    }
    return flow;
  });
}

/**
 * How long the add-ons of a week have waited, in days: [{ start (a Date), n, reviewed, waiting, median, mean }]. The sample of a week is the same as in weeklyOldestAge: every add-on that was in the queue
 * at any time of the week, with its age when it was reviewed, or at the end of Sunday (now, for a week that is not over) if it was still waiting. So a week in which nothing was decided is not empty, and a week
 * in which the queue was stuck shows how old the waiting add-ons are. median and mean are null if no add-on was in the queue. The waiting ones are "at least" this old.
 */
export function weeklyReviewTime(items, weeks, now = Date.now()) {
  return weeks.filter((date) => Date.parse(`${isoDay(date)}T00:00:00Z`) < now).map((date) => {
    const from = Date.parse(`${isoDay(date)}T00:00:00Z`);
    const until = Math.min(from + WEEK_MS, now);
    const days = [];
    let reviewed = 0;
    for (const { start, end } of items) {
      if (start < until && end > from) {
        days.push((Math.min(end, until) - start) / DAY_MS);
        reviewed += end <= until;
      }
    }
    if (days.length === 0) {
      return { start: date, n: 0, reviewed: 0, waiting: 0, median: null, mean: null };
    }
    days.sort((x, y) => x - y);
    const middle = days.length >> 1;
    return {
      start: date, n: days.length, reviewed, waiting: days.length - reviewed,
      median: days.length % 2 ? days[middle] : (days[middle - 1] + days[middle]) / 2, mean: days.reduce((a, b) => a + b, 0) / days.length
    };
  });
}

/** The rows of the picture with the ages in weeks: one per week of age, from 0 to HEAT_WEEKS - 1. The last row is open (that old and older). */
export const HEAT_WEEKS = 36;
export const AGE_WEEK_EDGES = Array.from({ length: HEAT_WEEKS }, (_, i) => i);

/**
 * The ages of the add-ons in the queue per week, whole add-ons: [{ start (a Date), counts }]. An add-on counts once for every week in which it was in the queue at any time, however short
 * (it overlaps the week). Its age for that week is the age when it left the queue (it was reviewed), or the age at the end of Sunday (now, for a week that is not over) if it was still there.
 * It goes into the row of that age in whole weeks (AGE_WEEK_EDGES): row i holds the add-ons that are less than i + 1 weeks old.
 */
export function weeklyOldestAge(items, weeks, now = Date.now()) {
  return weeks.map((date) => {
    const from = Date.parse(`${isoDay(date)}T00:00:00Z`);
    const until = Math.min(from + WEEK_MS, now); // the end of Sunday, or now
    const counts = AGE_WEEK_EDGES.map(() => 0);
    for (const { start, end } of items) {
      if (start < until && end > from) {
        counts[Math.min(Math.floor((Math.min(end, until) - start) / WEEK_MS), HEAT_WEEKS - 1)]++;
      }
    }
    return { start: date, counts };
  });
}

/** YYYY-MM-DD of a date at local midnight. */
function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
