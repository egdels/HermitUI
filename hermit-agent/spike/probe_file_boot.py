"""Throwaway spike: open build/pyodide-standalone.html from file:// and report (DESIGN §8).

    ../../benchmark/.venv/bin/python probe_file_boot.py [chromium] [firefox] [firefox=/path/to/firefox]

Plain "firefox" is Playwright's patched build; "firefox=<binary>" drives a stock
Firefox (tarball from ftp.mozilla.org) over WebDriver BiDi.
"""
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(line_buffering=True)

HERE = pathlib.Path(__file__).resolve().parent


def main():
    page_url = (HERE / "build" / "pyodide-standalone.html").as_uri()
    browsers = sys.argv[1:] or ["chromium", "firefox"]
    with sync_playwright() as pw:
        for name in browsers:
            name, _, exe = name.partition("=")
            print(f"== {name} {exe}: loading {page_url} …")
            if exe:
                browser = pw.firefox.launch(channel="moz-firefox", executable_path=exe)
            else:
                browser = getattr(pw, name).launch()
            page = browser.new_page()
            page.on("console", lambda m: print(f"   [console.{m.type}] {m.text[:300]}"))
            page.on("pageerror", lambda e: print(f"   [pageerror] {e}"))
            page.goto(page_url)
            page.wait_for_function("window.__RESULT__", timeout=300_000)
            print(json.dumps(page.evaluate("window.__RESULT__"), indent=2))
            browser.close()


if __name__ == "__main__":
    main()
