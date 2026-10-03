# Decisions to review (Phase 1 MVP build)

The MVP was built unattended on 2026-10-03, on the instruction "make educated guesses
when problems arise, note them for me to decide later". Each entry says what was
decided, why, and what the alternative is. When you confirm or reverse one, delete it
here; if you reverse it, update DESIGN.md too. The ⭐ entries are the ones most worth a
look.

## Process

- **No implementation-plan approval round.** AGENTS.md asks for a plan and explicit
  approval before major changes. You asked for the build to run unattended, so this
  file and DESIGN.md's "as built" notes stand in for the plan. A local
  `walkthrough.md` (gitignored) summarises the changes.
- **Phase 0 network blocking was answered by the MVP's own tests** instead of a
  separate spike (DESIGN §10, "As built and measured"). Still open from Phase 0:
  checking `crossOriginIsolated` on GitHub Pages.

## Packaging

- ⭐ **Pyodide 0.29.5 (Python 3.13), not 314 (Python 3.14).** 314 refuses classic
  workers, and Chromium won't start a Blob module worker on `file://`. Pinned by
  sha256 in `build.py`. When 0.29.x stops getting releases, the fallback is
  patching 314's classic-worker check (untested).
- **One output only**, `dist/hermit-agent-standalone.html` (8.8 MB). There are no
  CDN or local variants, unlike HermitUI. For development, open `src/index.html`
  directly: it loads the libraries and Pyodide from the CDNs, under a looser CSP.
- **Default API URL is `http://localhost:8080/v1`** (llama.cpp) rather than HermitUI's
  `:1234` (LM Studio), because that's what the spike and your machine use.
- **Version v0.1.0**, shown in the header. No git tag was created.

## Agent loop

- **Every model turn that doesn't end the loop counts toward the step limit**,
  including cut-off, empty and malformed replies that ran no code. Otherwise a model
  that keeps replying with nothing could loop forever. Alternative: count only
  executed steps and add a separate "consecutive empty replies" guard.
- ⭐ **Stop aborts an in-flight model request immediately**, rather than "finishing
  the current step" as §2.2 says. A Python step that is *running* still finishes.
  Reason: with reasoning models one request can take minutes, and nothing has run
  yet, so nothing is lost by aborting it.
- **Guidance, upload notices and restart notices are merged into the next user
  message** (usually the latest observation) instead of being sent as their own
  message. Some chat templates reject two user messages in a row.
- **Reasoning effort defaults to Low.** This is a spike finding: Qwen3.8 at its
  default (xhigh) spent the whole token budget on one step. Max tokens defaults to
  8192. The control is a `<select>` in the composer, not HermitUI's segmented
  control.
- **Reasoning support is probed automatically** (`/props`, then `/api/show`) before
  the first request to an endpoint, and again from Test Connection. HermitUI has a
  separate button for this. If the probe finds nothing, the parameter is sent
  optimistically, and the strip-and-retry on a 400 still applies.
- **The model's reasoning isn't sent back in the history**, only its visible reply.
- **The first message lists the workspace files** (name and size, up to 50).
  Uploads made after the task started are announced to the model in the next
  request.
- **An empty model name sends `"local-model"`**, as HermitUI does.
- **`ask:` is detected at the start of any line**, case-insensitive, with or without
  bold. A final answer that contains a line starting with "Ask:" would pause the
  loop. That's unlikely but possible.
- **A final answer that names files the workspace doesn't have is sent back once.**
  This applies to names in backticks or bold with a common file extension. The
  model is told which files are missing and which exist; its second answer stands
  either way. A step whose code starts with a `# name.py` comment also gets a note
  when no such file exists afterwards. Why: a real model "saved" `csv_reader.py`
  that way, then claimed in its final answer to have created it. False positive: an
  answer that mentions a file the agent deliberately deleted, in backticks, gets
  sent back once.
- **A follow-up after the final answer continues the same conversation**, and the
  step budget is extended by the step limit. To start fresh, use ➕ New.

## Gating (DESIGN §2.3)

- ⭐ **Approve-each mode approves *before* the run, and there is no second hold
  after it**, even if the step then deletes a user file: you approved the code.
  Alternative: also hold risky effects after an approved run.
- ⭐ **"Allow network & re-run" and "Edit & re-run" restart the interpreter** before
  the second run, so variables from earlier steps are lost (the model is told).
  This is consistent with the rollback rule, since variables may hold the rejected
  step's data, but it can break code that relied on earlier variables. A network
  re-run commits without another hold, with the network open for that run only.
  An edited re-run is gated again like any step.
- **Autopilot commits everything** except a step that would exceed the workspace
  limits, which is auto-rejected. In risk-based mode that case is a hold reason
  instead.
- **A package load that the harness refused also holds the step**, because it
  shows up as a blocked network attempt. That happens when agent code pointed
  Pyodide's registry somewhere other than the pinned CDN.
- **An overwritten user file stays a user file.** New files are `agent`, and a
  rename counts as delete + add, so renaming a user file asks.
- **Empty directories aren't tracked.** The workspace is files only; export writes
  no directory entries.
- **Uploads are refused while a step is running.** They're allowed while a step
  waits for approval; the worker is then re-seeded before the next run.
- **Kill when idle** restarts the interpreter, and the model is told on its next
  request.

## File actions (added after the MVP)

- ⭐ **A reply holds file actions or one python block, never both** (your call).
  A mixed reply runs nothing and gets an error observation. The alternative was
  "files first, then the code" in one turn, which saves a model round-trip.
- **Writes and edits in one reply are all-or-nothing.** The first failure stops the
  batch. Reads before it keep their output; later actions are reported as not run.
- **Approve-each holds read-only file steps too**, since a read sends file content to
  the model. Risk-based and autopilot never hold a pure read.
- **Tags count only at the start of a line, and content runs to the first closing
  tag.** So a file can't contain its own `</write_file>` literally. That is rare
  enough; the alternative is a length-prefixed or fence-counted format that small
  models get wrong.
- **Read caps:** 400 lines and 32 000 characters per read, 64 000 per reply, and
  2 000 per line. They were picked to fit a typical source file in one read without
  flooding an 8–16 k context. The file-step observation is therefore not truncated
  again.
- **Path leniency:** `/workspace/x` and `./x` are accepted as `x`. Anything else
  unsafe is refused per action.
- **A file step never boots the interpreter.** After a commit, the bytes go to the
  worker only if it was idle and in sync. Otherwise the next python step re-seeds it.

## Checkpoints & rewind

- **A checkpoint is taken after every model turn**, including rejected and non-code
  ones, and at the task start. Rewind truncates the timeline, the history and later
  checkpoints, garbage-collects unreferenced file contents, and restarts the
  interpreter. Rewinding needs the agent stopped.
- **Rejected steps' file versions stay in memory while their card exists**, so the
  file chips can still show them. They're never exported.

## Context compaction (DESIGN §5.4, added after the MVP)

- **Default 85 %, keep the last 4 steps, at least 2 steps per compaction.** 85 % was
  chosen by the owner (first built at 75 %). It leaves ~2.4 k of a 16 k context for a
  reply. A longer reply that overflows is caught by the overflow fallback. Lower
  the threshold if `max_tokens` is large compared with the context.
- **The token estimate is calibrated, not counted.** No tokenizer runs in the page. The
  previous request's `prompt_tokens` per character is used, which also covers the chat
  template's overhead. After an import, chars ÷ 3.5 is used until the first request.
- **Ollama and cloud APIs don't report a context size.** Without the *Context size*
  setting, only the overflow fallback works there. Ollama truncates silently instead of
  failing, so set the size by hand for it.
- **The summary is written by the same model, with the user's reasoning effort and
  `max_tokens`.** A summary cut off at `max_tokens` is still used. Only an empty one is
  rejected.
- **Exports carry every compaction's full pre-compaction history**, so they grow by
  roughly one context's worth per compaction. That is the price of rewind
  across a compaction.

## Export / import (DESIGN §3)

- **`session.json` stores a `timeline`** (every card in order) instead of a bare
  `steps` list, so an import rebuilds the exact view. DESIGN §3.1 was updated.
- ⭐ **Import doesn't apply the session's endpoint or model.** Autonomy and limits
  are restored, and a note names the endpoint the session was recorded against. A
  shared session shouldn't silently send its content to the sender's server.
- **Limits:** the workspace holds up to 5,000 files / 256 MB; an import is capped
  at 20,000 entries / 512 MB unpacked. Not measured against real tab memory.
- **Only format version 1 exists**, so there is no migration code yet. A newer
  version is refused with a clear message.
- **There is no "import a workspace zip as files".** A zip you upload stays a zip in
  the workspace, and the agent can unpack it with `zipfile`.

## Security

- ⭐ **The network guard is best-effort and the UI says so.** It is a denylist over
  the worker's API surface plus a strict CSP. All 17 probes are blocked in
  Chromium, Playwright's Firefox and stock Firefox 157, and the mock endpoint
  received nothing. A future browser API could still open a path. The unbuilt dev
  source allows the CDN hosts in `script-src`.
- **`script-src 'unsafe-inline'` is unavoidable for a single file.** Model output
  is sanitized with DOMPurify, so script injection would need a DOMPurify bypass.
  `connect-src` is `*`, because the endpoint is user-configured.
- **In risk-based and autopilot modes, a step's output reaches the model before you
  see it** (DESIGN §13, open question; unchanged).
- **A forged worker result can only hide changes**, never invent them: the main
  thread re-hashes every received file. Hidden changes never reach the canonical
  workspace and disappear at the next re-seed.

## UI

- **The workspace panel sits on the right and wraps below the timeline on narrow
  screens.** It's not a drawer yet (Phase 2 mobile pass).
- **There are no per-file text diffs** (Phase 2). A file chip opens the new
  version, or the old one for a deletion.
- **No approve/reject keyboard shortcuts** (DESIGN §13 open question). Ctrl+Enter
  submits the composer.
- **Dark mode follows the system at load**, and the toggle isn't remembered
  (ephemerality).

## Not covered by automated tests

- Drag-drop and folder upload: wired, but only folder-less file upload is in e2e.
- Safari, mobile browsers, and real desktop Chrome/Edge/Firefox on Windows. The
  spike page ran in desktop Chrome on Windows; the app itself hasn't.
- Long tasks against a real model: compaction is tested end-to-end only against the
  mock endpoint. How good the summaries are, and whether an agent continues well from
  them, hasn't been measured yet.
