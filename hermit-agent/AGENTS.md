# Agent & Contributor Rules — `hermit-agent/`

These rules apply to everything inside `hermit-agent/`. They **extend** the root
[`../AGENTS.md`](../AGENTS.md): every root rule still applies unless this file
explicitly overrides it. If you are an AI agent, read the root file first.

> Local tooling: Claude Code reads `CLAUDE.md`. As in the root folder, a gitignored
> `CLAUDE.md -> AGENTS.md` symlink can be created here; don't commit it.

## Status
Design stage. The source of truth is [DESIGN.md](DESIGN.md), and the current phase is
in [ROADMAP.md](ROADMAP.md). If an implementation needs to deviate from the design,
update DESIGN.md in the same commit.

## Inherited from the root (unchanged)
- **The single HTML file is the deliverable.** Split sources are assembled by a
  Python `build.py`. No `package.json`, npm, bundlers or Node build tools.
- **Vanilla JS (ES6+) and vanilla CSS only.** No frameworks, no CSS frameworks or
  preprocessors.
- **Strict ephemerality.** No `localStorage`, `IndexedDB`, cookies or OPFS, for any
  reason. Pyodide **MEMFS only; never IDBFS**, and never Pyodide's persistent package
  cache. Session export/import to a user-chosen file is the only persistence.
- **`DOMPurify.sanitize()`** on all model output *and* all imported session content
  rendered as HTML or Markdown.
- **OpenAI chat-completions schema** for all LLM traffic.
- Glassmorphism, the Inter font, CSS variables plus `data-theme`, a fluid layout with
  minimal media queries.
- Git workflow: check origin first, review before commit, commit locally, **never
  push unless asked**, and use implementation plans for major changes.

## Specific to this folder
- **Don't touch the root app for agent work.** Never edit `../src/`, `../build.py`,
  `../tests/` or `../dist/` as part of HermitUI Agent work. If a HermitUI bug is found
  while copying code, fix it in a separate commit and say so.
- **Own build.** `hermit-agent/build.py` produces `hermit-agent/dist/`. It must not
  write outside `hermit-agent/`. Run it before committing changes to
  `hermit-agent/src/`. When nothing in `hermit-agent/` changed, the root build rule
  (`python3 build.py`) still applies as usual.
- **Copy, don't import.** Code taken from `../src/` is copied and adapted, and every
  copied function is listed in the table below with the source commit, so fixes can
  be ported in either direction.
- **Worker messages are untrusted.** Agent code can reach the worker's JS globals.
  The main thread validates every worker message and never evaluates anything it
  receives (DESIGN.md §4.1).
- **Never send the API key to the worker or into an export.**
- **Never auto-execute imported sessions.** Import restores in a paused state (DESIGN
  §3.3).
- **Be honest about the sandbox.** UI text about network isolation must match what
  the Phase 0 spike actually proved (DESIGN §10). Don't overclaim.
- **Tests:** pure logic (parsers, risk classifier, zip, session schema) goes in unit
  tests that slice real functions out of the source, following
  `../tests/extract.mjs`. DOM and worker behaviour goes in the e2e tests.

## Copied from HermitUI
| Function / block | From (`../src/…`) | Source commit | Adapted how |
|---|---|---|---|
| *(none yet)* | | | |
