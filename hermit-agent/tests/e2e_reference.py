"""Phase 1 exit criterion: a real model completes the three reference tasks (data
processing, code + tests, calculation) in the built app under risk-based supervision.

    ../benchmark/.venv/bin/python tests/e2e_reference.py --base-url http://localhost:8080/v1

Drives dist/hermit-agent-standalone.html like a user would: uploads the task's files,
starts the task, approves held steps (each one is logged with its reasons), answers
`ask:` questions with "Use your best judgement.", and checks the result inside the
same interpreter (or against the final answer). The tasks are the spike's
(spike/agent_loop.py). A real model run takes minutes per task — launch it detached
and watch the log.
"""
import argparse
import json
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(line_buffering=True)
ROOT = pathlib.Path(__file__).resolve().parent.parent
APP_URL = (ROOT / "dist" / "hermit-agent-standalone.html").as_uri()

SALES_CSV = """date,region,amount
2026-01-03,north,120.50
2026-01-17,south,80
03/01/2026,north,
2026-02-02,south,200.25
2026-02-14,north,n/a
2026-02-28,east,99.75
2026-03-05,north,310
15.03.2026,east,40
2026-03-20,south,
"""

TASKS = [
    {
        "name": "data processing",
        "files": {"sales.csv": SALES_CSV},
        "prompt": "sales.csv has messy rows. Drop rows whose amount is missing or not a number. Dates come in several formats (ISO, DD/MM/YYYY, DD.MM.YYYY). Write monthly_totals.csv with columns month,total where month is YYYY-MM, sorted by month, and tell me the totals.",
        "check": """
import csv
rows = {r["month"]: round(float(r["total"]), 2) for r in csv.DictReader(open("/workspace/monthly_totals.csv"))}
assert rows == {"2026-01": 200.5, "2026-02": 300.0, "2026-03": 350.0}, rows
print("CHECK OK")
""",
    },
    {
        "name": "code + tests",
        "files": {},
        "prompt": "Write roman.py with to_roman(n) and from_roman(s) for 1..3999 (from_roman must raise ValueError on invalid numerals), plus test_roman.py with unittest tests. Run the tests and report the result.",
        "check": """
import importlib, sys
sys.modules.pop("roman", None)
import roman
assert roman.to_roman(1994) == "MCMXCIV" and roman.to_roman(3999) == "MMMCMXCIX"
assert all(roman.from_roman(roman.to_roman(i)) == i for i in range(1, 4000))
for bad in ["IIII", "IC", "MMMM", "ABC", ""]:
    try:
        roman.from_roman(bad)
        raise AssertionError("accepted " + repr(bad))
    except ValueError:
        pass
import os
assert os.path.exists("/workspace/test_roman.py")
print("CHECK OK")
""",
    },
    {
        "name": "calculation",
        "files": {},
        "prompt": "What is the sum of all primes below 2,000,000? Compute it, don't recall it.",
        "answer_contains": "142913828922",
    },
]


def ev(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)


def run_task(page, task, deadline_s):
    page.click("#newSessionBtn")
    if page.locator("#confirmModal.active").count():
        page.click("#confirmOk")
    while ev(page, "() => PY.state") != "idle":
        time.sleep(0.3)
    if task["files"]:
        page.set_input_files("#wsFileInput", files=[{"name": n, "mimeType": "text/plain", "buffer": c.encode()} for n, c in task["files"].items()])
        while ev(page, "() => WS.files.size") < len(task["files"]):
            time.sleep(0.2)
    page.fill("#taskInput", task["prompt"])
    page.click("#sendBtn")
    t0 = time.time()
    seen = 0
    approvals = []
    while time.time() - t0 < deadline_s:
        info = ev(page, """() => ({ status: S.status, steps: S.timeline.filter(t => t.type === 'step' && t.phase === 'done').map(t => ({
            n: t.n, kind: t.kind, status: t.status, decision: t.decision, out: (t.output || '').slice(-160), content: t.content })) })""")
        for s in info["steps"][seen:]:
            print(f"    step {s['n']}: {s['kind']:6} {s['status'] or '':9} {s['decision'] or '':10} {s['out'].strip()[-100:]!r}")
        seen = len(info["steps"])
        st = info["status"]
        if st == "awaiting-approval":
            reasons = ev(page, "() => { const t = S.timeline[S.timeline.length - 1]; return t.risk ? t.risk.reasons : []; }")
            print(f"    ⚠️  held: {'; '.join(reasons)} → approving")
            approvals.append(reasons)
            page.locator(".step-card.phase-pending-approval [data-action=approve]").click()
        elif st == "awaiting-user":
            q = ev(page, "() => S.timeline[S.timeline.length - 1].question")
            print(f"    ❓ {q!r} → answering")
            page.fill("#taskInput", "Use your best judgement.")
            page.click("#sendBtn")
        elif st in ("done", "error", "paused", "stopped"):
            break
        time.sleep(1)
    elapsed = time.time() - t0
    status = ev(page, "() => S.status")
    answer = ev(page, "() => { const t = S.timeline.filter(t => t.type === 'step').pop(); return t ? t.content : ''; }") or ""
    steps = ev(page, "() => S.stepCount")
    tokens = ev(page, "() => S.tokens")
    if status != "done":
        return {"name": task["name"], "passed": False, "detail": f"ended in state {status}", "steps": steps, "secs": elapsed, "approvals": approvals}
    if "check" in task:
        r = ev(page, "async (c) => { const r = await runInWorker(c, { timeoutMs: 60000 }); return r.output; }", task["check"])
        passed = "CHECK OK" in r
        detail = "" if passed else r[-600:]
    else:
        passed = task["answer_contains"] in answer.replace(",", "").replace(" ", "")
        detail = "" if passed else "answer: " + answer[-300:]
    return {"name": task["name"], "passed": passed, "detail": detail, "steps": steps, "secs": round(elapsed), "tokens": tokens, "approvals": approvals, "answer": answer[-400:]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:8080/v1")
    ap.add_argument("--model", default="")
    ap.add_argument("--browser", default="chromium")
    ap.add_argument("--effort", default="low")
    ap.add_argument("--deadline", type=int, default=1200, help="seconds per task")
    ap.add_argument("--only", default="", help="substring of a task name")
    args = ap.parse_args()
    results = []
    with sync_playwright() as pw:
        browser = getattr(pw, args.browser).launch()
        page = browser.new_page()
        page.on("pageerror", lambda e: print("  [pageerror]", e))
        page.goto(APP_URL)
        while ev(page, "() => PY.state") != "idle":
            time.sleep(0.3)
        page.click("#settingsBtn")
        page.fill("#settingUrl", args.base_url)
        page.fill("#settingModelInput", args.model)
        page.click("#settingSave")
        page.select_option("#effortSelect", args.effort)
        page.select_option("#autonomySelect", "risk")
        for task in TASKS:
            if args.only and args.only not in task["name"]:
                continue
            print(f"▶ {task['name']} …")
            r = run_task(page, task, args.deadline)
            print(f"  {'✅' if r['passed'] else '❌'} {task['name']}: {r['steps']} steps, {r['secs']} s {r.get('detail', '')}")
            results.append(r)
        browser.close()
    print("\n" + json.dumps(results, indent=1))
    sys.exit(0 if results and all(r["passed"] for r in results) else 1)


if __name__ == "__main__":
    main()
