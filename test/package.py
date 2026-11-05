#!/usr/bin/env python3
"""Builds dist/atn-review-analyzer.xpi from the shipped files (no test folder). The name has no version, so a reload finds the same file.

Usage: python3 test/package.py [output.xpi]
"""
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# everything that ends up in the add-on, in its folders. The test folder, the dist folder and the notes are not shipped.
SHIPPED = [
    "manifest.json", "background.js", "content.js", "README.md",
    "lib/anon.js", "lib/chart.js", "lib/db.js", "lib/facts.js", "lib/parser.js", "lib/queue.js", "lib/reviewdom.js", "lib/reviewpage.js", "lib/surface.js", "lib/tracker.js",
    "lib/transfer.js", "lib/util.js",
    "assets/common.css",
    "popup/popup.html", "popup/popup.css", "popup/popup.js",
    "analysis/analysis.html", "analysis/analysis.css", "analysis/analysis.js",
    "import/import.html", "import/import.css", "import/import.js",
    "icons/icon.svg",
]


def build(out):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name in SHIPPED:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))  # fixed date, reproducible output
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(os.path.join(ROOT, name), "rb") as f:
                z.writestr(info, f.read())


if __name__ == "__main__":
    manifest = json.load(open(os.path.join(ROOT, "manifest.json")))
    target = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(ROOT, "dist", "atn-review-analyzer.xpi")
    build(target)
    print(f"{target} ({manifest['name']} {manifest['version']})")
