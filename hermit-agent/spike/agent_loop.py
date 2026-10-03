"""Throwaway spike: the code-as-action agent loop (DESIGN §5) against a real model.

The loop runs here in Python. Each step's code runs in Pyodide inside a Blob worker
in headless Chromium (runner.html, served from 127.0.0.1), which is the runtime the real app will use. This
covers the three Phase 1 reference task types (data processing, code plus tests,
calculation) and checks each result automatically. There is no supervision UI,
gating or export; that is Phase 1 proper.

    ../../benchmark/.venv/bin/python agent_loop.py --base-url http://localhost:8080/v1
"""
import argparse
import functools
import http.server
import json
import pathlib
import re
import sys
import threading
import time
import urllib.request

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(line_buffering=True)

HERE = pathlib.Path(__file__).resolve().parent

# DESIGN §5.3: environment, response format (§5.1) and rules.
SYSTEM_PROMPT = """You are an agent that solves tasks by writing and running Python code.

Environment: Pyodide (CPython compiled to WebAssembly) running in a browser.
- The working directory is /workspace. Files the user gave you are there.
- The standard library is available. numpy, pandas and matplotlib are loaded automatically when you import them. There is no pip and no network access. input() does not work.
- Variables persist between your steps.

Every reply must be exactly ONE of:
1. Short reasoning, then exactly ONE ```python code block. It is executed and you get its output back in an <observation> message. Write nothing after the code block.
2. The final answer for the user, with NO code block, once the task is complete.
3. A line starting with "ask:" if you cannot continue without information from the user.

Rules:
- Inspect files before you modify them.
- Print short summaries, not whole files.
- Save deliverables as files in /workspace.
- Take one step at a time: you only see a step's output in the next turn."""

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

# Each task: workspace seed files (origin "user"), the prompt, and a check that
# runs in the same worker after the task (or against the final answer).
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
import importlib, roman
importlib.reload(roman)
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

CODE_RE = re.compile(r"```(?:python|py)?[ \t]*\n(.*?)```", re.S)


def parse_reply(text):
    """DESIGN §5.1: ('code', code, n_blocks) | ('ask', text) | ('final', text) | ('broken', reason)."""
    blocks = CODE_RE.findall(text)
    if blocks:
        return ("code", blocks[0], len(blocks))
    if re.search(r"```(?:python|py)", text):
        return ("broken", "unclosed code block")
    m = re.search(r"^\s*ask:\s*(.+)", text, re.M | re.I)
    if m:
        return ("ask", m.group(1).strip())
    return ("final", text.strip())


def truncate(s, head=2048, tail=4096):
    """DESIGN §5.2: first 2 KB + last 4 KB."""
    if len(s) <= head + tail:
        return s
    return f"{s[:head]}\n[… {(len(s) - head - tail) // 1024} KB omitted …]\n{s[-tail:]}"


def observation(step, r, note=""):
    files = "  ".join(r["changes"]) or "(none)"
    body = truncate(r["output"]) or "(no output)"
    if note:
        body = note + "\n" + body
    return f'<observation step="{step}" status="{r["status"]}">\n{body}\nfiles changed: {files}\n</observation>'


def chat(base_url, model, messages, max_tokens):
    body = {"messages": messages, "max_tokens": max_tokens}
    if model:
        body["model"] = model
    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=900) as resp:
        data = json.load(resp)
    msg = data["choices"][0]["message"]
    return msg.get("content") or "", msg.get("reasoning_content") or "", data.get("usage", {})


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def indent(s, prefix="    │ "):
    return "\n".join(prefix + line for line in s.splitlines()) or prefix


def run_task(page, args, task):
    page.reload()
    page.evaluate("f => seedFiles(f)", task["files"])
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": task["prompt"]}]
    stats = {"steps": 0, "errors": 0, "tokens": 0, "llm_s": 0.0, "run_s": 0.0}
    final = None
    for step in range(1, args.max_steps + 1):
        print(f"  step {step}: asking model …")
        t0 = time.time()
        content, reasoning, usage = chat(args.base_url, args.model, messages, args.max_tokens)
        stats["llm_s"] += time.time() - t0
        stats["tokens"] += usage.get("completion_tokens", 0)
        if reasoning:
            print(f"    reasoning: {len(reasoning)} chars")
        messages.append({"role": "assistant", "content": content})
        kind, *rest = parse_reply(content)
        if kind in ("final", "ask"):
            print(f"  {kind}:\n{indent(rest[0])}")
            final = (kind, rest[0])
            break
        stats["steps"] += 1
        if kind == "broken":
            print(f"    broken reply: {rest[0]}")
            r = {"status": "error", "output": "Your reply had an unclosed code block; nothing was run.", "changes": []}
            messages.append({"role": "user", "content": observation(step, r)})
            continue
        code, n_blocks = rest
        print(f"    code:\n{indent(code.rstrip())}")
        t0 = time.time()
        r = page.evaluate("([c, t]) => runStep(c, t)", [code, args.step_timeout * 1000])
        stats["run_s"] += time.time() - t0
        if r["status"] != "ok":
            stats["errors"] += 1
        for n in r["notes"]:
            print(f"    [harness] {n}")
        print(f"    → {r['status']}, files: {' '.join(r['changes']) or '-'}\n{indent(truncate(r['output'], 600, 600))}")
        note = f"[Your reply had {n_blocks} code blocks; only the first was run.]" if n_blocks > 1 else ""
        messages.append({"role": "user", "content": observation(step, r, note)})
    else:
        print(f"  step limit ({args.max_steps}) reached")

    if "check" in task:
        r = page.evaluate("([c, t]) => runStep(c, t)", [task["check"], 60000])
        passed = "CHECK OK" in r["output"]
        detail = "" if passed else (r["output"].strip().splitlines() or [r["status"]])[-1]
    else:
        answer = re.sub(r"[,_\s']", "", final[1]) if final else ""
        passed = task["answer_contains"] in answer
        detail = "" if passed else "expected " + task["answer_contains"]
    return passed, detail, stats, final


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default="http://localhost:8080/v1")
    ap.add_argument("--model", default="")
    ap.add_argument("--max-steps", type=int, default=10)
    ap.add_argument("--step-timeout", type=int, default=60, help="seconds per code step")
    ap.add_argument("--max-tokens", type=int, default=8192)
    ap.add_argument("--only", help="run only tasks whose name contains this")
    args = ap.parse_args()

    results = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        page.on("pageerror", lambda e: print(f"    [page error] {e}"))
        page.on("console", lambda m: m.type == "error" and print(f"    [console] {m.text}"))
        # Served over HTTP, not file:// (see the comment in runner.html).
        handler = functools.partial(QuietHandler, directory=str(HERE))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        page.goto(f"http://127.0.0.1:{server.server_port}/runner.html")
        print("booting Pyodide …")
        t0 = time.time()
        r = page.evaluate("runStep('import sys; print(sys.version)', 120000)")
        if r["status"] != "ok":
            sys.exit(f"Pyodide failed to boot: {r['output']}")
        print(f"Pyodide {r['output'].split()[0]} ready in {time.time() - t0:.1f}s")
        for task in TASKS:
            if args.only and args.only not in task["name"]:
                continue
            print(f"\n=== {task['name']} ===\n  task: {task['prompt']}")
            t0 = time.time()
            passed, detail, stats, final = run_task(page, args, task)
            stats["total_s"] = time.time() - t0
            results.append((task["name"], passed, detail, stats, final))
        browser.close()

    print("\n=== summary ===")
    for name, passed, detail, s, final in results:
        end = final[0] if final else "step limit"
        print(f"  {'PASS' if passed else 'FAIL'}  {name:16} {s['steps']} steps ({s['errors']} failed), "
              f"ended: {end}, {s['tokens']} tokens, llm {s['llm_s']:.0f}s, python {s['run_s']:.0f}s, total {s['total_s']:.0f}s {detail}")
    sys.exit(0 if all(r[1] for r in results) else 1)


if __name__ == "__main__":
    main()
