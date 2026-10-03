# Tests

Same approach as HermitUI's `../../tests/`: no test runner, no `package.json`, no
dependencies to install for the unit half.

```bash
node tests/run.mjs                                              # unit tests (all *.test.mjs)
python3 build.py && ../benchmark/.venv/bin/python tests/e2e_agent.py [chromium] [firefox] [firefox=/path/to/stock/firefox]
../benchmark/.venv/bin/python tests/e2e_reference.py --base-url http://localhost:8080/v1
```

## Unit tests (pure logic)

`extract.mjs` slices the real functions out of `src/script.js` by name and evaluates
them, so the tests exercise shipped code. Renaming one fails the suite loudly; update
the `FUNCS` list with the rename. Only DOM-free code can be covered this way.

- **`agent.test.mjs`** covers:
  - `parseReply`: only `python`-tagged fences run, the first block wins, and
    unclosed blocks, cut-offs, `ask:`, empty replies and final answers are handled.
    Includes the spike's bare-fence bug.
  - `splitReply`, `truncateOutput` (2 KB + 4 KB), `diffListings`, `formatChanges`.
  - `classifyEffect`: every row of the DESIGN §2.3 table.
  - `buildObservation`: the §5.2 envelope.
  - `appendToLastUserMessage` (never two user messages in a row), the path rules,
    `makeFence`.
  - The helpers copied from HermitUI: reasoning params and chat error hints.
  - The prompts, and that the JS sha256 fallback matches WebCrypto.
  - The per-step model stats: `buildStepStats` (server `timings` over the page
    clock, token fallbacks, garbage input), `formatStepStats`, `cleanStepStats`.
- **`archive.test.mjs`** covers:
  - CRC32, and the zip round-trip (binary, unicode names, empty files).
  - The untrusted-input rules: traversal, absolute and backslash paths, CRC
    mismatch, size and entry limits, an entry that inflates past its declared size,
    directory entries.
  - The session archive round-trip, with and without checkpoints, including that
    runtime-only fields and the API key never reach the export.
  - Tampering: a wrong checkpoint blob, missing content, an index pointing past the
    session, a missing manifest, a newer format version, broken JSON.
  - `validateSession` coercion and defaults.

## End-to-end — `e2e_agent.py`

Opens the **built** `dist/hermit-agent-standalone.html` from `file://`, against
`mock_openai.py`: a scripted OpenAI-compatible endpoint that picks replies by a
keyword in the task and records every request, plus every hit on `/exfil/…`. Four
scenarios:

1. **Risk-based**:
   - An auto-committed step.
   - A delete of a user file held, rejected with a reason and rolled back.
   - A step timeout.
   - **17 network probes** from Python, which must all be blocked, with the mock
     receiving nothing. The step after them imports a package whose registry entry
     the probe step pointed at the mock; the load must be refused.
   - The file viewer, the workspace zip, and the session export (checked with
     Python's `zipfile`; the API key must not appear anywhere in it).
2. **Import** into a fresh page:
   - Timeline and workspace identical, a follow-up carrying the restart note.
   - Rewind to a step and to the start, with the worker re-seeded and its
     variables gone.
   - Confirm-before-replace.
3. **Approve each step**: edit before run, a guidance note, Kill, and reject before
   run, each checked against what the model is told.
4. **Autopilot**: a delete of a user file commits without a hold, but the risk is
   still recorded. Every step card shows its stats block, with the mock's llama.cpp
   `timings` and the context size from its `/props`.

Stock Firefox (`firefox=<binary>`, driven over WebDriver BiDi) runs everything except
the download-based checks, which Playwright can't capture over BiDi. It matters
because the network guard depends on browser behaviour (the CSP reaching Blob
workers), and Playwright's own Firefox is a patched build. Under BiDi, Firefox reports
two expected things as page errors; the test ignores exactly those two:
- the CSP blocking the probes' `eval`/`import`;
- the forced stop of a killed worker, which the page itself never sees.

The page's CSP blocks `eval`, so Playwright's `wait_for_function` can't run in it.
Waits poll `page.evaluate()` instead, which goes through the browser protocol.

## Real model — `e2e_reference.py`

This is the Phase 1 exit criterion. A real model does the three reference tasks
(data processing, code plus tests, calculation) in the built app under risk-based
supervision. The script approves held steps, logging their reasons, and answers
`ask:` questions generically. It checks the results inside the same interpreter, or
against the final answer. It takes minutes per task, so launch it detached and
watch the log.
