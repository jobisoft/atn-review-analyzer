#!/usr/bin/env python3
"""Fake review log for the scan tests. Same markup as the real pages, synthetic data.

  GET /en-US/reviewers/reviewlog?start=&end=&page=N        the log page (50 events per page)
  GET /en-US/reviewers/review/<slug>?page=N                the review page of an add-on: versions newest first, 10 per page
  GET /other                                               a page that is not the log
  GET /ctl?...                                             change the behaviour, see CONTROLS
  GET /ctl?expect=1                                        what the add-on should have stored for every event (the oracle)
  POST /report                                             the test driver delivers its results here

The oracle knows the whole history of every add-on, so the facts it computes (submission, wait, queue) are what a complete
walk through the history must find.
"""
import datetime
import html
import json
import re
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = 8770
LOG_PAGE_SIZE = 50
HISTORY_PAGE_SIZE = 10
MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."]
EVENTS = ["Approved", "Rejected", "More information requested", "Approved"]
REVIEWERS = ["John Bieling", "Jess", "John Bieling"]
COMMENTS = [
    "Thank you for your contribution.",
    "Thank you for your submission.\n\n1) Needs <b>work</b> & \"quotes\"\n2) second point",
    "=HYPERLINK(\"http://example.invalid\")",
]
CONTROLS = """
  reset=1&n=230          new log with n events, newest 2026-11-03 23:31, one every 37 minutes
  delay=ms               every log page answers this late
  fail=PAGE              the log page PAGE answers 500
  logout=0|1             the log answers with a login page
  add=K                  K new events at the top of the log
  addev=SLUG:EVENT       one new event of an add-on, with the given event
  unlisted=1 noslug=1    one new row of an unlisted version / of an add-on without a slug
  newer=SLUG:N           N versions that are newer than all others (the others move to later history pages)
  older=SLUG:N           N versions that are older than all others, each with an approval in 2019
  wait=SLUG:VERSION:KIND a version waits in the review queue (KIND new or update), unwait=SLUG:VERSION takes it out,
                         decide=SLUG:VERSION:EVENT gives it an entry in the log (Approved or Rejected also takes it out of the queue), qfail=1 makes the queue pages answer 500
  rfail=SLUG|none        the review page answers 404 (none: clears)
  rerr=SLUG|none         the review page answers 500
  redirect=SLUG|none     the review page redirects to the review queue
  file=SLUG:MODE         manifest.json of every version of SLUG (none: clears):
                         experiment, plain, legacy (no manifest.json, an install.rdf instead), nomanifest or 404 (HTTP 404 for both), 500 (HTTP 500), page (a web page instead of the file).
                         Without a control addon-K is an Experiment if K is divisible by 3, and every other add-on is plain.
"""

state = {}
reports = []
lock = threading.Lock()


def fmt_date(d):
    h = d.hour % 12 or 12
    ap = "a.m." if d.hour < 12 else "p.m."
    if d.hour == 0 and d.minute == 0:
        t = "midnight"
    elif d.hour == 12 and d.minute == 0:
        t = "noon"
    elif d.minute == 0:
        t = f"{h} {ap}"
    else:
        t = f"{h}:{d.minute:02d} {ap}"
    return f"{MONTHS[d.month - 1]} {d.day}, {d.year}, {t}"


def day_text(d):
    return f"{MONTHS[d.month - 1]} {d.day}, {d.year}"


def iso(d):
    return d.strftime("%Y-%m-%dT%H:%M:00")


def make_entry(i, when, unlisted=False, noslug=False, slug=None, event=None, version=None):
    return {
        "unlisted": unlisted,
        "when": when,
        "addonid": 900000 + (i * 7) % 1000,
        "name": f"Add-on {i % 40}",
        "slug": slug or ("None" if noslug else f"addon-{i % 40}"),
        "version": version or f"1.{i % 9}.{i}",
        "event": event or EVENTS[i % len(EVENTS)],
        "reviewer": REVIEWERS[i % len(REVIEWERS)],
        "comment": COMMENTS[i % len(COMMENTS)],
        # how the developer rows of the version look: none, one, or two (the second one 20 minutes after the first)
        "dev": "none" if i % 11 == 0 else "double" if i % 5 == 0 else "single",
        # the submission is this long before the event
        "offset": 30 + (i % 7) * 1111,
    }


def reset(n=230):
    base = datetime.datetime(2026, 11, 3, 23, 31)
    state.clear()
    state.update(
        entries=[make_entry(i, base - datetime.timedelta(minutes=37 * i)) for i in range(n)],
        counter=n, delay=0, fail=0, logout=False, hits=[], rhits=[], rfail=set(), rerr=set(), redirect=set(), extra={}, xpi={}, fhits=[], files={}, waiting=[], qfail=False,
    )


def newest_time():
    return state["entries"][0]["when"] + datetime.timedelta(minutes=41)


def add_waiting(slug, version, kind):
    """A version that waits in the review queue: it has a submission and no decision."""
    state["waiting"] = [w for w in state["waiting"] if (w["slug"], w["version"]) != (slug, version)]
    state["waiting"].append({
        "slug": slug, "version": version, "kind": kind, "name": f"Waiting {slug}", "addonid": 700000 + zlib.crc32(slug.encode()) % 100000,
        "when": datetime.datetime(2026, 11, 3, 9, 0), "offset": 120, "dev": "single", "event": None, "reviewer": "", "comment": "", "unlisted": False,
    })


def add_event(**kw):
    state["entries"].insert(0, make_entry(state["counter"], newest_time(), **kw))
    state["counter"] += 1


def add_extra(slug, side, n):
    """Versions that are not in the log. `newer` ones are after everything, `older` ones came first and were approved in 2019."""
    extra = state["extra"].setdefault(slug, [])
    base = datetime.datetime(2027, 1, 1)
    for k in range(n):
        if side == "newer":
            when = base + datetime.timedelta(days=k)
            version = f"99.{k}"
        else:
            when = datetime.datetime(2019, 1, 1, 12, 0) + datetime.timedelta(days=k)
            version = f"0.{k}"
        extra.append({
            "unlisted": False, "when": when, "version": version, "event": "Approved", "reviewer": "Jess",
            "comment": "old", "dev": "single", "offset": 120, "slug": slug,
        })


def versions_of(slug):
    """All versions of an add-on, newest first: the events of the log and the extra versions."""
    own = [e for e in state["entries"] if e["slug"] == slug and not e.get("unlisted")]
    logged = {e["version"] for e in own}
    waiting = [w for w in state["waiting"] if w["slug"] == slug and w["version"] not in logged]  # a version of the log is listed once
    return sorted(own + state["extra"].get(slug, []) + waiting, key=lambda e: e["when"], reverse=True)


def submission_of(v):
    """(submission time, 'time' | 'day') as the add-on should find it."""
    sub = v["when"] - datetime.timedelta(minutes=v["offset"])
    if v["dev"] == "none":
        return datetime.datetime(sub.year, sub.month, sub.day), "day"
    return sub, "time"


def xpi_mode(slug):
    """What the file of a version of this add-on is."""
    if slug in state["xpi"]:
        return state["xpi"][slug]
    match = re.fullmatch(r"addon-(\d+)", slug)
    return "experiment" if match and int(match.group(1)) % 3 == 0 else "plain"


def file_id(slug, version):
    return 1000000 + zlib.crc32(f"{slug}\u001f{version}".encode()) % 9000000


def manifest_text(mode):
    """The manifest.json of a file of this mode."""
    manifest = {"manifest_version": 2, "name": "x", "version": "1.0"}
    if mode == "experiment":
        manifest["experiment_apis"] = {"demo": {"schema": "schema.json", "parent": {"scopes": ["addon_parent"], "paths": [["demo"]], "script": "api.js"}}}
    return json.dumps(manifest, indent=2)


def expected():
    """What the add-on should have stored for every event of the log."""
    out = []
    for e in state["entries"]:
        if e.get("unlisted") or e["slug"] == "None":
            continue
        slug = e["slug"]
        mode = "gone" if slug in state["rfail"] else "redirect" if slug in state["redirect"] else "error" if slug in state["rerr"] else "ok"
        item = {"slug": slug, "version": e["version"], "event": e["event"], "date": iso(e["when"]), "mode": mode}
        if mode in ("ok",):
            sub, _ = submission_of(e)
            item["tSubmission"] = iso(sub)
            item["tWait"] = round((e["when"] - sub).total_seconds() / 86400, 2)
            approved = [v["when"] for v in versions_of(slug) if v["event"] == "Approved"]
            item["queue"] = "update" if any(a < e["when"] for a in approved) else "new"  # every event of a version has the queue of the version
        elif mode == "gone":
            item.update(tSubmission=None, tWait=None, queue="new" if e["event"] == "Rejected" else None)
        else:
            item.update(tSubmission=None, tWait=None, queue=None)
        # the type: a missing key means none is stored (the files are not there, or could not be read), which the scan asks again
        file_mode = xpi_mode(slug)
        if mode == "ok" and file_mode not in ("404", "nomanifest", "500", "page"):
            item["type"] = file_mode if file_mode in ("experiment", "legacy") else "webextension"
        out.append(item)
    for w in state["waiting"]:
        slug = w["slug"]
        if any(e["slug"] == slug and e["version"] == w["version"] for e in state["entries"]):
            continue  # decided or asked about: not waiting any more
        sub, _ = submission_of(w)
        file_mode = xpi_mode(slug)
        out.append({
            "slug": slug, "version": w["version"], "event": "Awaiting Review", "date": None, "mode": "ok", "queue": w["kind"],
            "tSubmission": iso(sub), "tWait": None,
            **({} if file_mode in ("404", "nomanifest", "500", "page") else {"type": file_mode if file_mode in ("experiment", "legacy") else "webextension"}),
        })
    return out


def render_row(e):
    kind = "review-unlisted" if e.get("unlisted") else "review"
    review = f"http://127.0.0.1:{PORT}/en-US/reviewers/{kind}/{e['slug']}"
    return f"""            <tr data-addonid="{e['addonid']}">
              <td>{fmt_date(e['when'])}</td>
              <td>
                <a href="">{html.escape(e['name'])}</a>
                {e['version']}
                <a href="{review}">
                    {e['event']}
                </a>
              </td>
              <td>{html.escape(e['reviewer'])}</td>
              <td>
                <a class="comments show" href="#">Show Comments</a>
                <a class="comments hide" href="#">Hide Comments</a>
              </td>
            </tr>
            <tr class="comments hide">
              <td>&nbsp;</td>
              <td colspan="4">{html.escape(e['comment'])}</td>
            </tr>
            <tr class="hide"><td>{len(e['comment'])}</td></tr>
"""


def render_log(q):
    start = (q.get("start") or [""])[0]
    end = (q.get("end") or [""])[0]
    page = int((q.get("page") or ["1"])[0])
    items = [
        e for e in state["entries"]
        if (not start or e["when"].date().isoformat() >= start) and (not end or e["when"].date().isoformat() <= end)
    ]
    pages = max(1, -(-len(items) // LOG_PAGE_SIZE))
    chunk = items[(page - 1) * LOG_PAGE_SIZE: page * LOG_PAGE_SIZE]
    base = f"http://127.0.0.1:{PORT}/en-US/reviewers/reviewlog?start={start}"
    links = "".join(
        f'<li{" class=\"selected\"" if p == page else ""}><a href="{base}&amp;page={p}">{p}</a></li>'
        for p in range(1, pages + 1)
    )
    nxt = f'<li><a rel="next" href="{base}&amp;page={page + 1}">Next</a></li>' if page < pages else ""
    first = (page - 1) * LOG_PAGE_SIZE + 1 if chunk else 0
    last = first + len(chunk) - 1 if chunk else 0
    rows = "".join(render_row(e) for e in chunk)
    return f"""<!DOCTYPE html>
<html lang="en-US"><head><meta charset="utf-8"><title>Reviewer Tools (fake)</title></head>
<body>
  <div id="log-filter"><form action="/en-US/reviewers/reviewlog" method="get">
    <input type="text" name="start" value="{start}" id="id_start"><input type="text" name="end" value="{end}" id="id_end">
  </form></div>
  <h2>Add-on Review Log</h2>
  <div class="listing results"><div class="results-inner controls">
    <table id="log-listing" class="data-grid">
      <thead><tr class="listing-header"><th>Date</th><th>Event</th><th>Reviewer</th><th>&nbsp;</th></tr></thead>
      <tbody>
{rows}      </tbody>
    </table>
    <div class="listing-footer"><ol class="pagination">{links}{nxt}</ol>
      <div class="num-results">Results <strong>{first}</strong>&ndash;<strong>{last}</strong> of <strong>{len(items):,}</strong></div>
    </div>
  </div></div>
</body></html>"""


def render_version(v):
    """One version of the history. The notes carry markup that must never reach the analysis page."""
    sub = v["when"] - datetime.timedelta(minutes=v["offset"])
    dev_rows = ""
    if v["dev"] in ("single", "double"):
        dev_rows += f'<tr><th></th><td><div>By <a href="/en-US/thunderbird/user/dev/" title="Dev">Dev</a> on {fmt_date(sub)}</div></td></tr>'
    if v["dev"] == "double":
        later = sub + datetime.timedelta(minutes=20)
        dev_rows += f'<tr><th></th><td><div>By <a href="/en-US/thunderbird/user/dev/" title="Dev">Dev</a> on {fmt_date(later)}</div></td></tr>'
    fid = file_id(v["slug"], v["version"])
    state["files"][str(fid)] = (v["slug"], v["version"])
    file_url = f"http://127.0.0.1:{PORT}/thunderbird/downloads/file/{fid}/{v['slug']}-{v['version']}-tb.xpi?src=reviewer"
    file_state = "Awaiting Review" if v["event"] is None else "Rejected" if v["event"] == "Rejected" else "Approved"
    event_row = "" if v["event"] is None else f"""<tr><th>{v['event']}</th><td><div>By <a href="/en-US/thunderbird/user/r/" title="{html.escape(v['reviewer'])}">{html.escape(v['reviewer'])}</a> on {fmt_date(v['when'])}</div><pre class="light history-comment">{html.escape(v['comment'])}</pre></td></tr>"""
    return f"""        <tr class="listing-header">
          <th colspan="2">
            Version {v['version']} &middot; {day_text(sub)} <span class="light">&middot; {v['event'] and 'Approved' or 'Awaiting Review'}</span>
          </th>
        </tr>
        <tr class="listing-body">
          <td class="files">
            <div><strong>Files in this version:</strong></div>
            <ul><li class="file-info">
              <span class="light"><strong><a href="{file_url}" class="reviewers-install" data-type="extensions">All Platforms</a></strong>
              <div>{file_state}</div>
              <a href="/en-US/developers/addon/{v['slug']}/file/{fid}/validation">Validation</a> &middot; <a href="/en-US/thunderbird/files/browse/{fid}/">Contents</a></span></li>
              <li class="bait"><a href="javascript:window.__pwned=1">Bait</a><img src="x" onerror="window.__pwned=1"></li></ul>
          </td>
          <td>
            <table class="activity">
              <tr><th>Notes for Reviewers</th><td class="activity_approval"><div class="history-notes">Please test.<script>window.__pwned=1</script></div></td></tr>
              {dev_rows}
              {event_row}
            </table>
          </td>
        </tr>
"""


def render_review(slug, page):
    versions = versions_of(slug)
    total = len(versions)
    chunk = versions[(page - 1) * HISTORY_PAGE_SIZE: page * HISTORY_PAGE_SIZE]
    paging = ""
    if total > HISTORY_PAGE_SIZE:
        first = (page - 1) * HISTORY_PAGE_SIZE + 1
        last = first + len(chunk) - 1
        newer = f'<li><a rel="next" href="?page={page - 1}#history">Newer</a></li>' if page > 1 else ""
        older = f'<li><a rel="prev" href="?page={page + 1}#history">Older</a></li>' if page * HISTORY_PAGE_SIZE < total else ""
        paging = f'<ol class="pagination">{newer}{older}<li>Results <strong>{first}</strong>&ndash;<strong>{last}</strong> of <strong>{total}</strong></li></ol>'
    blocks = "".join(render_version(v) for v in chunk)
    return f"""<!DOCTYPE html><html><head><title>Review {slug}</title></head><body>
<div id="review-files-header"><h3 id="history">Add-on History</h3><div id="review-files-paginate">{paging}</div></div>
<table id="review-files" class="item-history">
{blocks}</table></body></html>"""


def render_queue(kind):
    """A page of the review queue of new submissions or of updates, with the markup of the real one."""
    waiting = [w for w in state["waiting"] if w["kind"] == kind]
    counts = {k: len([w for w in state["waiting"] if w["kind"] == k]) for k in ("new", "update")}
    rows = "".join(f"""<tr data-addon="{w['addonid']}" class="addon-row" id="addon-{w['addonid']}" data-review-log="">
      <td><div class="addon-locked"></div></td>
      <td><a href="http://127.0.0.1:{PORT}/en-US/reviewers/review/{w['slug']}">{html.escape(w['name'])} <em>{w['version']}</em></a></td>
      <td>Extension</td><td>3 days</td>
      <td><div class="app-icon ed-sprite-webextension" title="WebExtension"></div><div class="app-icon ed-sprite-info" title="More Information Requested"></div></td><td>&nbsp;</td></tr>""" for w in waiting)
    tab = lambda name, label, n: f'<li class="{"selected" if name == kind else ""}"><a href="http://127.0.0.1:{PORT}/en-US/reviewers/queue/{name}">{label} ({n})</a></li>'
    return f"""<!DOCTYPE html><html><head><title>Queue</title></head><body>
<ul class="tabnav">{tab("new", "New", counts["new"])}{tab("updates", "Updates", counts["update"])}</ul>
<div class="queue-outer"><table id="addon-queue" class="data-grid"><thead><tr class="listing-header"><th>&nbsp;</th><th>Add-on</th></tr></thead><tbody>{rows}</tbody></table></div></body></html>"""


def control(q):
    if "reset" in q:
        reset(int((q.get("n") or ["230"])[0]))
    if "delay" in q:
        state["delay"] = int(q["delay"][0])
    if "fail" in q:
        state["fail"] = int(q["fail"][0])
    if "logout" in q:
        state["logout"] = q["logout"][0] == "1"
    for key in ("rfail", "rerr", "redirect"):
        if key in q:
            state[key].clear() if q[key][0] == "none" else state[key].add(q[key][0])
    if "qfail" in q:
        state["qfail"] = q["qfail"][0] == "1"
    for spec in q.get("wait", []):
        slug, version, kind = spec.split(":")
        add_waiting(slug, version, kind)
    for spec in q.get("unwait", []):
        slug, version = spec.split(":")
        state["waiting"] = [w for w in state["waiting"] if (w["slug"], w["version"]) != (slug, version)]
    for spec in q.get("decide", []):  # a waiting version gets an entry in the log (the version stays the same)
        slug, version, event = spec.split(":")
        state["entries"].insert(0, make_entry(state["counter"], newest_time(), slug=slug, event=event, version=version))
        state["counter"] += 1
        if event in ("Approved", "Rejected"):  # decided: it leaves the queue. An information request keeps it in the queue
            state["waiting"] = [w for w in state["waiting"] if (w["slug"], w["version"]) != (slug, version)]
    for spec in q.get("file", []):
        slug, _, mode = spec.partition(":")
        if mode == "none":
            state["xpi"].pop(slug, None)
        else:
            state["xpi"][slug] = mode
    if "unlisted" in q:
        add_event(unlisted=True)
    if "noslug" in q:
        add_event(noslug=True)
    if "add" in q:
        for _ in range(int(q["add"][0])):
            add_event()
    for spec in q.get("addev", []):
        slug, event = spec.split(":", 1)
        add_event(slug=slug, event=event)
    for side in ("newer", "older"):
        if side in q:
            slug, n = q[side][0].split(":")
            add_extra(slug, side, int(n))


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body, ctype="text/html; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the test closed or navigated the tab while the page was still being sent

    def reply_bytes(self, code, data, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        with lock:
            if u.path == "/ctl":
                control(q)
                if "expect" in q:
                    return self.reply(200, json.dumps(expected()), "application/json")
                return self.reply(200, json.dumps({"entries": len(state["entries"]), "hits": state["hits"], "rhits": state["rhits"], "fhits": state["fhits"]}), "application/json")
            if "/reviewers/review/" in u.path:
                slug = u.path.rsplit("/", 1)[1]
                page = int((q.get("page") or ["1"])[0])
                state["rhits"].append(f"{slug}#{page}")
                if slug in state["redirect"]:
                    self.send_response(302)
                    self.send_header("Location", "/en-US/reviewers/queue/updates")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if slug in state["rfail"]:
                    return self.reply(404, "no such add-on")
                if slug in state["rerr"]:
                    return self.reply(500, "boom")
                return self.reply(200, render_review(slug, page))
            if u.path.endswith("/reviewers/queue/new") or u.path.endswith("/reviewers/queue/updates"):
                kind = "new" if u.path.endswith("/new") else "update"
                if state["qfail"]:
                    return self.reply(500, "boom")
                return self.reply(200, render_queue(kind))
            if "/thunderbird/files/browse/" in u.path:
                rest = u.path.split("/files/browse/", 1)[1].split("/")
                fid = rest[0]
                slug, version = state["files"].get(fid, (None, None))
                kind = rest[1] if len(rest) > 1 else ""
                name = rest[2] if len(rest) > 2 else "manifest.json"  # the raw file: manifest.json, or install.rdf of a legacy add-on
                if slug is None:
                    return self.reply(404, "no such file")
                mode = xpi_mode(slug)
                if kind == "file-redirect":
                    state["fhits"].append(f"{slug}@{version}")
                    if mode == "500":
                        return self.reply(500, "boom")
                    if mode in ("404", "nomanifest") or (mode == "legacy") != (name == "install.rdf"):
                        return self.reply(404, "no such file")
                    self.send_response(302)
                    self.send_header("Location", f"/en-US/thunderbird/files/browse/{fid}/file-serve/{name}?token=abc")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if kind == "file-serve":
                    if mode == "page":
                        return self.reply(200, "<!DOCTYPE html><title>Log in</title><p>Please log in.</p>")
                    if mode == "legacy":
                        return self.reply(200, '<?xml version="1.0"?>\n<RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></RDF>', "application/octet-stream")
                    return self.reply(200, manifest_text(mode), "application/octet-stream")
                return self.reply(404, "not found")
            if u.path.endswith("/reviewers/queue/updates"):
                return self.reply(200, "<!DOCTYPE html><title>Updates queue</title><p>Queue.</p>")
            if u.path == "/other":
                return self.reply(200, "<!DOCTYPE html><title>other</title><p>Not the log.</p>")
            if u.path.endswith("/reviewers/reviewlog"):
                page = int((q.get("page") or ["1"])[0])
                state["hits"].append(page)
                delay, fail, logout = state["delay"], state["fail"], state["logout"]
                if logout:
                    return self.reply(200, "<!DOCTYPE html><title>Log in</title><p>Please log in.</p>")
                if fail and page == fail:
                    return self.reply(500, "boom")
                body = render_log(q)
            else:
                return self.reply(404, "not found")
        if delay:
            threading.Event().wait(delay / 1000)
        self.reply(200, body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        data = json.loads(self.rfile.read(length) or b"{}")
        with lock:
            reports.append(data)
        print("[report]", json.dumps(data)[:300], flush=True)
        self.reply(200, "{}", "application/json")

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, *args):
        pass


def serve():
    reset()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


if __name__ == "__main__":
    serve()
    threading.Event().wait()
