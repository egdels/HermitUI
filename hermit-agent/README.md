# HermitUI Agent

*A supervised, sandboxed, ephemeral agent that runs entirely in your browser.*

> **Status: design stage.** This folder has no code yet, only the design and the plan.
> It is the starting ground for a HermitUI spin-off and is developed here, separately
> from the main app in [`../src/`](../src/), so it can move fast without destabilising
> HermitUI.

## The idea

You give the agent a task, for example "clean up these CSVs and chart the monthly
totals", "write and test a parser for this log format" or "check this calculation
numerically". The agent works through it step by step: it writes Python, runs it
against a virtual file system, reads the output and decides the next step.

What makes it different from CLI agents is that **you can supervise it**:

- **Every step is visible:** the model's reasoning, the exact code, the output, and
  a diff of which files changed.
- **Risky steps wait for you.** Harmless steps run on their own. Anything that
  deletes or overwrites your files, or tries to reach the network, is held for
  approval.
- **Every step can be undone.** The workspace is checkpointed after each step, and
  you can rewind to any of them.
- **It can't touch your machine.** Python runs as WebAssembly (Pyodide) in a Web
  Worker. The agent only sees the in-memory workspace you put files into, and that
  workspace is gone when you close the tab.
- **Sessions go where you put them.** Export a whole session (conversation, steps,
  workspace, checkpoints) to a single `.zip` and import it later to resume or review.
  The app itself still remembers nothing.

## Relationship to HermitUI

It is the same brand and the same philosophy: a single HTML file, vanilla JS, no
persistence, any OpenAI-compatible endpoint. It reuses much of HermitUI's proven
code: streaming, rendering, think-tag parsing, settings, error hints and the inline
build machinery. It lives in its own folder with its own future `src/`, `build.py`
and `tests/`, and may merge back into HermitUI later as a build flavor or a mode.
See [DESIGN.md §11](DESIGN.md#11-project-layout--merge-path).

## Documents

| Document | What's in it |
|---|---|
| [DESIGN.md](DESIGN.md) | The full design: supervision model, session import/export, architecture, agent loop, security, packaging |
| [ROADMAP.md](ROADMAP.md) | Phases with checklists and exit criteria, from the first spike to the merge decision |
| [AGENTS.md](AGENTS.md) | Rules for anyone (human or AI) working in this folder |
