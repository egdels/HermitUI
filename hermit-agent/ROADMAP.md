# HermitUI Agent — Roadmap

Each phase ends with **exit criteria**. Don't start the next phase until they are met,
or until they are consciously waived and the reason is written down here. Section
references (§) point to [DESIGN.md](DESIGN.md).

---

## Phase 0 — Spike: prove the risky parts

Throwaway code, kept in `hermit-agent/spike/`, which gets deleted or folded into
`src/` afterwards. The goal is answers, not polish.

- [ ] Pin a Pyodide release. Download its core files with a minimal script.
- [ ] Single HTML file opened from **`file://`**, with no server: inline the core
      (gzip + base64), create a **Blob-URL worker**, and boot Pyodide from the inlined
      bytes (§8). Record which loader options were enough and what needed a `fetch`
      shim.
- [ ] Run code in the worker. Read and write `/workspace` on MEMFS. Return a file
      listing with hashes.
- [ ] **Kill & re-seed** (§4.3): `terminate()` during `while True: pass`, boot a fresh
      worker, restore the workspace. Measure re-boot time.
- [ ] Confirm `setInterruptBuffer` is unusable on `file://` and on GitHub Pages
      (`crossOriginIsolated === false`).
- [ ] **Network blocking** (§10): try removing the worker globals, a CSP via `<meta>`,
      and a CSP inserted at runtime. Try to exfiltrate from Python with `pyfetch`,
      `js.fetch`, `js.XMLHttpRequest`, `js.WebSocket`, `js.eval("import(...)")` and
      nested `js.Worker`. Write down exactly what each approach blocks.
- [ ] Load one package (numpy) on demand from the CDN, held in memory only, with no
      OPFS or IndexedDB use. Check DevTools → Application → Storage.
- [ ] Measure: standalone file size; cold boot time in Chrome, Firefox and Safari if
      available; memory after boot.

**Findings so far** (2026-10-03, `spike/agent_loop.py`: code-as-action loop against
a local Qwen3.8-27B through llama.cpp, with Pyodide 314.0.7 in a Blob module worker in
headless Chromium):
- **`file://` boot is harder than §8 assumes.** Pyodide 314 refuses classic workers
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

- [ ] **Settings & connection:** base URL, model, API key (memory only), Test
      Connection. Copied from HermitUI and listed in AGENTS.md.
- [ ] **Agent loop:** code-as-action parsing, observation envelope, truncation, step
      limit, per-step timeout, final answer and `ask:` handling (§5).
- [ ] **Worker runner:** persistent namespace, stdout/stderr capture, workspace
      diffing (§4.2).
- [ ] **Step timeline:** reasoning (think blocks), code, output, effect, verdict
      (§2.1).
- [ ] **Workspace panel:** tree, highlights, viewer, upload (files and folders),
      download.
- [ ] **Effect-based gating:** file origins, classification table, approve / edit /
      reject, rollback plus interpreter restart on reject (§2.3).
- [ ] **Autonomy levels:** approve-each / risk-based (default) / autopilot. Stop and
      Kill.
- [ ] **Checkpoints & rewind:** content-addressed store, rewind to step N (§2.4).
- [ ] **Session export/import:** zip writer and reader, full and workspace-only
      export, import validation, paused restore, confirm-replace (§3).
- [ ] **Tests:** unit tests (parsers, classifier, zip round-trip, session schema)
      and one e2e test that scripts a short session against a mock OpenAI endpoint,
      then does export → reload → import.
- [ ] `dist/hermit-agent-standalone.html` builds and is committed.

**Exit criteria:**
- A real remote model completes three reference tasks, one each for data processing,
  code plus tests, and calculation, under risk-based supervision.
- A rejected delete is rolled back correctly.
- Export → import round-trips a session including checkpoints.
- All tests are green.

---

## Phase 2 — Polish

- [ ] Per-file text diffs (line diff), image previews, a binary summary.
- [ ] matplotlib capture (Agg plus a patched `show()`) with inline figures (§8).
- [ ] Package-loading UX: import detection, timeline notes, an offline error.
- [ ] Context management: elision, summarisation, periodic file listing (§5.4).
- [ ] Inject guidance mid-task. Edit-before-run polish.
- [ ] Mobile layout: the workspace drawer, touch-friendly approvals.
- [ ] Chat error hints adapted for agent failures (endpoint down mid-task, context
      overflow).

**Exit criteria:** a 20+ step task stays within context and is usable on a phone-width
screen.

---

## Phase 3 — Native tool calls

- [ ] `run_python` / `ask_user` / `finish` as OpenAI `tools` (§5.5).
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
