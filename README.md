# ATN Review Analyzer

A Firefox add-on (Manifest V3) that collects the add-on review log of addons.thunderbird.net into a local IndexedDB
database and shows statistics about it. For every Approved or Rejected event it also works out when the version was
submitted, how long the review took, and whether it was a new add-on or an update.

Nothing is sent anywhere else. The log is password protected, so only a content script running in the logged in page can
fetch it. That is why scans run in a review log tab.

## Rules

- The **popup** fetches data (Scan) and manages it (Export, Import, Wipe).
- The **analysis page** only shows what is stored. It never fetches.
- Review details (the history page of an add-on) are fetched **only** by a scan of the log, after the log pages.

## Use

1. Open the review log page in a tab. After installing the add-on, reload an open log page once so the content script is injected.
2. Click the toolbar button. It shows the number of events and review entries, the time of the last scan and the graph
   "Review Activity" (stacked lines of rejected, other and approved events on a time axis).
3. Choose what to scan and press **Scan**:
   - **New entries only** (default): from the day of the newest stored event until today. If nothing is stored, the From date is used.
   - **Scan a range**: exactly the From and To dates. An empty To date means today. Use it to add an earlier period.
4. **Analyze** opens the analysis page. **Export JSON** and **Import JSON...** save and load the data. **Wipe all data** removes
   events, review entries and the last-scan time (it asks twice, and is refused while a scan runs). The settings stay.

A scan removes only two kinds of rows: waiting rows of versions that have another entry now or whose stored review entry is not "Awaiting Review" any more (see Queues) and rows that have no event, no add-on slug and no version, which an older parser stored for unlisted versions (a row with any of the three is kept). Events that are stored already are skipped, found by their fingerprint, a hash of date, add-on id,
version, event and reviewer. Several identical events in the same minute therefore count as one.

The popup does not depend on the active tab. The background page tracks one review log tab (see below) and the popup controls
that tab from any window. Without a review tab the popup still opens, but Scan and the date fields are disabled.
In Thunderbird (`runtime.getBrowserInfo` says so) the popup only shows the data: the counts, the Review Activity graph and the Export, Import and Analyze buttons. The scan part, the last scan time and Wipe are hidden, and no tab is tracked.

## What a scan does

1. **Log**: walks all pages of the range (`?start=...&end=...&page=N`) and stores one event per row: date (as shown, no time zone),
   event, reviewer, comment, add-on name, version and slug, and the add-on id of the site. Rows about unlisted versions
   (`/reviewers/review-unlisted/`) and add-ons without a slug ("None") are ignored and counted. The message at the end compares
   the stored count with the number the site reports.
2. **Queues**: the review queues `/reviewers/queue/new` and `/reviewers/queue/updates` list every version that is submitted and not decided yet.
   Each one becomes a row of the log with the event "Awaiting Review" (shown as Pending on the analysis page), no date, the reviewer "Nobody" and the queue it was read in (new or update).
   Like any entry a row that is stored is skipped. A version that has another entry in the log (a decision, or an information request) is not added,
   and the waiting row of such a version is removed after the log was read. Only reading the log moves the start of "New entries only", the queues do not.
   A version that leaves the queue without any entry in the log keeps its row until its stored review entry (step 3) says it is not "Awaiting Review" any more, then it is removed (step 4). A queue that can not be read is reported and the scan goes on.
3. **Details**: for every add-on that has events without the cells below, the history page `/reviewers/review/<slug>` is
   walked. The content script only fetches. The background page decides which page comes next:
   - the entry of the event's version must be on the page. If it is not, the walk goes to the next, older page (10 versions per page).
   - for an Approved or Rejected event a row "Approved" dated before the event must exist in some version (deleted versions
     count). If there is none, the walk goes back until one is found or the oldest page is reached.
   - every entry that was fetched on the way is stored. Stored entries are used first, so a repeated scan fetches nothing.
4. **Type**: every event has the type of its version (`type`, waiting rows too, whatever its queue, event or date), found from the stored entry and the files of the version:
   - a **manifest** on the entry (`manifest`) answers from its text: `experiment` if it has an `experiment_apis` key, `theme` if it has a `theme` key, else `webextension`.
   - an entry with a download link and **no Contents link** is a `theme`. There is no file to read.
   - otherwise `manifest.json` is fetched directly from `/en-US/thunderbird/files/browse/<file id>/file-redirect/manifest.json` (the file id is in the links of the stored entry) and its text is stored on the entry.
   - if that gives HTTP 4xx, `install.rdf` is fetched from the same place. If it is there the version is `legacy`.
   - if neither file is there **nothing is stored**: the events have no type, and the next scan asks again. Any other failure leaves them pending as well.
   The manifest is read like Firefox reads it: comments (`//` and block comments) and a comma before a closing bracket are fine (`parseLooseJson` in `lib/facts.js`, a few lines, no library). A text that is no JSON
   even then is searched: with `"manifest_version"` in it and no `experiment_apis` it is a `webextension`, with the key an `experiment`, else it has no type.
   An entry that an earlier build stored with its links turned into plain text has no file id. Its review page is fetched again (step 3 walks it, as for a missing entry) so that the entry is stored as the site sends it.
   Every request of a scan is logged with its HTTP status (`Download request log` in the popup, next to Wipe all data: time, status and address, the newest 5000).
   At the end the waiting rows whose stored entry does not say "Awaiting Review" any more (disabled or deleted without a review) are removed.
5. The cells are written into the events, see below.

A scan can be stopped with the Stop button, which is disabled and says "Stopping..." until the scan has ended. Add-ons that were finished keep their cells and the others are tried again at the next scan.
A network or server error leaves the events of that add-on without cells, so they are retried too.

## Cells of an event

The cells are calculated by a scan and only there. A cell that is missing is calculated again from the stored entries, without a request when the entries are there.

| Cell | Meaning |
|---|---|
| `tSubmission` | When the version was submitted: the day of the entry header, and the time of the earliest row without a label (a developer row) on that day that is not later than the event, else 00:00. The same for every event of an entry. |
| `tWait` | Event time minus `tSubmission` in days, two decimals. An Approved or Rejected event after the first decision of the version (the earliest row Approved, Preliminarily approved or Rejected of the entry) has none (`null`), it is a review of a version that was decided before. |
| `type` | `webextension`, `experiment`, `theme` or `legacy` (see above). Absent means the files of the version were not found yet, which a scan asks again. |
| `queue` | The queue of the version: for every event, `update` if an Approved row exists before the event, `new` if the whole history is known and has none. The waiting rows have the queue they were read in. `null`, shown as unknown, if the history can not be read (for example an add-on of the reviewer that the page does not show). |

A cell that is absent means the event was not looked at yet. `null` means it was looked at and nothing can be found
(for example the version is on no page). Special cases:

- HTTP 404 for the review page: a Rejected event gets `queue` `new`, everything else stays `null`.
- Version 14 of the database renamed `kind` to `queue` (files of the versions up to 7 are read the same way). Version 15 clears the cells of events that are no decision and have no queue, so the scan works them out again (they only had a queue from this build on).
- A redirect to the review queue (no access, for example to an own add-on): all cells `null` and the add-on is not asked for again.

## Data

Database `reviewlog`, version 11 (the same data as version 10):

- `events`: the log. Index `date`, unique index `fingerprint`.
- `reviewEntries`: one record per version of an add-on, the HTML of its header row and body row as a small table, exactly as the site sent it.
  Found by the unique composed index `slugVersion` (`["addonSlug", "version"]`). `oldest` is true for the entry of the oldest
  version of an add-on (its page had no "Older" link).  Nothing is removed when it is stored. The analysis page only parses it and shows a safe copy (scripts, handlers, images dropped, links as text).
- `meta`: `lastScan`, and `inaccessible` (add-ons whose page redirects to the queue).

Older databases are upgraded when opened: empty events and "None" data are dropped, the failure log, scan coverage and unused indexes are
removed, and (version 9) the entries of versions that were rejected on or after 2026-03-17 (the announcement of the pause on new Experiment reviews) are purged and the events of those versions lose their cells, so the next scan
fetches them again as the site sent them. Version 12 replaced `isExperiment` by `type` (true is `experiment`, false `webextension`, null no type). Whole pages that an earlier build stored are cut into entries in the background after the upgrade.

## Analysis page

All graphs of the analysis page count per week (weeks start on Monday), whatever the range. The graph in the popup chooses days, weeks or months by the time span.

The filter bar at the top applies to everything: the dates (they start with the values of the popup, empty To is today, Reset brings them back) and a text box that matches part of the add-on name, nothing else.
Submission Activity and Review Activity each have their own filter below the heading, with the same choices but separate boxes. Every choice is a drop down with All and the values: reviewer, event (one type of event), queue (new, update or unknown), and type (WebExtension, Experiment, Theme, Legacy or unknown). Every section follows the top bar and only its own filter. The tables of Reviewers and Event Types and the records have the same four choices, the records a Text filter as well (words that must all be found in the add-on name or the comment, a first `n:` searches the name only, a first `c:` the comment only). Review Queue Activity has only a Type filter, the queue needs every submission, so there is no reviewer, event or queue choice, and its graphs split by queue themselves.
Each filter has its own Reset. A waiting row counts on the day it was submitted.

- **Submission Activity** (time axis: the submission): one graph, the events by submission date, on the From and To dates counted on the day of the submission. Its tooltips only give the
  period and the number submitted.
- **Review Activity** (time axis: the review): one graph, the events by review date, over the full width (the graph of the popup), stacked from the bottom by Rejected, Other and Approved (and Pending on top in the submission graphs).
- **Review Queue Activity** (the third section, with a Type filter of its own): four subsections (Review Queue Size, Review Queue In/Out, Review Time, Review Queue Age), each with its description and its legend and a pair of graphs. The first three have the new queue on the left and the update queue on the right, the age has the two pictures below each other. All four follow the top bar and the Type filter of the section.
  1. Review Queue Size: the size of the queue at the end of every week, as a line.
  2. Review Queue In/Out: what came and went per week: bars up for the submissions and bars down for the first decisions. Rows 1 and 2 have the same number of pixels for one add-on
     (`flowScale` in `chart.js`), so a bar and the line can be compared by their height, and the graphs of the two queues have the same axes. The axes of rows 1 and 2 have a line every 10 add-ons (`FLOW_STEP`), coarser only above 400 add-ons.
  3. Review Time: how long the add-ons of a week have waited (`weeklyReviewTime` in `queue.js`), in days, as the median (solid line) and the mean (dashed line, pulled up by a few very long waits). The sample is the same as in Review Queue Age: every add-on that was in
     the queue at any time of the week, with its age when it was reviewed, or at the end of Sunday (now, for the week that is not over) if it was still waiting. So a week in which nothing was decided is not empty, it shows how old the waiting add-ons are, and the line
     rises when the queue is stuck. The waiting ones are at least this old. The tooltip gives how many were reviewed and how many still waited. The two graphs share the axis, which has a line every 10 days (`REVIEW_TIME_STEP` in `chart.js`).
  A first decision is the first Approved or Rejected of a version, like everywhere else in the queue.
  4. **Review Queue Age**: one 3D picture per queue (`surface.js`), the new queue above the update queue, each as wide as the page, with the same weeks and the filter of the section. One axis of the floor is the week, the other one is the age in weeks (36 rows, the last one is that old and older, `HEAT_WEEKS` in `queue.js`). Row i holds the add-ons that are less than i + 1 weeks old, and the labels
  "1w", "2w", "3w", "4w", then every 4 weeks sit on the edges between the rows, so the green row is obviously less than 1w, and a line marks every week of age. The height of a tower is the number of add-ons, and a tower is a stack of blocks, one block is one add-on.
  Whole add-ons, no averaging and no look at the end of a day (`weeklyOldestAge`): an add-on counts once for every week in which it was in the queue at any time, however short, even if it was submitted and reviewed within hours.
  Its age for that week is its age when it was reviewed, or its age at the end of Sunday (now, for the week that is not over) if it was still waiting. It goes into the row of that age, "less than i + 1 weeks". An add-on that stays several weeks counts once in each of them, at its new age.
  A group that is submitted and reviewed together is the same number of blocks in every week it is in the queue and moves up one row per week, so there is no spike when it leaves.
  The colour of a tower is the age: green for the first week (not yet 7 days old), yellow for the second, orange for the third, red for the fourth and dark red for everything older (`AGE_WEEK_COLORS` in `surface.js`). The opacity is the number of add-ons.
  The two pictures have the same height scale, and the opacity of each is relative to its own busiest cell (`opacityMax` in `surfaceGraph`), from `OPACITY_LOW` (faint, 0.3) to `OPACITY_HIGH` in `chart.js`, on the curve of the inverse of a logarithm (`HEAT_STEEPNESS` in `chart.js`), so a single add-on stays faint and
  many in the same place get much more weight. A week of age is `AGE_WEEK_STRETCH` times (1.5) as wide as a week of the time axis (`analysis.js`).
  Drag a picture with the mouse to turn it, from above down to the side where the floor is a line. The same key, Ctrl (Cmd on a Mac), moves it when held while dragging and zooms around the pointer with the mouse wheel (the wheel alone still scrolls the page, and the right button moves it too).
  Three buttons in the corner zoom in, zoom out and put the view back, and a double click puts it back too. The steps are small: 15 percent for a click, about 22 percent for a notch of the wheel (`ZOOM` in `surface.js`). Calculated when the page is drawn, nothing is stored for it.
- **Reviewers and Event Types**: tables with counts and approval rates. The reviewer table has the columns Total, Approved, Rejected, Pending (versions that wait in a queue, reviewer "Nobody"), Other and Approval rate. The page calls the stored event "Awaiting Review" Pending, in the tables, the filters, the records and the legends. The stored value, the exports and the request log keep "Awaiting Review".
- **Records**: columns Date, Event, Reviewer, Add-on, Submitted, Wait in days, Queue, Type, Comment and Review entry. The entry cell opens the
  stored entry of the version, with red boxes around the dates that give the submission. A menu limits the rows shown (50, 200, 500, all).
  JSON and CSV export contain all matching rows. A waiting row is not shown if its version has another entry in the log.

## Anonymous data

With the toggle **Anonymize** in the popup (below Analyze), **Export JSON** saves all stored events (the filters do not count) as `reviewlog-anon-<date>.json`. It has the shape of the normal export (format version 6, no review entries, and `"anonymous": true`).
Two things differ from the real data. The comments are empty, and every reviewer is replaced by a fake UUID. Add-on, name, version, dates and all cells are as stored. The placeholder "Nobody" of waiting versions is not a person and stays.

A reviewer UUID is made from the name and a secret key (HMAC SHA-256) that the add-on creates once and keeps in its database (`meta`, `anonKey`). It stays the same for the same reviewer in later exports from this database, and it can not be guessed
from a list of names. The key is never exported, and Wipe all data removes it.

**Import in another profile.** The import page reads the file like any export, and the analysis page shows it like real data. An imported anonymous file marks that profile (`meta`, `anonymousData`): the popup then says so and Scan is off, because a scan
would mix real pages into the fake ones. Wipe all data clears the mark.

With **Anonymize** on, **Analyze** opens the analysis page a second time (`analysis.html?anon=1`) with the data read back from the text of the file, as another profile would import it, and nothing else. It shows what the file allows to be made.
There the comment and review entry columns and the exports of the records are hidden, and the fake UUIDs are shown by their first 8 characters.

All graphs of the analysis page are made from these events and nothing else, so they can be rebuilt from the file. The cells `tSubmission`, `tWait`, `queue` and `type` are worked out by a scan from the review entries and the manifests
(see Cells of an event), which contain comments and are not part of the file.

## Export and import

- **Export JSON** (format version 8) saves events with their cells and `type`, and all review entries (with the manifest text where it was read) to `reviewlog-export-<date>.json`.
  The fingerprint is not exported because it is derived.
- **Import JSON...** opens a tab with a file chooser, because Firefox closes the popup when a file dialog opens. Known events are skipped.
  Entries are added, and an entry fetched later wins over an older one. Files of versions 2 to 6 are read. Whole pages of
  old files are cut into entries and read failures are ignored. Unreadable items are counted and ignored.

## Scan tracker

The background page keeps `{ tabId, scanning }` in the session storage area and updates it on these events:

- add-on start: pick a review tab (a loaded one, then the most recently used), or none.
- the tracked tab is closed, discarded, or leaves the review log URLs: `scanning` is false, another review tab is picked or none.
- the tracked tab starts loading again: the running scan is gone, so `scanning` is false.
- a tab finishes loading and no tab is tracked: it is tracked if it is a review log page.
- the content script reports that its scan ended (done, cancelled or failed): `scanning` is false.

Scan and Stop go through the background, which refuses a second scan. The popup follows the tracker through storage change
events. If the tracker and the tab disagree for more than one poll, the popup asks the background to `reconcile`.

## Install (development)

`about:debugging#/runtime/this-firefox` and **Load Temporary Add-on...**, pick `manifest.json`. Temporary add-ons are removed on restart. After a change, press **Reload** there.

## Package / sign

The shipped files are listed in `SHIPPED` in `test/package.py`, which the Firefox test uses too. The test folder, the dist folder and the notes are not shipped.

```sh
cd atn-review-analyzer
python3 test/package.py            # dist/atn-review-analyzer.xpi
python3 test/package.py ../x.xpi   # or any other path
```

The file name has no version, so a reload finds the same file after the version changed. The add-on ID in `manifest.json` stays the same for the same reason: Firefox ties the stored data to it, so a new ID is an
add-on with an empty database. Or use [`web-ext`](https://github.com/mozilla/web-ext) (`lint` / `run` / `build` / `sign`), and submit to [addons.mozilla.org](https://addons.mozilla.org/developers/) for signing.
The manifest declares `data_collection_permissions: ["none"]`: the add-on only reads the pages of addons.thunderbird.net with the session of the logged-in reviewer, and stores everything in the browser.

## Files

```
manifest.json   Permissions: storage and https://addons.thunderbird.net/*
background.js   Message router, checks every payload, all database work, decides the next history page
content.js      Runs on the log page. Fetches log and history pages with retries, reports progress. No review logic
lib/            The modules, shared by the background page, the pages and the tests
assets/         common.css
popup/          The toolbar popup
analysis/       The analysis page
import/         The import page
icons/          The icon
test/           Unit tests, the Firefox test and the packaging script (not shipped)
```

| In `lib/` | Role |
|---|---|
| `db.js` | Schema, upgrade steps and all reads and writes. |
| `tracker.js` | The scan tracker. |
| `facts.js` | Pure functions: which page is needed, and `tSubmission`, `tWait`, `queue`. |
| `parser.js`, `reviewpage.js` | Plain scripts (also loaded as modules and by the tests): the log and queue page parser, the history page reader and the safe copy for display. |
| `transfer.js` | Export and import format, validation of records. |
| `reviewdom.js` | The display copy of a stored entry with the red boxes. |
| `anon.js` | The anonymous data set: fake reviewer UUIDs, no comments, the text of the file. |
| `queue.js` | The queue from the events: size, flow, review time, ages. |
| `chart.js` | The graphs (SVG). |
| `surface.js` | A 3D column chart that turns with the mouse (one canvas, no library): `columns3d` for any columns and labels, and `surfaceGraph` for the age pictures. The picture is worked out as a list of polygons (`buildScene`) and then painted, so a picture with thousands of columns is one element. |
| `util.js` | Small helpers. |

## Tests

- Unit tests (node and jsdom): `test/*.test.js`, `test/*.test.mjs`.
  The parser tests on saved pages of the site need the pages, which are not in the repository: put the folder in `ATN_SAMPLES` (or in `test/samples`). Without them those checks are skipped.
- `test/run_scan_test.py` starts Firefox with a staged copy of the add-on against `test/fake_site.py`, a fake review log with
  history paging, 404s, redirects and server errors. The fake site also tells what a complete walk should find, and the driver
  compares the stored cells with it.
- `test/package.py` builds `dist/atn-review-analyzer.xpi`.
