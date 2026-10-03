# Decisions to review (Phase 1 MVP build)

The MVP was built unattended (2026-10-03) on the instruction "make educated guesses
when problems arise, note them for me to decide later". Each entry: what was
decided, why, and what the alternative would be. Delete an entry once it has been
confirmed or reversed (and update DESIGN.md if reversed).

## Scope

- **Phase 0 network blocking was skipped by agreement**, but the MVP needs *some*
  answer for §2.3/§10. What was built: a best-effort guard in the worker plus a CSP,
  probed by the e2e test. See "Network" below. The honest UI wording follows what the
  test actually showed.

## Agent loop

- **Every model turn that doesn't end the loop counts toward the step limit**,
  including cut-off, empty and malformed replies that ran no code. Otherwise a model
  that keeps replying with nothing could loop forever. Alternative: count only
  executed steps and add a separate "consecutive empty replies" guard.
- **Stop aborts an in-flight model request immediately**, rather than "finishing the
  current step" as §2.2 says. A Python step that is *running* is still allowed to
  finish. Reason: with reasoning models one request can take minutes, and nothing
  has executed yet, so nothing is lost by aborting it.
- **Guidance and system notes are merged into the next user message** (the latest
  observation) instead of being sent as a separate user message. Some chat templates
  reject two user messages in a row.
- **Reasoning effort defaults to Low** (spike finding: Qwen3.8 at its default xhigh
  spent the whole token budget on one step). Max tokens default 8192.
