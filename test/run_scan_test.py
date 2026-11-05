#!/usr/bin/env python3
"""Loads a staged copy of the add-on into a throwaway Firefox profile and drives it against fake_site.py.

The staged copy differs from the shipped add-on in these ways, all done here and never in the sources:
  - manifest: host permission and content script match for http://127.0.0.1:8770
  - background.js: opens the driver page once, when the add-on is installed (Marionette may not navigate to moz-extension URLs)
  - driver.html/js: the test driver
Usage: python3 test/run_scan_test.py [--visible]
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import fake_site  # noqa: E402
from package import SHIPPED  # noqa: E402  the files of the add-on, the same as in the XPI

FIREFOX = shutil.which("firefox") or "/usr/bin/firefox"
MARIONETTE_PORT = 2840
DRIVER = os.environ.get("DRIVER", "driver.js")  # another driver script, for example the upgrade benchmark
UUID = "5c1f0b0e-1a2b-4c3d-8e4f-0123456789ab"
ADDON_ID = "reviewlog-collector@local.test"


class Marionette:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=60)
        self.buf = b""
        self.n = 0
        self.recv()

    def recv(self):
        while b":" not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk
        head, rest = self.buf.split(b":", 1)
        length = int(head)
        while len(rest) < length:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("closed")
            rest += chunk
        self.buf = rest[length:]
        return json.loads(rest[:length].decode())

    def call(self, name, params=None):
        self.n += 1
        body = json.dumps([0, self.n, name, params or {}]).encode()
        self.sock.sendall(str(len(body)).encode() + b":" + body)
        while True:
            msg = self.recv()
            if msg[0] == 1 and msg[1] == self.n:
                if msg[2]:
                    raise RuntimeError(f"{name}: {msg[2]}")
                return msg[3]


def stage(dest):
    for name in SHIPPED:
        p = os.path.join(ROOT, name)
        if os.path.exists(p):
            os.makedirs(os.path.dirname(os.path.join(dest, name)), exist_ok=True)
            shutil.copy(p, os.path.join(dest, name))
    shutil.copy(os.path.join(HERE, "driver.html"), dest)
    shutil.copy(os.path.join(HERE, DRIVER), os.path.join(dest, "driver.js"))
    if os.environ.get("BENCH_DATA"):
        shutil.copy(os.environ["BENCH_DATA"], os.path.join(dest, "bench.json"))

    mf_path = os.path.join(dest, "manifest.json")
    mf = json.load(open(mf_path))
    mf["host_permissions"].append("http://127.0.0.1/*")
    mf["content_scripts"][0]["matches"].append("http://127.0.0.1/*/reviewers/reviewlog*")
    json.dump(mf, open(mf_path, "w"), indent=2)

    with open(os.path.join(dest, "background.js"), "a") as f:
        # once, when the add-on is installed. The event page may be unloaded and loaded again during a long scan, that must not open a second driver
        f.write('\nbrowser.runtime.onInstalled.addListener(() => browser.tabs.create({ url: browser.runtime.getURL("driver.html") }));\n')


def main():
    visible = "--visible" in sys.argv
    # the snap Firefox can only read the home folder, not /tmp
    work = tempfile.mkdtemp(prefix="work-", dir=HERE)
    addon, profile = os.path.join(work, "addon"), os.path.join(work, "profile")
    os.makedirs(addon)
    os.makedirs(profile)
    stage(addon)
    with open(os.path.join(profile, "user.js"), "w") as f:
        f.write(f'user_pref("marionette.port", {MARIONETTE_PORT});\n')
        f.write('user_pref("extensions.autoDisableScopes", 0);\n')
        downloads = os.path.join(work, "downloads")
        os.makedirs(downloads)
        f.write('user_pref("browser.download.folderList", 2);\n')  # the export button of the popup saves a file
        f.write('user_pref("browser.download.dir", %s);\n' % json.dumps(downloads))
        f.write('user_pref("browser.download.useDownloadDir", true);\n')
        f.write('user_pref("app.update.enabled", false);\n')
        f.write('user_pref("datareporting.policy.dataSubmissionEnabled", false);\n')
        f.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        f.write('user_pref("browser.startup.homepage_override.mstone", "ignore");\n')
        f.write('user_pref("extensions.webextensions.uuids", %s);\n' % json.dumps(json.dumps({ADDON_ID: UUID})))

    fake_site.reset()
    srv = fake_site.serve()
    env = dict(os.environ)
    env["MOZ_REMOTE_ALLOW_SYSTEM_ACCESS"] = "1"  # needed for the parent process screenshot
    if not visible:
        env["MOZ_HEADLESS"] = "1"
    log = open(os.path.join(work, "firefox.log"), "wb")
    proc = subprocess.Popen([FIREFOX, "-profile", profile, "-no-remote", "-marionette", "about:blank"],
                            env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    m = None
    result = None
    try:
        for _ in range(60):
            try:
                m = Marionette(MARIONETTE_PORT)
                break
            except OSError:
                time.sleep(1)
        if m is None:
            sys.exit("Marionette did not come up")
        m.call("WebDriver:NewSession", {"capabilities": {}})
        print("installed", m.call("Addon:Install", {"path": addon, "temporary": True}))
        time.sleep(3)
        m.call("Marionette:SetContext", {"value": "content"})
        for handle in m.call("WebDriver:GetWindowHandles"):
            m.call("WebDriver:SwitchToWindow", {"handle": handle})
            if m.call("WebDriver:GetCurrentURL").get("value", "").endswith("driver.html"):
                break

        t0 = time.time()
        while time.time() - t0 < 1500:
            done = [r for r in fake_site.reports if r.get("type") == "finished"]
            if done:
                result = done[0]
                break
            time.sleep(1)

        shot = os.path.join(work, "screenshot.png")
        try:
            # extension pages refuse WebDriver:TakeScreenshot, so the parent process draws the snapshot
            import base64
            m.call("Marionette:SetContext", {"value": "chrome"})
            script = """return (async () => {
              const win = Services.wm.getMostRecentWindow("navigator:browser");
              const tab = win.gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec.endsWith("driver.html"));
              win.gBrowser.selectedTab = tab;
              await new Promise((r) => win.setTimeout(r, 500));
              const bc = tab.linkedBrowser.browsingContext;
              const bmp = await bc.currentWindowGlobal.drawSnapshot(null, 1, "white");
              const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
              canvas.width = bmp.width; canvas.height = bmp.height;
              canvas.getContext("2d").drawImage(bmp, 0, 0);
              return canvas.toDataURL("image/png");
            })();"""
            data = m.call("WebDriver:ExecuteScript", {"script": script, "args": []})
            open(shot, "wb").write(base64.b64decode(data["value"].split(",", 1)[1]))
            print("screenshot", shot)
        except Exception as e:  # noqa: BLE001
            print("no screenshot:", str(e)[:300])
    finally:
        # the snap Firefox cannot be signalled from here, so it is quit through Marionette
        try:
            if m is not None:
                m.call("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:  # noqa: BLE001
            pass
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            print("test Firefox did not exit")
        srv.shutdown()

    if not result:
        print("no result reported")
        sys.exit(2)
    bad = [c for c in result["checks"] if not c["ok"]]
    shot = os.path.join(work, "screenshot.png")
    if os.path.exists(shot):
        shutil.copy(shot, os.path.join(HERE, "last-screenshot.png"))
    if not bad and not result.get("error"):
        shutil.rmtree(work, ignore_errors=True)  # keep the work dir only when something failed
    else:
        print("work dir kept:", work)
    for c in result["checks"]:
        print(("ok   " if c["ok"] else "FAIL ") + c["name"] + ("  " + c["detail"] if not c["ok"] else ""))
    if result.get("error"):
        print("driver error:", result["error"])
    print(f"{len(result['checks']) - len(bad)} passed, {len(bad)} failed")
    sys.exit(1 if bad or result.get("error") else 0)


if __name__ == "__main__":
    main()
