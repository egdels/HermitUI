# HermitUI Agent — Roadmap

Each phase ends with **exit criteria**. Don't start the next phase until they are met,
or until they are consciously waived and the reason is written down here. Section
references (§) point to [DESIGN.md](DESIGN.md).

---

## Phase 0 — Spike: prove the risky parts

Throwaway code, kept in `hermit-agent/spike/`, which gets deleted or folded into
`src/` afterwards. The goal is answers, not polish.

- [x] Pin a Pyodide release. Download its core files with a minimal script.
- [x] Single HTML file opened from **`file://`**, with no server: inline the core
      (gzip + base64), create a **Blob-URL worker**, and boot Pyodide from the inlined
      bytes (§8). Record which loader options were enough and what needed a `fetch`
      shim.
- [x] Run code in the worker. Read and write `/workspace` on MEMFS. Return a file
      listing with hashes.
- [x] **Kill & re-seed** (§4.3): `terminate()` during `while True: pass`, boot a fresh
      worker, restore the workspace. Measure re-boot time.
- [ ] Confirm `setInterruptBuffer` is unusable on `file://` and on GitHub Pages
      (`crossOriginIsolated === false`). *`file://` confirmed in Chromium and
      Firefox; GitHub Pages not yet checked.*
- [x] **Network blocking** (§10): try removing the worker globals, a CSP via `<meta>`,
      and a CSP inserted at runtime. Try to exfiltrate from Python with `pyfetch`,
      `js.fetch`, `js.XMLHttpRequest`, `js.WebSocket`, `js.eval("import(...)")` and
      nested `js.Worker`. Write down exactly what each approach blocks.
      *Answered by the MVP rather than a separate spike: replaced globals plus a static
      `<meta>` CSP, with 17 probes in `tests/e2e_agent.py`, all blocked in Chromium
      and Firefox (DESIGN §10, "As built and measured"). A CSP inserted at runtime
      was not tried: the static one turned out to be enough, since `connect-src`
      stays open anyway.*
- [x] Load one package (numpy) on demand from the CDN, held in memory only, with no
      OPFS or IndexedDB use. Check DevTools → Application → Storage.
- [x] Measure: standalone file size; cold boot time in Chrome, Firefox and Safari if
      available; memory after boot. *No Safari available on the dev machine.*

**Offline boot findings** (2026-10-03, `spike/build_standalone.py` +
`spike/probe_file_boot.py`: Pyodide **0.29.5** (Python 3.13.2) inlined into one HTML
file, opened from `file://` in headless Chromium 149, stock Firefox 157 and
Playwright's Firefox 151):
- **The single-file `file://` boot works in Chromium and Firefox.** Pyodide 0.29.x
  still runs in a *classic* worker, and both browsers start a classic Blob-URL worker
  on `file://`. Inside the worker, `importScripts()` of a Blob URL created in that
  worker also works. (The NetworkError in the first spike came from a URL, not a
  blob.) What was needed:
  - Pre-evaluate `pyodide.js` and `pyodide.asm.js` through `importScripts(blob:)`.
    The loader skips its own script load when `_createPyodideModule` is already
    defined.
  - Pass a fake `indexURL` (`https://pyodide.invalid/`) and a worker-side `fetch`
    shim that serves `pyodide.asm.wasm` (as `application/wasm`, so streaming
    instantiation works), `python_stdlib.zip` and `pyodide-lock.json` from the
    inlined bytes. `stdLibURL` and `lockFileContents` weren't needed.
  - Set `packageBaseUrl` to the pinned CDN, so packages still load on demand.
  - The indirect-`eval` fallback in the spike was never used.
- **Size:** the core is 12.3 MB raw and 7.3 MB inlined (gzip + base64): wasm 3.8 MB,
  stdlib 3.2 MB (already compressed, so base64 grows it), asm.js 0.3 MB. That is
  before HermitUI's own libraries.
- **Boot times** (warm machine, cold page): inflating the core on the main thread
  takes 0.2–0.35 s. From `new Worker()` to Python ready takes 1.0 s in Chromium and
  0.9 s in stock Firefox. Playwright's patched Firefox takes 2.8 s, so don't quote
  that build for timings. WASM memory after boot is 20 MB, and the main-thread JS
  heap is 28 MB in Chromium.
- **Kill & re-seed:** `terminate()` during `while True: pass`, then a fresh worker
  plus a restored workspace (byte-identical hashes, namespace gone as expected)
  takes 0.8 s in both browsers. That is fast enough that the warm spare worker from
  §4.3 isn't needed yet.
- **numpy 2.2.5 on demand** from the pinned CDN works from `file://` (the
  null-origin CORS fetch is fine): 0.5 s in Chromium and stock Firefox. IndexedDB,
  OPFS and Cache Storage stay empty. Firefox's `storage.estimate()` reports 544 KB
  usage, but that is created by the probe itself (`navigator.storage.getDirectory()`
  490 KB, `caches.keys()` 64 KB; a blank page reports 0). The real app must not call
  either.
- `crossOriginIsolated` is `false` and `SharedArrayBuffer` is undefined on `file://`
  in both browsers, so `setInterruptBuffer` is out, as §4.3 assumed.
- **Caveats:** this pins the agent to the 0.29.x line (Python 3.13) rather than 314
  (Python 3.14). If 0.29.x stops getting maintenance releases, patching 314's
  classic-worker check is the fallback, and it is untested. Firefox warns that
  Pyodide 0.29's wasm uses the deprecated legacy exception-handling `try`
  instruction. That is harmless today, but it will matter if Firefox ever drops it.
  Not yet tested: Edge and Firefox on Windows, Safari, and mobile.
- **Desktop Chrome on Windows** (the dev machine, opened by hand from
  `C:\workspace\…`) passes every check, a little faster than headless Linux:
  inflate 0.24 s, boot 0.75 s, kill & re-seed 0.65 s, numpy 0.39 s, storage untouched
  (IndexedDB and caches empty, OPFS refused with SecurityError on `file://`).

**Findings so far** (2026-10-03, `spike/agent_loop.py`: code-as-action loop against
a local Qwen3.8-27B through llama.cpp, with Pyodide 314.0.7 in a Blob module worker in
headless Chromium):
- **`file://` boot is harder than §8 assumes** *(resolved by the offline boot
  findings above: Pyodide 0.29.x in a classic worker)*. Pyodide 314 refuses classic workers
  ("Classic web workers are not supported"), and on a `file://` page Chromium won't
  start a Blob module worker at all, and `importScripts()` from a classic Blob worker
  fails with NetworkError. `fetch()` works in both. The spike is therefore served
  from `http://127.0.0.1`. The single-file boot is still open. HermitUI works around
  the same Chromium restriction in `loadWllamaModel` (`../src/script.js`) by
  stripping `{ type: "module" }` from the `Worker` constructor. That only works
  because wllama's worker is classic-compatible, and Pyodide 314 isn't. Options to
  try: Pyodide 0.29.x (still loads in classic workers) with its files fed in as Blob
  URLs, or patching Pyodide 314's classic-worker check.
- The loop works: all 3 reference task types passed (data processing in 2 steps,
  calculation in 1 to 4, code plus tests). The model recovered from its own errors.
- Prompt gaps: the model tried `subprocess` to run unittest (Emscripten has no
  processes). §5.3 should say "no subprocess; run tests in-process".
- **Stale modules in the persistent namespace:** after the agent edited
  `test_roman.py`, re-running the tests used the old import from `sys.modules`. That
  cost 3 steps, and the task hit the 10-step limit just as the tests went green. The
  harness should drop changed workspace modules from `sys.modules` after each step
  (§4.2).
- **Reasoning effort matters a lot for agent loops.** With no setting, Qwen3.8's
  template defaults to `xhigh`. One step of an open-ended task ("a complex hello world
  in Java") spent the whole 8192-token budget on 35k chars of reasoning and returned
  empty content. The spike now defaults to `low` (HermitUI's `buildReasoningParams`
  mapping, levels read from `/props`), switchable with `/effort`, and reports a
  cut-off instead of treating the empty reply as a final answer. The agent needs the
  same control plus a cut-off state.
- **Pyodide is 32-bit:** numpy's default integer is int32 and overflows silently. At
  low effort the model returned the primes sum mod 2³² as a confident final answer;
  at xhigh it had sanity-checked its result and caught it. One line in the system
  prompt (§5.3) fixed it (3/3 runs).
- llama.cpp returns the reasoning in `reasoning_content`, not inline `<think>`, so
  the timeline must read both. HermitUI's `fetchAndStreamChat` already does this
  (`reasoning_content` / `reasoning` / `thinking`, streamed and non-streamed), so
  copy that rather than writing it again.

**Exit criteria:**
- Pyodide boots offline from a single file in at least Chrome and Firefox.
- Kill & re-seed works.
- A written finding on how strong network blocking can be. This is the input for the
  security wording in the UI.
- Size and boot-time numbers are recorded in DESIGN.md §8, replacing the estimate.

---

## Phase 1 — MVP

Scaffold the folder per §11 (`src/`, `build.py`, `tests/`, `dist/`), then:

- [x] **Settings & connection:** base URL, model, API key (memory only), Test
      Connection. Copied from HermitUI and listed in AGENTS.md.
- [x] **Agent loop:** code-as-action parsing, observation envelope, truncation, step
      limit, per-step timeout, final answer and `ask:` handling (§5).
- [x] **Worker runner:** persistent namespace, stdout/stderr capture, workspace
      diffing (§4.2).
- [x] **Step timeline:** reasoning (think blocks), code, output, effect, verdict
      (§2.1).
- [x] **Workspace panel:** tree, highlights, viewer, upload (files and folders),
      download.
- [x] **Effect-based gating:** file origins, classification table, approve / edit /
      reject, rollback plus interpreter restart on reject (§2.3).
- [x] **Autonomy levels:** approve-each / risk-based (default) / autopilot. Stop and
      Kill.
- [x] **Checkpoints & rewind:** content-addressed store, rewind to step N (§2.4).
- [x] **Session export/import:** zip writer and reader, full and workspace-only
      export, import validation, paused restore, confirm-replace (§3).
- [x] **Tests:** unit tests (parsers, classifier, zip round-trip, session schema)
      and one e2e test that scripts a short session against a mock OpenAI endpoint,
      then does export → reload → import.
- [x] `dist/hermit-agent-standalone.html` builds and is committed.

**Exit criteria:**
- A real remote model completes three reference tasks, one each for data processing,
  code plus tests, and calculation, under risk-based supervision.
- A rejected delete is rolled back correctly.
- Export → import round-trips a session including checkpoints.
- All tests are green.

**Result (2026-10-03): all four met.**
- `tests/e2e_reference.py` against Qwen3.8-27B (IQ4_XS, llama.cpp, reasoning effort
  Low), risk-based, in the built file in headless Chromium, passed all three tasks:
  data processing (3 steps, 14 s), code plus tests (4 steps, 42 s; 11 unittest
  tests run in-process), and calculation (2 steps, 5 s; 142913828922). No step
  needed approval: none touched a user file.
- `tests/e2e_agent.py` (mock endpoint) runs in Chromium 149 and Playwright's
  Firefox 151, and in stock Firefox 157 without the download-based parts, which
  Playwright can't capture over BiDi. It covers: a rejected delete of a user file
  rolled back with the interpreter restarted; timeout; Kill; edit-before-run;
  guidance; reject-before-run; 17 network probes, all blocked; the file viewer;
  the workspace zip; export (valid for Python's `zipfile`, no API key inside) →
  fresh page → import (timeline and workspace identical) → follow-up → rewind to a
  step and to the start (worker re-seeded, variables gone); and confirm-before-
  replace on import.
- `node tests/run.mjs`: 135 assertions over reply parsing, observations, diffing,
  risk classification, zip and session archive (tampering included).

What the MVP does *not* have yet, beyond Phase 2's list: drag-drop and folder upload
are wired but only tested by hand (not in e2e); there is no per-file text diff (a
chip opens the new or old version); and no mobile pass beyond flex wrapping.
Decisions taken without the owner are in [REVIEW_NOTES.md](REVIEW_NOTES.md).

---

## Phase 2 — Polish

- [x] **File actions** (DESIGN §5.1): `<read_file>`, `<write_file>`, `<edit_file>`.
      They run on the main thread, are gated before they apply, and are exclusive with
      a python block. Covered by `tests/files.test.mjs` and the e2e `files_scenario`.
- [ ] Per-file text diffs (line diff), image previews, a binary summary.
- [ ] matplotlib capture (Agg plus a patched `show()`) with inline figures (§8).
- [ ] Package-loading UX: import detection, timeline notes, an offline error.
- [x] **Auto-compaction** (§5.4): older steps are summarised at a configurable share
      of the context (default 75 %), and once more on a context-overflow error. Rewind and
      export work across compactions. Covered by `tests/agent.test.mjs`,
      `tests/archive.test.mjs` and the e2e `compaction_scenario`.
- [ ] Context management, the rest: elision of old observations, a periodic file listing
      (§5.4).
- [ ] Inject guidance mid-task. Edit-before-run polish.
- [ ] Mobile layout: the workspace drawer, touch-friendly approvals.
- [ ] Chat error hints adapted for agent failures (endpoint down mid-task, context
      overflow).

**Exit criteria:** a 20+ step task stays within context and is usable on a phone-width
screen.

---

## Phase 3 — Native tool calls

- [ ] `run_python` / `ask_user` / `finish` as OpenAI `tools` (§5.5). `read_file`,
      `write_file` and `edit_file` already have their argument shapes and a
      protocol-independent executor; they only need the tool-call parsing.
- [ ] Capability detection with code-as-action as the fallback.
- [ ] The same timeline, gating and export; only the parsing changes.

**Exit criteria:** both modes pass the Phase 1 reference tasks on an endpoint that
supports tools.

---

## Phase 4 — In-browser models (wllama)

- [ ] Bring over HermitUI's wllama loading (local file / URL into an in-memory Blob,
      Memory64, WebGPU), inside marker blocks for a separate output.
- [ ] Agent prompt tuning for small models. Measure task success per model, the same
      way HermitUI's `benchmark/` harness measures speed.
- [ ] Document the realistic model floor in the README.

**Exit criteria:** at least one in-browser model completes the reference tasks fully
offline on the dev machine's GPU.

---

## Phase 5 — Merge decision

Evaluate per DESIGN.md §11: a build flavor in HermitUI, an agent mode in the main app,
or staying separate. Consider how much shared code has diverged, the size cost to the
main app, and user feedback. Record the decision and its reasoning here.
