// ========== HermitUI Agent — main thread ==========
// Layout of this file:
//   1. Configuration
//   2. Helpers copied from HermitUI (see AGENTS.md "Copied from HermitUI")
//   3. Agent logic (pure, unit-tested via tests/extract.mjs)
//   4. Zip + session archive (pure, unit-tested)
//   5. Python worker client
//   6. LLM streaming
//   7. Session state, workspace store, checkpoints
//   8. Agent loop
//   9. UI
// Functions in sections 2–4 must stay free of DOM access: the unit tests slice them out
// of this file by name.

// ========== 1. Configuration ==========
const APP_VERSION = "0.1.0";
const PYODIDE_VERSION = "0.29.5";
const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/";
const SESSION_FORMAT = "hermit-agent-session";
const SESSION_FORMAT_VERSION = 1;
const LIMITS = { maxFiles: 5000, maxWorkspaceBytes: 256 * 1024 * 1024, maxArchiveEntries: 20000, maxArchiveBytes: 512 * 1024 * 1024, maxPathLength: 512, riskMaxFiles: 20, riskMaxBytes: 10 * 1024 * 1024, bootTimeoutMs: 120000, stepLimitIncrement: 10, readMaxLines: 400, readMaxChars: 32000, readMaxTotalChars: 64000, readMaxLineChars: 2000, compactKeepSteps: 4, compactMinSteps: 2 };
const THROTTLE_MS = 80;

// ========== 2. Helpers copied from HermitUI ==========
// Escape text destined for HTML / attribute contexts.
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// build.py embeds the Pyodide core gzipped + base64-encoded; it is inflated in-browser
// with the native DecompressionStream API.
async function gunzipToBytes(b64) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function createThrottle(minInterval) {
    let lastRun = 0;
    let pending = null;
    let lastFn = null;
    function throttled(fn) {
        lastFn = fn;
        const now = Date.now();
        if (now - lastRun >= minInterval) {
            lastRun = now;
            fn();
            if (pending) { clearTimeout(pending); pending = null; }
        } else if (!pending) {
            pending = setTimeout(() => {
                lastRun = Date.now();
                pending = null;
                if (lastFn) lastFn();
            }, minInterval - (now - lastRun));
        }
    }
    // Cancel a scheduled trailing call so it can't fire after the final render.
    throttled.cancel = function() {
        if (pending) { clearTimeout(pending); pending = null; }
        lastFn = null;
    };
    return throttled;
}

// isFinal: while streaming, a half-arrived tag must not flash as literal text, so a
// trailing tag prefix is held back. Once the message is complete there is nothing
// left to arrive, and holding it back would permanently eat a real trailing "<".
function parseThinkSegments(rawText, isFinal = false) {
    let segments = [];
    let currentIdx = 0;
    const openRegex = /<\|?(?:think|thought|reasoning|thought_start)[^>]*>/gi;
    // The "/" is optional because some models emit unslashed closers like
    // <|thought_end|>. Side effect: a literal nested open tag inside a think
    // section also terminates it — acceptable, models don't nest these.
    const closeRegex = /<\/?\|?(?:think|thought|reasoning|thought_end)[^>]*>/gi;

    while (true) {
        openRegex.lastIndex = currentIdx;
        let openMatch = openRegex.exec(rawText);

        if (!openMatch) {
            let textContent = rawText.substring(currentIdx);
            // Closing variants included: a partially-streamed '</think'
            // must not flash as literal text before its '>' arrives.
            const partials = ['<think', '<thought', '<reasoning', '<|thought_start', '<|thought_end',
                              '</think', '</thought', '</reasoning'];
            if (!isFinal) {
                const lowerContent = textContent.toLowerCase();
                for (let p of partials) {
                    let found = false;
                    for (let i = p.length - 1; i >= 1; i--) {
                        if (lowerContent.endsWith(p.substring(0, i))) {
                            textContent = textContent.substring(0, textContent.length - i);
                            found = true;
                            break;
                        }
                    }
                    if (found) break;
                }
            }
            if (textContent.length > 0) {
                segments.push({ type: 'text', content: textContent });
            }
            break;
        }

        let textBefore = rawText.substring(currentIdx, openMatch.index);
        if (textBefore.length > 0) {
            segments.push({ type: 'text', content: textBefore });
        }

        closeRegex.lastIndex = openMatch.index + openMatch[0].length;
        let closeMatch = closeRegex.exec(rawText);

        if (closeMatch) {
            let thinkContent = rawText.substring(openMatch.index + openMatch[0].length, closeMatch.index);
            segments.push({ type: 'think', content: thinkContent, isClosed: true });
            currentIdx = closeMatch.index + closeMatch[0].length;
        } else {
            let thinkContent = rawText.substring(openMatch.index + openMatch[0].length);
            segments.push({ type: 'think', content: thinkContent, isClosed: false });
            break;
        }
    }
    return segments;
}

// Normalize a base URL (or a pasted full chat endpoint) to the given API path.
function apiEndpoint(base, path) {
    let url = base.trim().replace(/\/+$/, "");
    // Tolerate a pasted full endpoint of any known kind, so a base left pointing at
    // /models can't produce ".../models/chat/completions". Longest suffix first.
    for (const known of ["/chat/completions", "/completions", "/models"]) {
        if (url.endsWith(known)) { url = url.slice(0, -known.length); break; }
    }
    if (!url.endsWith(path)) url += path;
    return url;
}

// A base URL typed without a scheme is resolved by fetch() as a path *relative to
// this page*. Supply the scheme the cloud/local warnings already assume — http for
// local hosts, https otherwise.
function normalizeApiUrl(raw) {
    const url = String(raw || "").trim();
    if (!url) throw new Error("Enter an API Base URL first, e.g. http://localhost:8080/v1.");
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(url)) return url;
    // Probed with a scheme attached: bare "localhost:1234" parses as scheme "localhost:".
    return (isLocalEndpoint("http://" + url) ? "http://" : "https://") + url;
}

// Capability endpoints (/props, /api/show) live at the server root, not under
// the OpenAI-compatible /v1 prefix, so strip that too.
function apiRoot(base) {
    let url = (base || "").trim().replace(/\/+$/, "");
    for (const known of ["/chat/completions", "/completions", "/models"]) {
        if (url.endsWith(known)) { url = url.slice(0, -known.length); break; }
    }
    return url.replace(/\/v\d+$/, "");
}

// Domains whose use means data leaves the local machine. Matched as hostname
// suffixes (never substrings, so "box.ai" can't match "x.ai").
const CLOUD_PROVIDERS = ["openai.com", "openrouter.ai", "groq.com", "anthropic.com", "together.xyz", "x.ai", "deepseek.com", "googleapis.com", "cloudflare.com", "mistral.ai", "perplexity.ai", "fireworks.ai", "cohere.com", "openai.azure.com"];
function detectCloudProvider(rawUrl) {
    let host;
    try { host = new URL(rawUrl).hostname; }
    catch {
        try { host = new URL("https://" + rawUrl).hostname; } catch { return null; }
    }
    host = host.toLowerCase();
    return CLOUD_PROVIDERS.find(p => host === p || host.endsWith("." + p)) || null;
}

// Hosts that keep the conversation on the user's own machine or LAN.
function isLocalEndpoint(rawUrl) {
    let host;
    try { host = new URL(rawUrl).hostname; }
    catch {
        try { host = new URL("https://" + rawUrl).hostname; } catch { return false; }
    }
    host = host.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
    if (host === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;            // IPv6 unique-local
    // The private-range tests below must only run against a real IPv4 literal —
    // matched as a prefix they would also accept "192.168.1.20.evil.com".
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
    if (host === "0.0.0.0") return true;
    if (/^127\./.test(host)) return true;                        // loopback
    if (/^10\./.test(host)) return true;                         // RFC1918
    if (/^192\.168\./.test(host)) return true;                   // RFC1918
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;    // RFC1918
    if (/^169\.254\./.test(host)) return true;                   // link-local
    return false;
}

// null when the endpoint keeps data local, otherwise a label for the destination.
function describeRemoteEndpoint(rawUrl) {
    if (!rawUrl || isLocalEndpoint(rawUrl)) return null;
    const known = detectCloudProvider(rawUrl);
    if (known) return known;
    try { return new URL(rawUrl).host; } catch { /* fall through */ }
    try { return new URL("https://" + rawUrl).host; } catch { /* fall through */ }
    return rawUrl;
}

// Browsers block http:// subresources from an https:// page, with loopback exempted.
function isBlockedMixedContent(rawUrl) {
    if (location.protocol !== "https:") return false;
    if (!/^http:\/\//i.test((rawUrl || "").trim())) return false;
    let host;
    try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return false; }
    return !(host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "[::1]" || host === "::1");
}

// One line of "what to do about it" shown under a failed request; the raw error stays
// visible above it. Pure, so it is unit-tested. "" means the error says enough.
// (HermitUI's wllama branch is dropped: the agent has no in-browser backend yet.)
function chatErrorHint(message, opts) {
    const { apiUrl = "", mixedContent = false } = opts || {};
    const msg = String(message || "");
    const status = Number((msg.match(/^Server Error (\d{3})\b/) || [])[1] || 0);
    if (status === 401 || status === 403) return "The server rejected the request's credentials — check the API key in Settings.";
    if (status === 404) return "Nothing answered at that address — check the API Base URL and the model name in Settings.";
    if (status === 429) return "Rate-limited or out of quota — wait a moment, or check your provider account.";
    if (status >= 500) return "The server failed while handling the request — its own logs will say why.";
    if (!status && /is not valid JSON|JSON\.parse|Unexpected token/i.test(msg)) {
        return "The server answered, but not with JSON — the API Base URL probably points at a web page instead of the API (it usually ends in /v1).";
    }
    if (isContextOverflowError(msg)) {
        return "The task history no longer fits the model's context — rewind to an earlier step, start a new session, or raise the server's context size.";
    }
    // Chrome says "Failed to fetch", Firefox "NetworkError when attempting to fetch
    // resource", Safari "Load failed" — all of them hide the actual reason.
    if (/Failed to fetch|NetworkError|^Load failed$/i.test(msg)) {
        if (mixedContent) return "This page is served over https, so the browser blocks plain-http servers on your network — use localhost, an https endpoint, or open the agent over http.";
        return isLocalEndpoint(apiUrl)
            ? `Couldn't reach ${apiUrl} — make sure the server is running and allows CORS from this page.`
            : `Couldn't reach ${apiUrl} — check the URL and your connection; the provider must also allow requests from a browser (CORS).`;
    }
    return "";
}

// The server refused the prompt as longer than its context (llama.cpp: "exceeds the
// available context size"; OpenAI: "maximum context length").
function isContextOverflowError(message) {
    return /context (?:length|size|window)|n_ctx|too many tokens|maximum context/i.test(String(message || ""));
}

// Does a Jinja chat template actually branch on the reasoning controls? Template
// engines silently ignore variables the template never references, so "not
// mentioned" is proof the kwargs would do nothing.
function parseReasoningTemplateSupport(templateText) {
    const t = typeof templateText === "string" ? templateText : "";
    const enableThinking = /enable_thinking/.test(t);
    const reasoningEffort = /reasoning_effort/.test(t);
    // Templates that validate the value enumerate the accepted set and raise on
    // anything else (Qwen3.5/3.8 reject the OpenAI-standard "high").
    let levels = null;
    const m = t.match(/reasoning_effort[\s\S]{0,240}?not\s+in\s*\(([^)]*)\)/);
    if (m) levels = (m[1].match(/['"]([A-Za-z_]+)['"]/g) || []).map(x => x.replace(/['"]/g, ""));
    if (!levels || !levels.length) levels = /xhigh/.test(t) ? ["low", "medium", "xhigh"] : ["low", "medium", "high"];
    return {
        supported: enableThinking || reasoningEffort,
        enableThinking,
        reasoningEffort,
        levels,
        maxLevel: levels.includes("xhigh") ? "xhigh" : "high",
    };
}

// Map a UI thinking level ("off" | "low" | "medium" | "high") onto request params.
// "high" means "whatever this template calls its maximum". A level the template
// doesn't accept is dropped rather than sent. Returns {} for an unknown level.
function buildReasoningParams(level, opts) {
    const o = opts || {};
    const levels = Array.isArray(o.levels) && o.levels.length ? o.levels : ["low", "medium", "high"];
    if (!["off", "low", "medium", "high"].includes(level)) return {};
    if (level === "off") return { chat_template_kwargs: { enable_thinking: false } };
    const wanted = level === "high" && levels.includes("xhigh") ? "xhigh" : level;
    const effort = levels.includes(wanted) ? wanted : null;
    return effort ? { reasoning_effort: effort } : {};
}

// The param names buildReasoningParams can introduce — stripped from a payload when a
// strict server rejects them.
const REASONING_PARAM_KEYS = ["reasoning_effort", "chat_template_kwargs"];

function looksLikeReasoningRejection(detail) {
    const d = String(detail || "");
    return REASONING_PARAM_KEYS.some(k => d.includes(k)) || /reasoning[ _]effort|enable[ _]thinking/i.test(d);
}

// ========== 3. Agent logic (pure) ==========
// DESIGN §5.3. The user's custom instructions are appended after it.
function buildSystemPrompt(instructions) {
    const base = `You are an agent that solves tasks by writing and running Python code. A human supervises you and may approve, edit or reject your steps.

Environment: Pyodide (CPython 3.13 compiled to WebAssembly) running inside the user's browser.
- The working directory is /workspace. Files the user gave you are there. Save deliverables there too: the user sees and downloads the files in /workspace.
- The standard library is available. Packages from the Pyodide distribution (numpy, pandas, matplotlib, scipy, scikit-learn, sympy, ...) are loaded automatically when you import them. There is no pip and no network access. input() does not work.
- There are no subprocesses: subprocess, os.system and multiprocessing fail. Run tests in-process, e.g. unittest.main(module="test_x", argv=["x"], exit=False).
- Variables persist between your steps until the interpreter is restarted (you will be told when that happens). Modules you write to /workspace are re-imported fresh at every step.
- It is a 32-bit platform: numpy's default integer is int32 and overflows silently past 2**31. Use dtype=np.int64 (or plain Python ints) for large values.
- matplotlib uses the Agg backend: save figures with plt.savefig("name.png"); plt.show() displays nothing.
- Each step has a time limit. A step that runs too long is killed.

Every reply must be exactly ONE of:
1. Short reasoning, then exactly ONE \`\`\`python code block. It is executed and you get its output back in an <observation> message. Write nothing after the code block. Only \`\`\`python blocks are executed. To show output, data or other non-Python text, use a \`\`\`text block.
2. Short reasoning, then one or more file actions (see below). They are applied in order and you get the results back in an <observation> message. Never put file actions and a \`\`\`python block in the same reply.
3. The final answer for the user, with NO python code block and no file actions, once the task is complete. Mention the files you created.
4. A line starting with "ask:" followed by your question, if you cannot continue without information from the user.

File actions read and change text files in /workspace directly. Prefer them over Python for reading, creating and editing source code, documents and other text files. Use Python to run code, process data and handle binary files. Start each tag on its own line:
<read_file path="notes.txt"/>
  Shows the file with line numbers, at most 400 lines at a time; add start="401" end="800" for more. The line numbers are not part of the file.
<write_file path="docs/report.md">
the complete content of the file
</write_file>
  Creates the file, or replaces all of its content. Folders are created as needed.
<edit_file path="app.py">
<old>
the exact text to replace, copied from the file
</old>
<new>
the replacement text
</new>
</edit_file>
  Replaces text in an existing file. Each <old> must match the file exactly, indentation included, and occur exactly once: add surrounding lines to make it unique. Several <old>/<new> pairs may follow each other inside one edit_file. An empty <new></new> deletes the text.
Paths are relative to /workspace. If any write or edit in a reply fails, none of that reply's changes are applied.

Rules:
- Inspect files before you modify them.
- Print short summaries, not whole files or huge data.
- Don't delete or overwrite the user's files unless the task requires it.
- Take one step at a time: you only see a step's output in the next turn.
- Code blocks are executed, never saved. To create a file, use <write_file> (or write it from your code). A "# reader.py" comment at the top of a block does not create a file.`;
    const extra = String(instructions || "").trim();
    return extra ? base + "\n\nAdditional instructions from the user:\n" + extra : base;
}

function formatBytes(n) {
    if (!Number.isFinite(n)) return "?";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
}

// files: [{ path, size }] → "a.csv (1.2 KB), b.py (300 B)", at most 50 names.
function formatFileList(files) {
    const list = (files || []).map(f => `${f.path} (${formatBytes(f.size)})`);
    if (!list.length) return "(empty)";
    return list.slice(0, 50).join(", ") + (list.length > 50 ? `, … ${list.length - 50} more` : "");
}

// The first user message: the task plus what is in the workspace right now.
function buildTaskMessage(task, files) {
    return `Task: ${task}\n\nFiles in /workspace: ${formatFileList(files)}`;
}

// Split a model reply into its reasoning (inline think tags) and the visible text.
function splitReply(raw, isFinal) {
    let reasoning = "", text = "";
    for (const seg of parseThinkSegments(String(raw || ""), isFinal)) {
        if (seg.type === "think") reasoning += (reasoning ? "\n\n" : "") + seg.content;
        else text += seg.content;
    }
    return { reasoning, text };
}

// DESIGN §5.1. Only fences tagged python run (a bare fence the model used to show
// output was once executed as code); the first block wins; an unclosed block means
// the stream was cut. File actions and a python block in one reply are "mixed": nothing
// runs. Returns { kind: code|files|mixed|ask|final|broken|cutoff|empty, ... }.
function parseReply(text, finishReason) {
    // File-action tags come out first, so fences inside a file's content aren't code.
    const fa = extractFileActions(text);
    const t = fa.rest;
    if (fa.unclosed) return { kind: finishReason === "length" ? "cutoff" : "broken", prose: t.trim(), unclosed: fa.unclosed };
    const re = /```(?:python3?|py)[ \t]*\r?\n([\s\S]*?)```/g;
    const blocks = [...t.matchAll(re)];
    if (fa.actions.length) {
        if (blocks.length || /```(?:python3?|py)[ \t]*$/m.test(t)) return { kind: "mixed", prose: t.trim(), actionCount: fa.actions.length };
        return { kind: "files", actions: fa.actions, prose: t.trim() };
    }
    if (blocks.length) {
        return { kind: "code", code: blocks[0][1], blockCount: blocks.length, prose: t.slice(0, blocks[0].index).trim() };
    }
    if (/```(?:python3?|py)[ \t]*$/m.test(t)) return { kind: finishReason === "length" ? "cutoff" : "broken", prose: t.trim() };
    if (finishReason === "length") return { kind: "cutoff", prose: t.trim() };
    const ask = t.match(/^[ \t]*\**ask:\**[ \t]*([\s\S]+)/im);
    if (ask) return { kind: "ask", question: ask[1].trim(), prose: t.slice(0, ask.index).trim() };
    if (!t.trim()) return { kind: "empty", prose: "" };
    return { kind: "final", answer: t.trim() };
}

// DESIGN §5.2: first 2 KB + last 4 KB of a step's output go to the model.
function truncateOutput(s, head = 2048, tail = 4096) {
    const str = String(s || "");
    if (str.length <= head + tail) return str;
    const omitted = str.length - head - tail;
    const kb = omitted >= 1024 ? Math.round(omitted / 1024) + " KB" : omitted + " characters";
    return str.slice(0, head) + `\n[… ${kb} omitted …]\n` + str.slice(-tail);
}

// before/after: { path: sha256 }. Sorted so the timeline and the model see a stable order.
function diffListings(before, after) {
    const added = [], modified = [], deleted = [];
    for (const p of Object.keys(after)) {
        if (!(p in before)) added.push(p);
        else if (before[p] !== after[p]) modified.push(p);
    }
    for (const p of Object.keys(before)) if (!(p in after)) deleted.push(p);
    return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

function formatChanges(changes) {
    const c = changes || {};
    const parts = [
        ...(c.added || []).map(x => "+" + (x.path || x)),
        ...(c.modified || []).map(x => "~" + (x.path || x)),
        ...(c.deleted || []).map(x => "-" + (x.path || x)),
    ];
    return parts.length ? parts.join("  ") : "none";
}

// DESIGN §2.3: gate on what the step *did*, not on what its code looks like.
// diff: { added, modified, deleted } (paths); origins: { path: "user" | "agent" }
// for the workspace *before* the step. Returns { verdict: "auto" | "ask", reasons }.
function classifyEffect(diff, origins, opts) {
    const o = opts || {};
    const maxFiles = o.maxFiles ?? LIMITS.riskMaxFiles;
    const maxBytes = o.maxBytes ?? LIMITS.riskMaxBytes;
    const reasons = [];
    for (const p of diff.deleted || []) if (origins[p] === "user") reasons.push(`deletes your file ${p}`);
    for (const p of diff.modified || []) if (origins[p] === "user") reasons.push(`overwrites your file ${p}`);
    const touched = (diff.added || []).length + (diff.modified || []).length + (diff.deleted || []).length;
    if (touched > maxFiles) reasons.push(`touches ${touched} files (more than ${maxFiles})`);
    if ((o.bytesWritten || 0) > maxBytes) reasons.push(`writes ${formatBytes(o.bytesWritten)} (more than ${formatBytes(maxBytes)})`);
    if ((o.netAttempts || []).length) reasons.push(`tried to use the network (blocked): ${o.netAttempts[0]}${o.netAttempts.length > 1 ? ` and ${o.netAttempts.length - 1} more` : ""}`);
    if (o.overLimit) reasons.push(o.overLimit);
    return { verdict: reasons.length ? "ask" : "auto", reasons };
}

// DESIGN §5.2: the observation envelope sent back as a user-role message.
function buildObservation(o) {
    const lines = [`<observation step="${o.step}" status="${o.status}">`];
    if (o.status === "rejected") lines.push("The user rejected this step." + (o.reason ? " Reason: " + o.reason : ""));
    if (typeof o.output === "string") {
        // File steps cap their own reads; truncating would cut a read in the middle.
        const out = o.truncate === false ? o.output : truncateOutput(o.output);
        lines.push(out.trim() ? out.replace(/\s+$/, "") : "(no output)");
    }
    if (o.changes) lines.push("files changed: " + formatChanges(o.changes));
    for (const n of o.notes || []) lines.push("note: " + n);
    lines.push("</observation>");
    return lines.join("\n");
}

// Append text to the last user message, or add a user message when the last one is
// the assistant's. Some chat templates reject two user messages in a row.
function appendToLastUserMessage(messages, text) {
    const last = messages[messages.length - 1];
    if (last && last.role === "user") last.content += "\n\n" + text;
    else messages.push({ role: "user", content: text });
    return messages;
}

// ---------- Context compaction (DESIGN §5.4) ----------
function messageChars(messages) {
    let n = 0;
    for (const m of messages || []) n += String(m.content || "").length;
    return n;
}

// A prompt-size estimate: characters times the tokens per character measured on the
// previous request (its prompt_tokens over the characters it sent); 1/3.5 until then.
function estimateTokens(messages, ratio) {
    return Math.ceil(messageChars(messages) * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1 / 3.5));
}

// The context size to compact against: the setting when set, else the server's n_ctx,
// else 0 (unknown: only a context-overflow error triggers a compaction).
function contextLimit(setting, serverCtx) {
    if (Number.isFinite(setting) && setting > 0) return setting;
    return Number.isFinite(serverCtx) && serverCtx > 0 ? serverCtx : 0;
}

// Is the history at pct % of the context or beyond? pct 0 turns auto-compaction off.
function compactionDue(estTokens, limit, pct) {
    return pct > 0 && limit > 0 && estTokens >= limit * pct / 100;
}

// Where to cut the history. messages[0] is the system prompt, messages[1] the task, and
// after that assistant and user turns alternate, one assistant message per step. The
// last keepSteps steps stay verbatim, so the kept tail starts at an assistant message
// and the roles still alternate once the summary is merged into the task message.
// Returns { cut, steps }: messages[2..cut) hold `steps` steps to summarise. null when
// fewer than minSteps would be summarised.
function planCompaction(messages, keepSteps, minSteps) {
    const at = [];
    for (let i = 2; i < messages.length; i++) if (messages[i].role === "assistant") at.push(i);
    const steps = at.length - Math.max(1, keepSteps);
    if (steps < Math.max(1, minSteps)) return null;
    return { cut: at[steps], steps };
}

// The task message without the summary an earlier compaction added to it.
function taskMessageBase(content) {
    const s = String(content || "");
    const i = s.indexOf("\n\n<history_summary ");
    return i < 0 ? s : s.slice(0, i);
}

// The summariser's request: the task message (with any earlier summary) and the steps
// up to cut, each clipped so the request itself fits where the agent's no longer does.
function buildCompactionRequest(messages, cut) {
    const system = `You compress the history of an AI agent's session so the agent can continue its task with less context. The agent solves tasks by writing Python and file actions that run in /workspace. You get its earlier turns (AGENT) and what came back (RESULT: <observation> envelopes, plus notes, answers and follow-ups from the user).

Write a summary the agent can continue from, under these headings, in this order, in at most 400 words:
## Task
The task and every follow-up, answer or instruction from the user. Keep their wording where it matters.
## Done so far
What was done and what it found, briefly. Keep the exact values the task needs: numbers, names, columns, paths.
## Files
Files in /workspace that were created or changed, and what each holds.
## Interpreter state
Variables, functions and imports later steps rely on. Say if the interpreter was restarted.
## Errors and dead ends
What failed and why, so it isn't repeated.
## Next
What the agent was about to do.

If the history starts with an earlier summary, fold it in. Write only the summary: no preamble, no code to run, no file actions.`;
    const parts = ["HISTORY:", taskMessageBase(messages[1].content)];
    const prev = String(messages[1].content).slice(taskMessageBase(messages[1].content).length).trim();
    if (prev) parts.push("EARLIER SUMMARY:\n" + prev);
    for (let i = 2; i < cut; i++) {
        const m = messages[i];
        parts.push(`--- ${m.role === "assistant" ? "AGENT" : "RESULT"} ---\n` + truncateOutput(m.content, 1500, 1500));
    }
    return [
        { role: "system", content: system },
        { role: "user", content: parts.join("\n\n") + "\n\nWrite the summary now." },
    ];
}

// The compacted history: system prompt, task message plus the summary of steps
// 1..toStep and the current file list, then the kept tail.
function buildCompactedMessages(messages, cut, summary, toStep, files) {
    const block = `<history_summary steps="1-${toStep}">\nSteps 1–${toStep} were summarised to save context. The interpreter and /workspace are unaffected.\n\n${String(summary).trim()}\n</history_summary>\n\nFiles in /workspace now: ${formatFileList(files)}`;
    return [
        { role: messages[0].role, content: messages[0].content },
        { role: "user", content: taskMessageBase(messages[1].content) + "\n\n" + block },
        ...messages.slice(cut).map(m => ({ role: m.role, content: m.content })),
    ];
}

// A relative workspace path that can't escape /workspace or confuse a zip tool.
function isSafeRelPath(p) {
    if (typeof p !== "string" || !p || p.length > LIMITS.maxPathLength) return false;
    if (/[\0\\]/.test(p) || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return false;
    return p.split("/").every(seg => seg !== "" && seg !== "." && seg !== "..");
}

// Normalise a path from an upload (webkitRelativePath, drag-drop entry) or null.
function normalizeUploadPath(raw) {
    const p = String(raw || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
    return isSafeRelPath(p) ? p : null;
}

// A Markdown fence longer than any backtick run inside the content.
function makeFence(content) {
    const runs = String(content || "").match(/`{3,}/g) || [];
    return "`".repeat(Math.max(3, ...runs.map(r => r.length + 1)));
}

// File names a model is likely to mean as deliverables. Deliberately a fixed list: a
// generic "name.ext" pattern would also match module paths like `os.path`.
const FILE_EXTENSIONS = ["py", "csv", "tsv", "txt", "md", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "xml", "html", "css", "js", "ts", "java", "c", "h", "cpp", "rs", "go", "sql", "sh", "log", "png", "jpg", "jpeg", "gif", "svg", "pdf", "xlsx", "parquet", "pkl", "ipynb", "zip"];

// A code step that starts with a "# reader.py" comment, as if that saved it — but no
// such file exists after the run. Models carry this habit over from chat UIs.
function filenameCommentHint(code, paths) {
    const first = String(code || "").split("\n").find(l => l.trim()) || "";
    const m = first.match(/^\s*#\s*(?:file(?:name)?\s*:\s*)?(\S+\.([A-Za-z0-9]+))\s*$/i);
    if (!m || !FILE_EXTENSIONS.includes(m[2].toLowerCase())) return "";
    const name = m[1].replace(/^\/?workspace\//, "");
    const have = new Set(paths || []);
    if (have.has(name) || [...have].some(p => p.split("/").pop() === name)) return "";
    return `Your code starts with "# ${m[1]}", but running a code block doesn't save it: there is no ${name} in /workspace. If you meant to create that file, use <write_file path="${name}">.`;
}

// Files a final answer presents (in backticks or bold) that aren't in the workspace.
function missingMentionedFiles(answer, paths) {
    const have = new Set(paths || []);
    const base = new Set([...have].map(p => p.split("/").pop()));
    const out = [];
    for (const m of String(answer || "").matchAll(/(?:`([^`\s]+)`|\*\*([^*\s]+)\*\*)/g)) {
        // "**`name.py`**" matches as bold with the backticks still inside.
        const raw = (m[1] || m[2]).replace(/`/g, "").replace(/^\/?workspace\//, "").replace(/[.,:;)]+$/, "");
        const ext = (raw.match(/\.([A-Za-z0-9]+)$/) || [])[1];
        if (!ext || !FILE_EXTENSIONS.includes(ext.toLowerCase()) || /[()=<>]/.test(raw)) continue;
        if (have.has(raw) || base.has(raw) || out.includes(raw)) continue;
        out.push(raw);
    }
    return out;
}

// File actions (DESIGN §5.1): read, write and edit text files without Python. The tag
// names are also the tool names a native tool-call parser will feed into
// applyFileActions (DESIGN §5.5), which knows nothing about the wire format.
const FILE_TOOLS = ["read_file", "write_file", "edit_file"];

// A path as models write it ("/workspace/x", "./x") made relative, or null if unsafe.
function normalizeActionPath(raw) {
    const p = String(raw || "").trim().replace(/^\/?workspace\//, "").replace(/^(?:\.\/)+/, "");
    return isSafeRelPath(p) ? p : null;
}

function parseTagAttrs(s) {
    const out = {};
    for (const m of String(s || "").matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/g)) {
        out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
    }
    return out;
}

// Tags count only at the start of a line. Content runs to the first closing tag, so a
// file can hold ``` fences but not its own closing tag. One newline after an opening
// tag is dropped; a write keeps its trailing newline, <old>/<new> drop one at each end.
// Returns { actions: [{ tool, args, error? }], rest (the reply without the tags),
// unclosed (the tool name of a tag that never closed, or "") }.
function extractFileActions(text) {
    const t = String(text || "");
    const open = /^[ \t]*<(read_file|write_file|edit_file)\b([^>\n]*?)(\/?)>/gm;
    const lead = (s) => s.replace(/^\r?\n/, "");
    const snippet = (s) => lead(s).replace(/\r?\n$/, "");
    const actions = [];
    let rest = "", pos = 0, unclosed = "", m;
    while ((m = open.exec(t))) {
        const tool = m[1], attrs = parseTagAttrs(m[2]), selfClosing = m[3] === "/";
        rest += t.slice(pos, m.index);
        let end = m.index + m[0].length, body = "";
        if (tool === "read_file") {
            const close = !selfClosing && t.slice(end).match(/^\s*<\/read_file>/);
            if (close) end += close[0].length;
        } else if (!selfClosing) {
            const ci = t.indexOf(`</${tool}>`, end);
            if (ci < 0) { unclosed = tool; pos = t.length; break; }
            body = t.slice(end, ci);
            end = ci + tool.length + 3;
        }
        pos = open.lastIndex = end;
        const action = { tool, args: { path: attrs.path === undefined ? "" : attrs.path } };
        const path = normalizeActionPath(attrs.path);
        if (attrs.path === undefined || !String(attrs.path).trim()) action.error = `<${tool}> needs a path attribute, e.g. <${tool} path="notes.txt">.`;
        else if (!path) action.error = `Unsafe path ${JSON.stringify(String(attrs.path).slice(0, 100))}: use a relative path inside /workspace.`;
        else action.args.path = path;
        if (selfClosing && tool !== "read_file") action.error = action.error || `<${tool} … /> has no content: put it between <${tool} path="…"> and </${tool}>.`;
        if (tool === "read_file") {
            for (const [attr, key] of [["start", "start_line"], ["end", "end_line"]]) {
                if (attrs[attr] === undefined) continue;
                const n = Number(attrs[attr]);
                if (Number.isInteger(n) && n >= 1) action.args[key] = n;
                else action.error = action.error || `${attr}="${attrs[attr]}" is not a line number (lines start at 1).`;
            }
        } else if (tool === "write_file") {
            action.args.content = lead(body);
        } else {
            const edits = [...body.matchAll(/<old>([\s\S]*?)<\/old>\s*<new>([\s\S]*?)<\/new>/g)].map(e => ({ old_text: snippet(e[1]), new_text: snippet(e[2]) }));
            action.args.edits = edits;
            if (!edits.length) action.error = action.error || "<edit_file> needs at least one <old>…</old> <new>…</new> pair.";
        }
        actions.push(action);
    }
    rest += t.slice(pos);
    return { actions, rest, unclosed };
}

// Text content of a file, or null for binary (NUL bytes or invalid UTF-8).
function decodeTextFile(bytes) {
    if (!bytes || bytes.includes(0)) return null;
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) { return null; }
}

function countOccurrences(hay, needle) {
    let n = 0;
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
    return n;
}

// Run file actions against the workspace without touching it. ws: { paths: [...],
// read(path) -> Uint8Array | null }. Actions run in order on an overlay, so a read sees
// an earlier write. Writes and edits are all-or-nothing: the first one that fails stops
// the batch and nothing is written. Returns { results: [{ tool, path, ok, message,
// output?, startLine?, endLine?, edits? }], writes: Map(path -> text), failed }.
function applyFileActions(actions, ws, opts) {
    const lim = { ...LIMITS, ...(opts || {}) };
    const overlay = new Map();
    const paths = new Set(ws.paths || []);
    const results = [];
    let budget = lim.readMaxTotalChars, failed = false;
    const current = (p) => {
        if (overlay.has(p)) return { text: overlay.get(p) };
        const bytes = paths.has(p) ? ws.read(p) : null;
        if (!bytes) return null;
        const text = decodeTextFile(bytes);
        return text === null ? { binary: bytes.length } : { text };
    };
    const lineCount = (s) => (s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0));
    for (const a of actions || []) {
        const path = a.args && a.args.path || "";
        const r = { tool: a.tool, path, ok: false, message: "" };
        results.push(r);
        if (failed) { r.message = "not run: an earlier action failed"; continue; }
        if (a.tool === "edit_file") r.edits = ((a.args && a.args.edits) || []).map(e => ({ old: e.old_text, new: e.new_text }));
        const fail = (msg) => { r.message = msg; if (a.tool !== "read_file") failed = true; };
        if (a.error || !FILE_TOOLS.includes(a.tool)) { fail(a.error || `Unknown file action ${a.tool}.`); continue; }
        const cur = current(path);
        if (a.tool === "read_file") {
            if (!cur) { fail(`There is no file ${path} in /workspace.`); continue; }
            if (cur.binary !== undefined) { fail(`${path} is a binary file (${formatBytes(cur.binary)}); inspect it with python.`); continue; }
            if (budget <= 0) { fail("Not read: this reply's read budget is used up. Read it in your next reply."); continue; }
            const lines = cur.text.split(/\r?\n/);
            if (cur.text.endsWith("\n")) lines.pop();
            const total = cur.text === "" ? 0 : lines.length;
            const start = a.args.start_line || 1;
            if (total === 0) { r.ok = true; r.message = "empty file"; r.output = "(empty file)"; continue; }
            if (start > total) { fail(`${path} has only ${total} line${total === 1 ? "" : "s"}.`); continue; }
            const maxEnd = Math.min(total, start + lim.readMaxLines - 1);
            const want = Math.min(total, a.args.end_line ? Math.max(start, a.args.end_line) : maxEnd);
            const end = Math.min(want, maxEnd);
            const width = String(end).length;
            const cap = Math.min(lim.readMaxChars, budget);
            const out = [];
            let used = 0, last = start - 1;
            for (let i = start; i <= end; i++) {
                let line = lines[i - 1];
                if (line.length > lim.readMaxLineChars) line = line.slice(0, lim.readMaxLineChars) + ` […${line.length - lim.readMaxLineChars} more characters]`;
                const row = String(i).padStart(width) + "\t" + line;
                if (used + row.length + 1 > cap && out.length) break;
                out.push(row);
                used += row.length + 1;
                last = i;
            }
            budget -= used;
            r.ok = true;
            r.startLine = start;
            r.endLine = last;
            r.message = `lines ${start}–${last} of ${total}`;
            r.output = out.join("\n") + (last < want || (!a.args.end_line && last < total) ? `\n[… ${total} lines in total; continue with start="${last + 1}" …]` : "");
            continue;
        }
        if (a.tool === "write_file") {
            const content = String(a.args.content ?? "");
            const exists = (p) => paths.has(p) || overlay.has(p);
            if ([...paths, ...overlay.keys()].some(p => p.startsWith(path + "/"))) { fail(`${path} is a folder.`); continue; }
            const segs = path.split("/");
            const parent = segs.slice(1).map((_, i) => segs.slice(0, i + 1).join("/")).find(exists);
            if (parent) { fail(`${parent} is a file, so it can't contain ${path}.`); continue; }
            r.ok = true;
            if (cur && cur.text === content) { r.message = "unchanged (same content)"; continue; }
            overlay.set(path, content);
            const size = formatBytes(new TextEncoder().encode(content).length);
            r.message = `${cur ? "replaced" : "created"} (${lineCount(content)} line${lineCount(content) === 1 ? "" : "s"}, ${size})`;
            continue;
        }
        // edit_file
        if (!cur) { fail(`There is no file ${path} in /workspace. Create it with <write_file>.`); continue; }
        if (cur.binary !== undefined) { fail(`${path} is a binary file; it can't be edited as text.`); continue; }
        let text = cur.text;
        const crlf = text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
        const fix = (s) => (crlf ? String(s).replace(/\r?\n/g, "\r\n") : String(s));
        const flat = (s) => s.split(/\r?\n/).map(l => l.trim()).join("\n");
        const edits = a.args.edits || [];
        let error = "";
        for (let k = 0; k < edits.length && !error; k++) {
            const which = edits.length > 1 ? `change ${k + 1} of ${edits.length}: ` : "";
            const oldT = fix(edits[k].old_text), newT = fix(edits[k].new_text);
            if (!oldT) { error = which + "<old> is empty. Copy the text to replace from the file."; break; }
            if (oldT === newT) { error = which + "<old> and <new> are identical."; break; }
            const n = countOccurrences(text, oldT);
            if (n === 0) {
                error = which + (flat(oldT).trim() && flat(text).includes(flat(oldT))
                    ? `the <old> text differs from ${path} only in whitespace or indentation. Copy it exactly (read_file shows the file).`
                    : `the <old> text was not found in ${path}. Read the file and copy the text exactly.`);
            } else if (n > 1) {
                error = which + `the <old> text matches ${n} times in ${path}. Include more surrounding lines so it matches once.`;
            } else {
                const i = text.indexOf(oldT);
                text = text.slice(0, i) + newT + text.slice(i + oldT.length);
            }
        }
        if (error) { fail(error); continue; }
        overlay.set(path, text);
        r.ok = true;
        r.message = `edited (${edits.length} change${edits.length === 1 ? "" : "s"})`;
    }
    return { results, writes: failed ? new Map() : overlay, failed };
}

// What the model gets back from a file step (the observation body).
function formatFileResults(results, failed) {
    const out = [];
    results.forEach((r, i) => {
        const head = `[${i + 1}] ${r.tool} ${r.path || "?"}: ${r.ok ? r.message : "ERROR: " + r.message}`;
        out.push(r.output !== undefined ? head + "\n" + r.output : head);
    });
    if (failed) {
        const i = results.findIndex(r => !r.ok && r.tool !== "read_file");
        out.push(`No file changes were applied, because action ${i + 1} failed. Fix it and send all of the changes again.`);
    }
    return out.join("\n");
}

// ========== 4. Zip + session archive (pure) ==========
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();

function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

async function streamThrough(bytes, transform, maxOut) {
    const reader = new Blob([bytes]).stream().pipeThrough(transform).getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (maxOut !== undefined && total > maxOut) {
            reader.cancel().catch(() => {});
            throw new Error("zip entry inflates to more than its declared size");
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
}

// sha256 as lowercase hex. WebCrypto needs a secure context (file://, https, localhost);
// a page served over plain http on a LAN falls back to the small JS version.
async function sha256Hex(bytes) {
    if (globalThis.crypto && crypto.subtle) {
        const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        return Array.from(d, b => b.toString(16).padStart(2, "0")).join("");
    }
    return sha256HexJs(bytes);
}

function sha256HexJs(bytes) {
    const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
    const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const len = bytes.length;
    const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
    dv.setUint32(padded.length - 4, (len << 3) >>> 0);
    const W = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
            const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
            W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = H;
        for (let i = 0; i < 64; i++) {
            const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return Array.from(H, x => x.toString(16).padStart(8, "0")).join("");
}

// DESIGN §3.2: a small zip writer. entries: [{ path, data: Uint8Array }]. Deflates
// each entry (stored when that doesn't help), UTF-8 names, no ZIP64 (the size limits
// keep archives far below 4 GB).
async function zipWrite(entries, date) {
    const d = date instanceof Date ? date : new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const enc = new TextEncoder();
    const locals = [], centrals = [];
    let offset = 0;
    for (const e of entries) {
        const name = enc.encode(e.path);
        const raw = e.data instanceof Uint8Array ? e.data : enc.encode(String(e.data ?? ""));
        let data = raw.length ? await streamThrough(raw, new CompressionStream("deflate-raw")) : raw;
        let method = 8;
        if (!raw.length || data.length >= raw.length) { data = raw; method = 0; }
        const crc = crc32(raw);
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
        lh.setUint16(8, method, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
        lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, raw.length, true);
        lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
        ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true); ch.setUint16(12, dosTime, true);
        ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
        ch.setUint32(24, raw.length, true); ch.setUint16(28, name.length, true);
        ch.setUint32(42, offset, true);
        locals.push(new Uint8Array(lh.buffer), name, data);
        centrals.push(new Uint8Array(ch.buffer), name);
        offset += 30 + name.length + data.length;
    }
    const cdSize = centrals.reduce((n, c) => n + c.length, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true);
    const parts = [...locals, ...centrals, new Uint8Array(eocd.buffer)];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

// DESIGN §3.3: the reader treats the archive as untrusted. It enforces entry-count
// and total-size limits (declared *and* actual, which also stops zip bombs), rejects
// unsafe paths, encryption and ZIP64, and verifies every CRC. Directory entries are
// skipped. Returns [{ path, data }].
async function zipRead(bytes, limits) {
    const lim = Object.assign({ maxEntries: LIMITS.maxArchiveEntries, maxBytes: LIMITS.maxArchiveBytes }, limits || {});
    if (!(bytes instanceof Uint8Array) || bytes.length < 22) throw new Error("Not a zip file (too small).");
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a zip file (no end-of-central-directory record).");
    const count = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    if (count === 0xFFFF || cdOffset === 0xFFFFFFFF) throw new Error("ZIP64 archives are not supported.");
    if (count > lim.maxEntries) throw new Error(`The archive has ${count} entries (limit ${lim.maxEntries}).`);
    if (cdOffset + cdSize > eocd) throw new Error("Corrupt zip (central directory out of range).");
    const dec = new TextDecoder("utf-8", { fatal: false });
    const out = [];
    const seen = new Set();
    let total = 0;
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt zip (bad central directory entry).");
        const flags = dv.getUint16(p + 8, true);
        const method = dv.getUint16(p + 10, true);
        const crc = dv.getUint32(p + 16, true);
        const csize = dv.getUint32(p + 20, true);
        const usize = dv.getUint32(p + 24, true);
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        const localOff = dv.getUint32(p + 42, true);
        const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
        if (flags & 1) throw new Error(`Encrypted zip entries are not supported (${name}).`);
        if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || localOff === 0xFFFFFFFF) throw new Error("ZIP64 archives are not supported.");
        const isDir = name.endsWith("/");
        const clean = isDir ? name.slice(0, -1) : name;
        if (!isSafeRelPath(clean)) throw new Error(`Unsafe path in archive: ${JSON.stringify(name)}`);
        if (isDir) continue;
        if (seen.has(clean)) throw new Error(`Duplicate path in archive: ${clean}`);
        seen.add(clean);
        total += usize;
        if (total > lim.maxBytes) throw new Error(`The archive unpacks to more than ${formatBytes(lim.maxBytes)}.`);
        if (localOff + 30 > bytes.length || dv.getUint32(localOff, true) !== 0x04034b50) throw new Error(`Corrupt zip (bad local header for ${clean}).`);
        const start = localOff + 30 + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true);
        if (start + csize > bytes.length) throw new Error(`Corrupt zip (data out of range for ${clean}).`);
        const comp = bytes.subarray(start, start + csize);
        let data;
        if (method === 0) data = comp.slice();
        else if (method === 8) data = await streamThrough(comp, new DecompressionStream("deflate-raw"), usize);
        else throw new Error(`Unsupported compression method ${method} (${clean}).`);
        if (data.length !== usize) throw new Error(`Size mismatch in ${clean}.`);
        if (crc32(data) !== crc) throw new Error(`CRC mismatch in ${clean}: the archive is corrupt.`);
        out.push({ path: clean, data });
    }
    return out;
}

// Strip runtime-only fields (leading underscore) so they never reach an export.
function cleanForExport(value) {
    return JSON.parse(JSON.stringify(value, (k, v) => (k.startsWith("_") ? undefined : v)));
}

// A human-readable log, for reading a session without the app (DESIGN §3.1).
function transcriptMarkdown(session) {
    const s = session || {};
    const block = (lang, body) => { const f = makeFence(body); return `${f}${lang}\n${String(body).replace(/\n$/, "")}\n${f}`; };
    const md = [`# HermitUI Agent session`, ``, `- Created: ${s.createdAt || "?"}`, `- Model: ${(s.settings && s.settings.model) || "?"}`, ``];
    for (const item of s.timeline || []) {
        if (item.type === "task") md.push(`## Task`, ``, item.text, ``);
        else if (item.type === "user") md.push(`## ${item.kind === "answer" ? "User answer" : item.kind === "followup" ? "Follow-up" : "User note"}`, ``, item.text, ``);
        else if (item.type === "note") md.push(`> ${String(item.text).replace(/\n/g, "\n> ")}`, ``);
        else if (item.type === "error") md.push(`> **Error:** ${item.text}`, ``);
        else if (item.type === "compaction") md.push(`## History compacted — steps ${item.fromStep}–${item.toStep}`, ``, `<details><summary>Summary the model continued from</summary>`, ``, item.summary || "", ``, `</details>`, ``);
        else if (item.type === "step") {
            const verdict = item.decision ? ` · ${item.decision}${item.decidedBy ? " by " + item.decidedBy : ""}` : "";
            md.push(`## Step ${item.n} — ${item.kind}${item.status ? " · " + item.status : ""}${verdict}`, ``);
            if (item.reasoning) md.push(`<details><summary>Reasoning</summary>`, ``, block("text", item.reasoning), ``, `</details>`, ``);
            if (item.kind === "final") md.push(item.content || "", ``);
            else if (item.kind === "ask") md.push(`**Question:** ${item.question || ""}`, ``);
            else {
                if (item.prose) md.push(item.prose, ``);
                if (item.proposedCode) md.push(block("python", item.proposedCode), ``);
                for (const a of item.fileActions || []) {
                    md.push(`- \`${a.tool}\` ${a.path}: ${a.ok ? "" : "failed: "}${a.message}`);
                    for (const e of a.edits || []) md.push(``, block("text", e.old), ``, `replaced by`, ``, block("text", e.new));
                }
                if ((item.fileActions || []).length) md.push(``);
                if (item.edited && item.ranCode) md.push(`Edited by the user before it ran:`, ``, block("python", item.ranCode), ``);
                if (item.output) md.push(`Output:`, ``, block("text", item.output), ``);
                if (item.changes) md.push(`Files changed: ${formatChanges(item.changes)}`, ``);
                if (item.risk && item.risk.reasons && item.risk.reasons.length) md.push(`Held because it ${item.risk.reasons.join("; ")}.`, ``);
                if (item.rejectReason) md.push(`Rejection reason: ${item.rejectReason}`, ``);
            }
        }
    }
    return md.join("\n");
}

// state: { session, files: Map(path -> { hash, origin }), blobs: Map(hash -> bytes),
// checkpoints: [{ timelineLength, msgCount, stepCount, epoch, label, files: { path: { hash, origin } } }] }
// Returns zip entries (DESIGN §3.1). Checkpoint blobs already in workspace/ aren't repeated.
function buildSessionArchive(state, opts) {
    const o = opts || {};
    const enc = new TextEncoder();
    const json = (v) => enc.encode(JSON.stringify(v, null, 1));
    const session = cleanForExport(state.session);
    session.origins = {};
    for (const [p, f] of state.files) session.origins[p] = f.origin;
    const entries = [
        { path: "manifest.json", data: json({ format: SESSION_FORMAT, formatVersion: SESSION_FORMAT_VERSION, appVersion: APP_VERSION, createdAt: o.now || new Date().toISOString() }) },
        { path: "session.json", data: json(session) },
        { path: "transcript.md", data: enc.encode(transcriptMarkdown(session)) },
    ];
    const inWorkspace = new Set();
    for (const [p, f] of [...state.files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const bytes = state.blobs.get(f.hash);
        if (!bytes) throw new Error(`Missing file content for ${p}`);
        entries.push({ path: "workspace/" + p, data: bytes });
        inWorkspace.add(f.hash);
    }
    if (o.includeCheckpoints && state.checkpoints && state.checkpoints.length) {
        entries.push({ path: "checkpoints/index.json", data: json(state.checkpoints.map(cleanForExport)) });
        const written = new Set();
        for (const cp of state.checkpoints) {
            for (const f of Object.values(cp.files)) {
                if (inWorkspace.has(f.hash) || written.has(f.hash)) continue;
                const bytes = state.blobs.get(f.hash);
                if (!bytes) throw new Error(`Missing checkpoint content ${f.hash}`);
                entries.push({ path: "checkpoints/blobs/" + f.hash, data: bytes });
                written.add(f.hash);
            }
        }
    }
    return entries;
}

function validateManifest(m) {
    if (!m || typeof m !== "object" || m.format !== SESSION_FORMAT) throw new Error("This is not a HermitUI Agent session (manifest.json is missing or has the wrong format id).");
    if (!Number.isInteger(m.formatVersion) || m.formatVersion < 1) throw new Error("manifest.json has no valid formatVersion.");
    if (m.formatVersion > SESSION_FORMAT_VERSION) throw new Error(`This session was made with a newer HermitUI Agent (format ${m.formatVersion}; this version reads up to ${SESSION_FORMAT_VERSION}).`);
    return m;
}

// DESIGN §3.3: validate session.json against the expected shape. Unknown fields are
// ignored, missing required ones fail loudly, and every kept field is coerced to its
// type, so nothing imported can carry markup or functions into the app.
function validateSession(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("session.json is not an object.");
    const str = (v) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
    const num = (v, d) => (Number.isFinite(v) ? v : d);
    const strArr = (v) => (Array.isArray(v) ? v.filter(x => typeof x === "string") : []);
    if (typeof raw.task !== "string") throw new Error("session.json: 'task' is missing.");
    if (!Array.isArray(raw.messages)) throw new Error("session.json: 'messages' is missing.");
    if (!Array.isArray(raw.timeline)) throw new Error("session.json: 'timeline' is missing.");
    const msgList = (arr, where) => arr.map((m, i) => {
        if (!m || !["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string") throw new Error(`session.json: ${where} ${i} is malformed.`);
        return { role: m.role, content: m.content };
    });
    const messages = msgList(raw.messages, "message");
    if (raw.compactions !== undefined && !Array.isArray(raw.compactions)) throw new Error("session.json: 'compactions' is not a list.");
    const compactions = (raw.compactions || []).map((c, i) => {
        if (!c || !Array.isArray(c.before) || !Number.isInteger(c.fromStep) || !Number.isInteger(c.toStep) || c.fromStep < 1 || c.toStep < c.fromStep) throw new Error(`session.json: compaction ${i} is malformed.`);
        return { before: msgList(c.before, `compaction ${i} message`), fromStep: c.fromStep, toStep: c.toStep };
    });
    const fileList = (v, withPrev) => (Array.isArray(v) ? v : []).filter(x => x && isSafeRelPath(x.path)).map(x => {
        const r = { path: x.path, hash: /^[0-9a-f]{64}$/.test(x.hash) ? x.hash : "", size: num(x.size, 0) };
        if (withPrev) r.prevHash = /^[0-9a-f]{64}$/.test(x.prevHash) ? x.prevHash : "";
        return r;
    });
    const STEP_STRINGS = ["kind", "phase", "reasoning", "content", "prose", "question", "proposedCode", "ranCode", "output", "status", "decision", "decidedBy", "rejectReason", "finishReason", "startedAt", "endedAt"];
    const timeline = raw.timeline.map((it, i) => {
        if (!it || typeof it !== "object") throw new Error(`session.json: timeline item ${i} is malformed.`);
        const ts = str(it.ts);
        switch (it.type) {
            case "task": return { type: "task", text: str(it.text), files: strArr(it.files), ts, checkpoint: Number.isInteger(it.checkpoint) ? it.checkpoint : undefined };
            case "user": return { type: "user", text: str(it.text), kind: ["guidance", "answer", "followup"].includes(it.kind) ? it.kind : "guidance", ts };
            case "note": return { type: "note", text: str(it.text), tone: ["info", "warn", "error"].includes(it.tone) ? it.tone : "info", ts };
            case "error": return { type: "error", text: str(it.text), hint: str(it.hint), ts };
            case "compaction": return { type: "compaction", reason: it.reason === "overflow" ? "overflow" : "threshold", fromStep: num(it.fromStep, 0), toStep: num(it.toStep, 0), summary: str(it.summary), tokensBefore: num(it.tokensBefore, 0), tokensAfter: num(it.tokensAfter, 0), ts };
            case "step": {
                const s = { type: "step", n: num(it.n, 0), ts, checkpoint: Number.isInteger(it.checkpoint) ? it.checkpoint : undefined };
                for (const k of STEP_STRINGS) s[k] = str(it[k]);
                s.edited = it.edited === true;
                s.notes = strArr(it.notes);
                s.netAttempts = strArr(it.netAttempts);
                s.blockCount = num(it.blockCount, 0);
                s.changes = it.changes && typeof it.changes === "object"
                    ? { added: fileList(it.changes.added), modified: fileList(it.changes.modified, true), deleted: fileList(it.changes.deleted, true) }
                    : null;
                s.risk = it.risk && typeof it.risk === "object" ? { verdict: str(it.risk.verdict), reasons: strArr(it.risk.reasons) } : null;
                s.stats = cleanStepStats(it.stats);
                if (Array.isArray(it.fileActions)) {
                    s.fileActions = it.fileActions.filter(a => a && typeof a === "object" && FILE_TOOLS.includes(a.tool)).map(a => {
                        const r = { tool: a.tool, path: str(a.path), ok: a.ok === true, message: str(a.message) };
                        if (Number.isInteger(a.startLine)) r.startLine = a.startLine;
                        if (Number.isInteger(a.endLine)) r.endLine = a.endLine;
                        if (Array.isArray(a.edits)) r.edits = a.edits.filter(e => e && typeof e === "object").map(e => ({ old: str(e.old), new: str(e.new) }));
                        return r;
                    });
                }
                // Nothing restores mid-flight: a step that was waiting or running when the
                // session was exported is shown as interrupted.
                if (s.phase && s.phase !== "done") { s.phase = "done"; s.status = s.status || "interrupted"; }
                return s;
            }
            default: throw new Error(`session.json: timeline item ${i} has unknown type ${JSON.stringify(it.type)}.`);
        }
    });
    const st = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
    const origins = {};
    if (raw.origins && typeof raw.origins === "object") {
        for (const [p, o] of Object.entries(raw.origins)) if (isSafeRelPath(p) && (o === "user" || o === "agent")) origins[p] = o;
    }
    return {
        task: raw.task,
        createdAt: str(raw.createdAt),
        status: str(raw.status) || "paused",
        messages,
        compactions,
        timeline,
        origins,
        stepCount: num(raw.stepCount, timeline.filter(t => t.type === "step").length),
        tokens: { prompt: num(raw.tokens && raw.tokens.prompt, 0), completion: num(raw.tokens && raw.tokens.completion, 0) },
        activeMs: num(raw.activeMs, 0),
        settings: {
            apiUrl: str(st.apiUrl), model: str(st.model),
            autonomy: ["approve", "risk", "autopilot"].includes(st.autonomy) ? st.autonomy : "risk",
            stepLimit: num(st.stepLimit, 20), stepTimeoutSec: num(st.stepTimeoutSec, 60),
            maxTokens: num(st.maxTokens, 8192), effort: ["off", "low", "medium", "high", "default"].includes(st.effort) ? st.effort : "low",
            autoCompactPct: Math.min(95, Math.max(0, num(st.autoCompactPct, 85))), contextSize: Math.max(0, num(st.contextSize, 0)),
        },
    };
}

// The reverse of buildSessionArchive. entries come from zipRead (already path-checked).
async function parseSessionArchive(entries) {
    const byPath = new Map(entries.map(e => [e.path, e.data]));
    const dec = new TextDecoder();
    const readJson = (p) => {
        const b = byPath.get(p);
        if (!b) return undefined;
        try { return JSON.parse(dec.decode(b)); } catch (e) { throw new Error(`${p} is not valid JSON.`); }
    };
    validateManifest(readJson("manifest.json"));
    const rawSession = readJson("session.json");
    if (rawSession === undefined) throw new Error("The archive has no session.json.");
    const session = validateSession(rawSession);
    const files = new Map(), blobs = new Map();
    let total = 0;
    for (const [p, data] of byPath) {
        if (!p.startsWith("workspace/")) continue;
        const rel = p.slice("workspace/".length);
        if (!isSafeRelPath(rel)) throw new Error(`Unsafe workspace path: ${rel}`);
        total += data.length;
        const hash = await sha256Hex(data);
        blobs.set(hash, data);
        files.set(rel, { hash, origin: session.origins[rel] || "user" });
    }
    if (files.size > LIMITS.maxFiles) throw new Error(`The workspace has ${files.size} files (limit ${LIMITS.maxFiles}).`);
    if (total > LIMITS.maxWorkspaceBytes) throw new Error(`The workspace is larger than ${formatBytes(LIMITS.maxWorkspaceBytes)}.`);
    for (const [p, data] of byPath) {
        if (!p.startsWith("checkpoints/blobs/")) continue;
        const name = p.slice("checkpoints/blobs/".length);
        const hash = await sha256Hex(data);
        if (hash !== name) throw new Error(`Checkpoint blob ${name} does not match its content.`);
        blobs.set(hash, data);
    }
    let checkpoints = [];
    const rawCps = readJson("checkpoints/index.json");
    if (rawCps !== undefined) {
        if (!Array.isArray(rawCps)) throw new Error("checkpoints/index.json is not a list.");
        checkpoints = rawCps.map((cp, i) => {
            const bad = (why) => new Error(`checkpoints/index.json: entry ${i} ${why}.`);
            if (!cp || typeof cp !== "object" || !cp.files || typeof cp.files !== "object") throw bad("is malformed");
            const ints = ["timelineLength", "msgCount", "stepCount"];
            for (const k of ints) if (!Number.isInteger(cp[k]) || cp[k] < 0) throw bad(`has no valid ${k}`);
            // epoch: how many compactions had happened (absent in exports from before them).
            const epoch = cp.epoch === undefined ? session.compactions.length : cp.epoch;
            if (!Number.isInteger(epoch) || epoch < 0 || epoch > session.compactions.length) throw bad("has no valid epoch");
            const histLen = epoch < session.compactions.length ? session.compactions[epoch].before.length : session.messages.length;
            if (cp.timelineLength > session.timeline.length || cp.msgCount > histLen) throw bad("points past the end of the session");
            const out = {};
            for (const [p, f] of Object.entries(cp.files)) {
                if (!isSafeRelPath(p) || !f || !/^[0-9a-f]{64}$/.test(f.hash) || !["user", "agent"].includes(f.origin)) throw bad(`has a bad file entry ${JSON.stringify(p)}`);
                if (!blobs.has(f.hash)) throw bad(`references missing content for ${p}`);
                out[p] = { hash: f.hash, origin: f.origin };
            }
            return { timelineLength: cp.timelineLength, msgCount: cp.msgCount, stepCount: cp.stepCount, epoch, label: typeof cp.label === "string" ? cp.label : "", files: out };
        });
    }
    return { session, files, blobs, checkpoints };
}

// ========== 5. Python worker client ==========
// The main thread owns the canonical workspace; the worker is disposable (DESIGN §4.1).
const PY = {
    worker: null, gen: 0, seq: 0, pending: new Map(), state: "off",
    corePromise: null, readyPromise: null, info: null, syncedVersion: -1,
};

// The Pyodide core: inlined by build.py (gzip + base64), or fetched from the pinned
// CDN when running the unbuilt source.
function loadPyodideCore() {
    if (!PY.corePromise) {
        PY.corePromise = (async () => {
            const names = { loaderJs: "pyodide.js", asmJs: "pyodide.asm.js", wasm: "pyodide.asm.wasm", stdlib: "python_stdlib.zip", lock: "pyodide-lock.json" };
            const inl = window.__PYODIDE_INLINE__;
            const core = {};
            for (const [key, file] of Object.entries(names)) {
                let bytes;
                if (inl) bytes = await gunzipToBytes(inl[file]);
                else {
                    const res = await fetch(PYODIDE_CDN + file);
                    if (!res.ok) throw new Error(`Couldn't download ${file} from the Pyodide CDN (${res.status}).`);
                    bytes = new Uint8Array(await res.arrayBuffer());
                }
                core[key] = key === "loaderJs" || key === "asmJs" ? new TextDecoder().decode(bytes) : bytes.buffer;
            }
            return core;
        })();
        PY.corePromise.catch(() => { PY.corePromise = null; });
    }
    return PY.corePromise;
}

function rejectAllPending(reason) {
    for (const p of PY.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    PY.pending.clear();
}

function startWorker() {
    const src = "(" + hermitWorkerMain.toString() + ")();";
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const w = new Worker(url);   // classic on purpose, see worker.js
    URL.revokeObjectURL(url);
    const gen = PY.gen;
    w.onmessage = (e) => {
        if (gen !== PY.gen) return;
        const d = e.data;
        // Untrusted: agent code can post from inside the worker. Only well-formed
        // answers to a pending request are accepted; everything else is dropped.
        if (!d || typeof d !== "object" || !Number.isInteger(d.id) || typeof d.ok !== "boolean") return;
        const p = PY.pending.get(d.id);
        if (!p) return;
        PY.pending.delete(d.id);
        clearTimeout(p.timer);
        if (d.ok) p.resolve(d.result);
        else p.reject(new Error(typeof d.error === "string" ? d.error.slice(0, 2000) : "worker error"));
    };
    // An error from a worker that is being killed is expected; don't let it surface as
    // an uncaught page error.
    w.onerror = (e) => { e.preventDefault(); if (gen === PY.gen) console.error("worker error:", e.message); };
    return w;
}

function workerCall(op, payload, timeoutMs) {
    const w = PY.worker;
    if (!w) return Promise.reject(new Error("interpreter not running"));
    const id = ++PY.seq;
    return new Promise((resolve, reject) => {
        const timer = timeoutMs ? setTimeout(() => {
            if (PY.pending.delete(id)) reject(new Error("timeout"));
        }, timeoutMs) : null;
        PY.pending.set(id, { resolve, reject, timer });
        w.postMessage({ id, op, ...payload });
    });
}

function setInterpreterState(state) {
    if (PY.state !== state && typeof debugLog === "function") debugLog("interp", "python interpreter: " + state + (state === "idle" && PY.info && PY.info.bootMs && PY.state === "booting" ? ` (booted in ${PY.info.bootMs} ms)` : ""));
    PY.state = state;
    if (typeof renderStatusBar === "function") renderStatusBar();
}

// Boot a fresh worker and seed it with the canonical workspace. Any earlier worker is
// terminated; a newer restart supersedes this one (generation counter).
function restartInterpreter() {
    PY.gen++;
    const gen = PY.gen;
    if (PY.worker) PY.worker.terminate();
    PY.worker = null;
    rejectAllPending("killed");
    setInterpreterState("booting");
    PY.readyPromise = (async () => {
        const core = await loadPyodideCore();
        if (gen !== PY.gen) throw new Error("superseded");
        PY.worker = startWorker();
        const info = await workerCall("boot", { core, packageBaseUrl: PYODIDE_CDN }, LIMITS.bootTimeoutMs);
        if (gen !== PY.gen) throw new Error("superseded");
        PY.info = info && typeof info === "object" ? { bootMs: Number(info.bootMs) || 0, pyVersion: String(info.pyVersion || "").slice(0, 20) } : null;
        PY.syncedVersion = -1;
        await syncWorkspaceToWorker();
        setInterpreterState("idle");
    })();
    PY.readyPromise.catch((e) => {
        if (gen !== PY.gen) return;
        setInterpreterState("failed");
        console.error("interpreter boot failed:", e);
        if (typeof addTimelineItem === "function" && e.message !== "killed") {
            showToast("❌ The Python interpreter failed to start: " + e.message, { error: true });
        }
    });
    return PY.readyPromise;
}

async function ensureInterpreter() {
    if (!PY.readyPromise || PY.state === "failed") restartInterpreter();
    for (;;) {
        const p = PY.readyPromise;
        try { await p; } catch (e) { if (p === PY.readyPromise) throw e; }
        if (p === PY.readyPromise) return;   // a restart during the wait: wait for that one
    }
}

// Re-seed the worker when the canonical workspace changed behind its back (uploads,
// rewind, import). Steps keep both in sync themselves.
async function syncWorkspaceToWorker() {
    if (PY.syncedVersion === WS.version) return;
    const files = {};
    for (const [p, f] of WS.files) files[p] = WS.blobs.get(f.hash);
    const version = WS.version;
    await workerCall("seed", { files }, 60000);
    PY.syncedVersion = version;
}

// Validate a run result from the worker; throws on anything malformed.
function validateRunResult(r) {
    const bad = (why) => { throw new Error("The worker sent an invalid result (" + why + ")."); };
    if (!r || typeof r !== "object") bad("not an object");
    if (r.status !== "ok" && r.status !== "error") bad("status");
    if (typeof r.output !== "string" || r.output.length > 3 * 1024 * 1024) bad("output");
    if (!Array.isArray(r.notes) || r.notes.length > 500 || !r.notes.every(n => typeof n === "string")) bad("notes");
    if (!Array.isArray(r.netAttempts) || r.netAttempts.length > 50 || !r.netAttempts.every(n => typeof n === "string")) bad("netAttempts");
    if (!r.listing || typeof r.listing !== "object") bad("listing");
    const paths = Object.keys(r.listing);
    if (paths.length > LIMITS.maxFiles * 2) bad("too many files");
    for (const p of paths) {
        if (!isSafeRelPath(p)) bad("unsafe path " + JSON.stringify(p).slice(0, 80));
        if (!/^[0-9a-f]{64}$/.test(r.listing[p])) bad("hash");
    }
    if (!r.files || typeof r.files !== "object") bad("files");
    for (const [p, b] of Object.entries(r.files)) {
        if (!(p in r.listing) || !(b instanceof Uint8Array)) bad("file bytes");
    }
    return r;
}

// Run one step. Returns the validated result, or { status: "timeout" | "killed" |
// "crashed" } after which the interpreter has been restarted from the canonical
// workspace — i.e. the step's effects are already rolled back.
async function runInWorker(code, opts) {
    const o = opts || {};
    await ensureInterpreter();
    await syncWorkspaceToWorker();
    setInterpreterState("running");
    const gen = PY.gen;
    try {
        const r = validateRunResult(await workerCall("run", { code, allowNetwork: !!o.allowNetwork }, o.timeoutMs));
        setInterpreterState("idle");
        return r;
    } catch (e) {
        const status = e.message === "timeout" ? "timeout" : e.message === "killed" ? "killed" : "crashed";
        if (gen === PY.gen) restartInterpreter();
        return { status, output: status === "crashed" ? e.message : "", notes: [], netAttempts: [], listing: null, files: {} };
    }
}

// ========== 6. LLM streaming (adapted from HermitUI's fetchAndStreamChat) ==========
// Streams one chat completion. onDelta(reasoning, content) fires per chunk. Resolves to
// { finishReason, usage, rawUsage, timings, clock }; rejects on HTTP/network errors and
// AbortError. rawUsage/timings are the server's own objects (timings: llama.cpp only),
// clock holds performance.now() stamps for the request, first token and end.
async function streamChat(payload, signal, onDelta) {
    let promptTokens = 0, completionTokens = 0, finishReason = null, sawStreamData = false;
    let rawUsage = null, timings = null;
    const clock = { startMs: performance.now(), firstMs: 0, endMs: 0 };
    const chatUrl = apiEndpoint(SETTINGS.apiUrl, "/chat/completions");
    const postChat = (body) => fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (SETTINGS.apiKey || "none") },
        body: JSON.stringify(body),
        signal,
    });
    const readDetail = async (res) => {
        let detail = res.statusText || "Unknown Error";
        try { const errBody = await res.json(); detail = (errBody.error && (errBody.error.message || errBody.error)) || detail; } catch (e) { /* not JSON */ }
        return String(detail);
    };

    let response = await postChat(payload);
    // A strict server can 400 purely because of the reasoning params: drop them, retry
    // once, and stop sending them for this endpoint.
    if (!response.ok && response.status === 400 && REASONING_PARAM_KEYS.some(k => k in payload)) {
        const detail = await readDetail(response);
        if (!looksLikeReasoningRejection(detail)) throw new Error(`Server Error 400: ${detail}`);
        const retry = { ...payload };
        for (const k of REASONING_PARAM_KEYS) delete retry[k];
        REASONING.rejected = true;
        showToast("🧠 This endpoint rejects reasoning settings — retrying without them");
        response = await postChat(retry);
    }
    if (!response.ok) throw new Error(`Server Error ${response.status}: ${await readDetail(response)}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "", rawBody = "";
    const readUsage = (data) => {
        if (data.timings && typeof data.timings === "object") timings = data.timings;
        if (!data.usage) return;
        rawUsage = data.usage;
        promptTokens = data.usage.prompt_tokens || promptTokens;
        completionTokens = data.usage.completion_tokens || completionTokens;
    };
    const emit = (reasoning, content) => {
        if (!reasoning && !content) return;
        sawStreamData = true;
        if (!clock.firstMs) clock.firstMs = performance.now();
        onDelta(reasoning || "", content || "");
    };
    const raiseIfError = (data) => {
        if (!data.error) return;
        throw new Error(typeof data.error === "string" ? data.error : (data.error.message || "Unknown server error"));
    };
    const processLine = (line) => {
        if (!line.startsWith("data:")) return;
        const dataStr = line.slice(5).trim();
        if (dataStr === "" || dataStr === "[DONE]") return;
        let data;
        try { data = JSON.parse(dataStr); } catch (e) { return; }
        raiseIfError(data);
        const choice = data.choices && data.choices[0];
        if (choice && choice.finish_reason) finishReason = choice.finish_reason;
        readUsage(data);
        const delta = choice && choice.delta;
        emit(delta && (delta.reasoning_content || delta.reasoning || delta.thinking || ""), delta && delta.content);
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            if (!sawStreamData && rawBody.length < 1048576) rawBody += text;
            buffer += text;
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) processLine(line);
        }
        if (buffer.trim()) processLine(buffer);
    } catch (streamErr) {
        reader.cancel().catch(() => {});
        throw streamErr;
    }
    // The server ignored `stream: true` and sent one JSON body.
    if (!sawStreamData) {
        const trimmed = rawBody.trim();
        let data = null;
        if (trimmed.startsWith("{")) { try { data = JSON.parse(trimmed); } catch { /* not JSON */ } }
        if (data) {
            raiseIfError(data);
            const choice = data.choices && data.choices[0];
            const msg = choice && choice.message;
            if (choice && choice.finish_reason) finishReason = choice.finish_reason;
            readUsage(data);
            if (msg) emit(msg.reasoning_content || msg.reasoning || msg.thinking || "", msg.content);
        }
    }
    clock.endMs = performance.now();
    return { finishReason, usage: { prompt: promptTokens, completion: completionTokens }, rawUsage, timings, clock, sawData: sawStreamData };
}

// ---------- Per-step inference stats ----------
const STEP_STAT_KEYS = ["prompt", "completion", "reasoning", "cached", "ttftMs", "genMs", "totalMs", "tps", "promptTps", "ctxUsed", "ctxSize"];

// One step's stats from what the server reported plus our own clock. Server-measured
// speeds (llama.cpp `timings`) win over ours, which include network and queueing.
// usage: the raw OpenAI `usage` object; nCtx: the context size, 0 when unknown.
function buildStepStats(usage, timings, clock, nCtx) {
    const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
    const r1 = (v) => Math.round(v * 10) / 10;
    const u = usage || {}, t = timings || {}, c = clock || {};
    const prompt = n(u.prompt_tokens) || n(t.prompt_n) + n(t.cache_n);
    const completion = n(u.completion_tokens) || n(t.predicted_n);
    const ttftMs = c.firstMs ? n(c.firstMs - c.startMs) : 0;
    const genMs = c.firstMs ? n(c.endMs - c.firstMs) : 0;
    let tps = n(t.predicted_per_second), tpsSource = tps ? "server" : "";
    // The first token arrives at firstMs, so n-1 tokens fill the time after it.
    if (!tps && completion > 1 && genMs > 0) { tps = (completion - 1) / (genMs / 1000); tpsSource = "clock"; }
    return {
        prompt, completion,
        reasoning: n(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens),
        cached: n(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || n(t.cache_n),
        ttftMs: Math.round(ttftMs), genMs: Math.round(genMs), totalMs: Math.round(n(c.endMs - c.startMs)),
        tps: r1(tps), tpsSource, promptTps: r1(n(t.prompt_per_second)),
        ctxUsed: prompt + completion, ctxSize: n(nCtx),
    };
}

// Imported stats are untrusted: known numeric keys only, anything else dropped.
function cleanStepStats(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const out = {};
    for (const k of STEP_STAT_KEYS) out[k] = Number.isFinite(raw[k]) && raw[k] > 0 ? raw[k] : 0;
    out.tpsSource = raw.tpsSource === "server" || raw.tpsSource === "clock" ? raw.tpsSource : "";
    return out;
}

// The stat block's entries: [{ label, value, title, meter? }]. Figures the server didn't
// report are left out rather than shown as 0.
function formatStepStats(st) {
    if (!st) return [];
    const count = (v) => Math.round(v).toLocaleString("en-US");
    const secs = (ms) => {
        if (ms < 1000) return Math.round(ms) + " ms";
        if (ms < 59950) return (ms / 1000).toFixed(1) + " s";
        const s = Math.round(ms / 1000);
        return `${Math.floor(s / 60)}m ${s % 60}s`;
    };
    const out = [];
    if (st.tps) out.push({ label: "Speed", value: st.tps.toFixed(1) + " tok/s", title: st.tpsSource === "server" ? "Generation speed, measured by the server" : "Generation speed from the first streamed token to the end, by this page's clock (includes network time)" });
    if (st.ttftMs) out.push({ label: "First token", value: secs(st.ttftMs), title: "From sending the request to the first streamed token (reasoning counts): network, queueing and prompt processing" });
    if (st.completion) out.push({ label: "Output", value: count(st.completion) + " tok" + (st.reasoning ? ` · ${count(st.reasoning)} thinking` : ""), title: "Tokens the model generated in this step" + (st.reasoning ? ", of which reasoning" : "") });
    if (st.prompt) out.push({ label: "Prompt", value: count(st.prompt) + " tok" + (st.cached ? ` · ${count(st.cached)} cached` : ""), title: "Tokens sent to the model in this step" + (st.cached ? "; cached ones were reused from the server's prompt cache instead of being processed again" : "") });
    if (st.promptTps) out.push({ label: "Prompt speed", value: count(st.promptTps) + " tok/s", title: "Prompt processing speed, measured by the server (uncached tokens only)" });
    if (st.ctxUsed) {
        const e = { label: "Context", value: count(st.ctxUsed) + " tok", title: "Prompt plus output: how much of the context window this step filled. The endpoint doesn't report its context size (llama.cpp's /props does)." };
        if (st.ctxSize) {
            const frac = st.ctxUsed / st.ctxSize;
            e.value = `${count(st.ctxUsed)} / ${count(st.ctxSize)} · ${Math.round(frac * 100)}%`;
            e.title = "Prompt plus output against the server's context size: how full the context window was at the end of this step";
            e.meter = Math.min(1, frac);
        }
        out.push(e);
    }
    if (st.totalMs) out.push({ label: "Inference", value: secs(st.totalMs), title: "Wall-clock time of the whole model request" + (st.genMs ? ` (${secs(st.genMs)} after the first token)` : "") });
    return out;
}

// Reasoning support for the configured endpoint, read from llama.cpp's /props or
// Ollama's /api/show. Never probed with a throwaway completion: permissive servers
// answer 200 for parameters they ignore, so a non-error proves nothing.
const REASONING = { key: "", state: "unknown", levels: ["low", "medium", "high"], rejected: false, nCtx: 0 };

// Also returns llama.cpp's context size (nCtx, 0 when unknown) for the step stats.
async function probeReasoningSupport(url, key, model) {
    const root = apiRoot(url);
    const headers = { "Authorization": "Bearer " + (key || "none") };
    let nCtx = 0;
    try {
        const res = await fetch(root + "/props", { headers });
        if (res.ok) {
            const p = await res.json();
            const gen = p.default_generation_settings || {};
            nCtx = Number.isFinite(gen.n_ctx) && gen.n_ctx > 0 ? gen.n_ctx : Number.isFinite(p.n_ctx) && p.n_ctx > 0 ? p.n_ctx : 0;
            const caps = p.chat_template_caps;
            const t = parseReasoningTemplateSupport(p.chat_template);
            if (caps && typeof caps.supports_reasoning_effort === "boolean") {
                return { state: caps.supports_reasoning_effort || t.supported ? "supported" : "unsupported", levels: t.levels, source: "llama.cpp /props", nCtx };
            }
            if (typeof p.chat_template === "string") return { state: t.supported ? "supported" : "unsupported", levels: t.levels, source: "server chat template", nCtx };
        }
    } catch (e) { /* no /props here — try Ollama next */ }
    try {
        const res = await fetch(root + "/api/show", {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, headers),
            body: JSON.stringify({ model }),
        });
        if (res.ok) {
            const t = parseReasoningTemplateSupport((await res.json()).template);
            return { state: t.supported ? "supported" : "unsupported", levels: t.levels, source: "Ollama /api/show", nCtx };
        }
    } catch (e) { /* not Ollama either */ }
    return { state: "unknown", levels: ["low", "medium", "high"], source: "endpoint exposes no capability data", nCtx };
}

async function ensureReasoningProbe() {
    const key = SETTINGS.apiUrl + "|" + SETTINGS.model;
    if (REASONING.key === key) return;
    const r = await probeReasoningSupport(SETTINGS.apiUrl, SETTINGS.apiKey, SETTINGS.model);
    Object.assign(REASONING, r, { key, rejected: false });
}

function currentReasoningParams() {
    if (SETTINGS.effort === "default" || REASONING.rejected || REASONING.state === "unsupported") return {};
    return buildReasoningParams(SETTINGS.effort, { levels: REASONING.levels });
}

// ========== 7. Session state, workspace store, checkpoints ==========
// Settings live in memory only (ephemerality rule); the API key is never exported and
// never sent to the worker.
const SETTINGS = {
    apiUrl: "http://localhost:8080/v1", apiKey: "", model: "", instructions: "",
    autonomy: "risk", stepLimit: 20, stepTimeoutSec: 60, maxTokens: 8192, effort: "low",
    // DESIGN §5.4: summarise older steps at this % of the context (0 = off), measured
    // against contextSize, or the server's n_ctx when that is 0.
    autoCompactPct: 85, contextSize: 0,
};

// The canonical workspace (DESIGN §4.1): path -> { hash, origin }, content-addressed blobs.
const WS = { files: new Map(), blobs: new Map(), version: 0, lastChanged: new Set() };
let CHECKPOINTS = [];

function freshSession() {
    return {
        task: "", createdAt: new Date().toISOString(), status: "idle",
        messages: [], timeline: [], stepCount: 0, stepBudget: 0,
        tokens: { prompt: 0, completion: 0 }, activeMs: 0,
        // One entry per compaction: the full history it replaced, so a rewind to an
        // earlier checkpoint can restore it. A checkpoint's epoch indexes this list.
        compactions: [],
    };
}
let S = freshSession();
// step: the step being worked on; activity: what it's doing right now, for the status bar.
// tokenRatio: prompt tokens per character on the last request (estimateTokens);
// overflowRetried: this turn already compacted after a context-overflow error;
// compactAfter: no threshold compaction before this step count (after a failed one).
const RUN = { active: false, abort: null, stopRequested: false, decision: null, activeSince: 0, modelNotes: [], step: 0, activity: "", tokenRatio: 0, overflowRetried: false, compactAfter: 0 };

function workspaceSize() {
    let total = 0;
    for (const f of WS.files.values()) total += (WS.blobs.get(f.hash) || []).length;
    return total;
}

function snapshotFiles() {
    const out = {};
    for (const [p, f] of WS.files) out[p] = { hash: f.hash, origin: f.origin };
    return out;
}

function takeCheckpoint(label) {
    const cp = { timelineLength: S.timeline.length, msgCount: S.messages.length, stepCount: S.stepCount, epoch: S.compactions.length, label, files: snapshotFiles() };
    CHECKPOINTS.push(cp);
    return CHECKPOINTS.length - 1;
}

// Only blobs the workspace or a checkpoint still references are kept.
function collectGarbage() {
    const live = new Set();
    for (const f of WS.files.values()) live.add(f.hash);
    for (const cp of CHECKPOINTS) for (const f of Object.values(cp.files)) live.add(f.hash);
    for (const item of S.timeline) {
        if (item.type === "step" && item._held) for (const h of item._held) live.add(h);
    }
    for (const h of [...WS.blobs.keys()]) if (!live.has(h)) WS.blobs.delete(h);
}

async function addUserFiles(list) {
    const added = [], skipped = [];
    let total = workspaceSize();
    for (const { path, bytes } of list) {
        const p = normalizeUploadPath(path);
        if (!p) { skipped.push(path + " (unsafe name)"); continue; }
        if (!WS.files.has(p) && WS.files.size >= LIMITS.maxFiles) { skipped.push(p + " (too many files)"); continue; }
        if (total + bytes.length > LIMITS.maxWorkspaceBytes) { skipped.push(p + " (workspace size limit)"); continue; }
        const hash = await sha256Hex(bytes);
        WS.blobs.set(hash, bytes);
        WS.files.set(p, { hash, origin: "user" });
        total += bytes.length;
        added.push({ path: p, size: bytes.length });
    }
    if (added.length) {
        WS.version++;
        WS.lastChanged = new Set(added.map(a => a.path));
        // The model only hears about files added after the task started.
        if (S.task) RUN.modelNotes.push("The user added files to /workspace: " + added.map(a => `${a.path} (${formatBytes(a.size)})`).join(", "));
    }
    renderWorkspace();
    return { added, skipped };
}

// ========== 8. Agent loop ==========
function nowIso() { return new Date().toISOString(); }

function addTimelineItem(item) {
    item.ts = item.ts || nowIso();
    S.timeline.push(item);
    renderTimelineItem(S.timeline.length - 1, true);
    return item;
}

function addNote(text, tone) { return addTimelineItem({ type: "note", text, tone: tone || "info" }); }

function setStatus(status) {
    S.status = status;
    renderStatusBar();
    updateComposer();
}

function setActivity(activity) {
    if (RUN.activity === activity) return;
    RUN.activity = activity;
    renderStatusBar();
}

function flushModelNotes() {
    if (!RUN.modelNotes.length) return;
    appendToLastUserMessage(S.messages, RUN.modelNotes.map(n => "Note: " + n).join("\n"));
    RUN.modelNotes = [];
}

function waitForDecision(idx) {
    const item = S.timeline[idx];
    debugLog("decision", "held for your approval", item && item.risk && item.risk.reasons.length ? "Why: " + item.risk.reasons.join("; ") : "Approve each step is on.");
    return new Promise((resolve) => { RUN.decision = { idx, resolve }; });
}

function resolveDecision(decision) {
    const d = RUN.decision;
    if (!d) return;
    RUN.decision = null;
    debugLog("decision", "you chose: " + decision.action + (decision.reason ? " — " + decision.reason : ""), decision.action === "edit" && decision.code ? decision.code : "");
    d.resolve(decision);
}

async function startTask(text) {
    S = freshSession();
    CHECKPOINTS = [];
    S.task = text;
    S.createdAt = nowIso();
    const files = [...WS.files].map(([p, f]) => ({ path: p, size: (WS.blobs.get(f.hash) || []).length }));
    S.messages = [
        { role: "system", content: buildSystemPrompt(SETTINGS.instructions) },
        { role: "user", content: buildTaskMessage(text, files) },
    ];
    RUN.modelNotes = [];
    RUN.compactAfter = 0;
    renderTimeline();
    addTimelineItem({ type: "task", text, files: files.map(f => f.path) });
    S.timeline[S.timeline.length - 1].checkpoint = takeCheckpoint("start");
    renderTimelineItem(S.timeline.length - 1);
    S.stepBudget = SETTINGS.stepLimit;
    runLoop();
}

// User text while a session exists: a note during a run, an answer to `ask:`, or a
// follow-up once the agent has finished or paused.
function submitUserText(text) {
    if (RUN.active) {
        addTimelineItem({ type: "user", kind: "guidance", text });
        RUN.modelNotes.push("Guidance from the user: " + text);
        showToast("📝 Note queued — it goes out with the next request.");
        return;
    }
    const last = S.messages[S.messages.length - 1];
    const kind = S.status === "awaiting-user" ? "answer" : "followup";
    if (text) {
        addTimelineItem({ type: "user", kind, text });
        appendToLastUserMessage(S.messages, text);
    } else if (!last || last.role !== "user") {
        showToast("Type a follow-up for the agent first.");
        return;
    }
    flushModelNotes();
    S.stepBudget = Math.max(S.stepBudget, S.stepCount + SETTINGS.stepLimit);
    runLoop();
}

// Never lowers the budget: Continue after a Stop or an error mid-budget keeps what's left.
function continueAfterLimit() {
    S.stepBudget = Math.max(S.stepBudget, S.stepCount + LIMITS.stepLimitIncrement);
    runLoop();
}

async function runLoop() {
    if (RUN.active) return;
    RUN.active = true;
    RUN.stopRequested = false;
    RUN.overflowRetried = false;
    RUN.activeSince = Date.now();
    setStatus("running");
    try {
        for (;;) {
            if (RUN.stopRequested) { addNote("⏹ Stopped by the user."); setStatus("stopped"); break; }
            if (S.stepCount >= S.stepBudget) {
                addNote(`⏸ Step limit reached (${S.stepCount} steps). Press Continue to allow ${LIMITS.stepLimitIncrement} more, or send a follow-up.`, "warn");
                setStatus("paused");
                break;
            }
            flushModelNotes();
            const outcome = await agentTurn();
            if (outcome === "done" || outcome === "ask" || outcome === "stopped" || outcome === "error") break;
        }
    } catch (e) {
        // A bug or a malformed worker answer: show it rather than leave the loop hanging.
        console.error("agent loop failed:", e);
        const last = S.timeline[S.timeline.length - 1];
        if (last && last.type === "step" && last.phase !== "done") {
            last.phase = "done";
            last.status = last.status || "crashed";
            // The worker may hold changes that never reached the canonical workspace:
            // start it fresh. And answer the code turn, so the history stays well-formed
            // for Retry.
            restartInterpreter();
            const lastMsg = S.messages[S.messages.length - 1];
            if (lastMsg && lastMsg.role === "assistant" && (last.kind === "code" || last.kind === "files")) {
                S.messages.push({ role: "user", content: buildObservation({ step: last.n, status: "error", notes: ["The harness failed while handling this step (" + (e.message || e) + "). Nothing was committed, and the interpreter was restarted: variables are lost, files are as they were before this step."] }) });
            }
        }
        addTimelineItem({ type: "error", text: e.message || String(e), hint: "The step was not committed. Press Retry to ask the model again." });
        setStatus("error");
    } finally {
        S.activeMs += Date.now() - RUN.activeSince;
        RUN.active = false;
        RUN.abort = null;
        RUN.step = 0;
        RUN.activity = "";
        renderStatusBar();
        updateComposer();
        renderTimeline();   // re-enable rewind buttons
    }
}

// One model turn plus whatever it leads to. Returns "continue" | "done" | "ask" |
// "stopped" | "error".
async function agentTurn() {
    const n = S.stepCount + 1;
    RUN.step = n;
    if (SETTINGS.autoCompactPct > 0 && S.stepCount >= RUN.compactAfter) {
        await ensureReasoningProbe().catch(() => {});   // n_ctx comes with the probe
        const limit = contextLimit(SETTINGS.contextSize, REASONING.nCtx);
        if (compactionDue(estimateTokens(S.messages, RUN.tokenRatio), limit, SETTINGS.autoCompactPct)) {
            const r = await compactHistory("threshold");
            if (r === "stopped") { addNote("⏹ Stopped while compacting the history."); setStatus("stopped"); return "stopped"; }
        }
    }
    setActivity("thinking");
    debugLog("model", `→ request to ${SETTINGS.model || "default model"} · ${S.messages.length} messages · effort ${SETTINGS.effort}`);
    const step = addTimelineItem({
        type: "step", n, phase: "thinking", kind: "", reasoning: "", content: "", prose: "",
        notes: [], netAttempts: [], startedAt: nowIso(), changes: null, risk: null,
    });
    const idx = S.timeline.length - 1;
    const render = createThrottle(THROTTLE_MS);
    let rawContent = "", apiReasoning = "";
    let result;
    try {
        await ensureReasoningProbe().catch(() => {});
        const payload = {
            model: SETTINGS.model || "local-model",
            messages: S.messages.map(m => ({ role: m.role, content: m.content })),
            stream: true,
            stream_options: { include_usage: true },
            ...currentReasoningParams(),
        };
        if (SETTINGS.maxTokens > 0) payload.max_tokens = SETTINGS.maxTokens;
        RUN.abort = new AbortController();
        result = await streamChat(payload, RUN.abort.signal, (r, c) => {
            apiReasoning += r;
            rawContent += c;
            const split = splitReply(rawContent, false);
            if (split.text && RUN.activity === "thinking") setActivity("writing");
            step.reasoning = [apiReasoning, split.reasoning].filter(Boolean).join("\n\n");
            step.content = split.text;
            render(() => renderTimelineItem(idx));
        });
    } catch (e) {
        render.cancel();
        S.timeline.splice(idx, 1);
        renderTimeline();
        if (e.name === "AbortError") { debugLog("model", "request aborted"); addNote("⏹ Stopped the model request."); setStatus("stopped"); return "stopped"; }
        debugLog("error", "model request failed: " + (e.message || e));
        // The prompt no longer fits: compact once (as far as it takes) and ask again.
        if (isContextOverflowError(e.message) && SETTINGS.autoCompactPct > 0 && !RUN.overflowRetried) {
            RUN.overflowRetried = true;
            const r = await compactHistory("overflow");
            if (r === "stopped") { addNote("⏹ Stopped while compacting the history."); setStatus("stopped"); return "stopped"; }
            if (r === "compacted") return "continue";
        }
        const hint = chatErrorHint(e.message, { apiUrl: SETTINGS.apiUrl, mixedContent: isBlockedMixedContent(SETTINGS.apiUrl) });
        addTimelineItem({ type: "error", text: e.message || String(e), hint });
        setStatus("error");
        return "error";
    } finally {
        RUN.abort = null;
    }
    render.cancel();
    RUN.overflowRetried = false;
    S.tokens.prompt += result.usage.prompt;
    S.tokens.completion += result.usage.completion;
    if (result.usage.prompt > 0) RUN.tokenRatio = result.usage.prompt / Math.max(1, messageChars(S.messages));
    const split = splitReply(rawContent, true);
    step.reasoning = [apiReasoning, split.reasoning].filter(Boolean).join("\n\n");
    step.content = split.text;
    step.finishReason = result.finishReason || "";
    step.stats = buildStepStats(result.rawUsage, result.timings, result.clock, REASONING.nCtx);
    const parsed = parseReply(split.text, result.finishReason);
    step.kind = parsed.kind;
    debugLog("model", `← reply · finish ${result.finishReason || "?"} · ${result.usage.completion} tok · ${((result.clock.endMs - result.clock.startMs) / 1000).toFixed(1)} s → ${parsed.kind}`, clipForDebug(split.text, 4000));
    // The history keeps the visible reply only; reasoning isn't sent back.
    S.messages.push({ role: "assistant", content: split.text });
    S.stepCount = n;

    if (parsed.kind === "final") {
        // An answer that presents files the workspace doesn't have goes back to the
        // model once, instead of ending the task on a false claim. Only once in a
        // row: the second answer stands either way.
        const missing = missingMentionedFiles(split.text, [...WS.files.keys()]);
        const prev = S.timeline.slice(0, idx).reverse().find(t => t.type === "step");
        if (missing.length && !(prev && prev.status === "unverified")) {
            step.status = "unverified";
            step.phase = "done";
            step.endedAt = nowIso();
            const list = missing.join(", ");
            debugLog("tool", "final_answer → sent back: mentions missing " + list);
            step.notes = [`The answer mentions ${list}, which ${missing.length === 1 ? "isn't" : "aren't"} in the workspace. The agent was asked to check.`];
            S.messages.push({ role: "user", content: buildObservation({ step: n, status: "error", notes: [`Your answer mentions ${list}, but /workspace has no such file${missing.length === 1 ? "" : "s"}. Files that exist: ${[...WS.files.keys()].join(", ") || "(none)"}. Create the missing file${missing.length === 1 ? "" : "s"} with <write_file> or code, or correct your answer.`] }) });
            step.checkpoint = takeCheckpoint("step " + n);
            renderTimelineItem(idx);
            return "continue";
        }
        debugLog("tool", "final_answer", clipForDebug(parsed.prose || split.text, 4000));
        step.phase = "done";
        step.endedAt = nowIso();
        step.checkpoint = takeCheckpoint("step " + n);
        renderTimelineItem(idx);
        setStatus("done");
        return "done";
    }
    if (parsed.kind === "ask") {
        debugLog("tool", "ask_user", parsed.question);
        step.question = parsed.question;
        step.prose = parsed.prose;
        step.phase = "done";
        step.endedAt = nowIso();
        step.checkpoint = takeCheckpoint("step " + n);
        renderTimelineItem(idx);
        setStatus("awaiting-user");
        return "ask";
    }
    if (parsed.kind !== "code" && parsed.kind !== "files") {
        // Cut off, empty, an unclosed block or tag, or file actions mixed with code:
        // nothing ran. Tell the model why.
        const why = {
            cutoff: "Your reply was cut off at the token limit before it finished, so nothing ran. Reason less and reply with ONE ```python block, file actions, or the final answer.",
            empty: "Your reply had no code block, no file actions and no answer, so nothing ran. Reply with ONE ```python block, file actions, the final answer, or an ask: line.",
            broken: parsed.unclosed
                ? `Your reply had a <${parsed.unclosed}> tag without its closing </${parsed.unclosed}>, so nothing ran. Send the action again, closed.`
                : "Your reply had an unclosed ```python block, so nothing ran. Reply with ONE complete ```python block.",
            mixed: "Your reply had both file actions and a ```python block, so nothing ran. Send file actions and code in separate replies: first the file actions, then the code once you have their results.",
        }[parsed.kind];
        debugLog("error", "no tool call (" + parsed.kind + ")", why);
        step.prose = parsed.prose || "";
        step.status = parsed.kind;
        step.phase = "done";
        step.endedAt = nowIso();
        S.messages.push({ role: "user", content: buildObservation({ step: n, status: "error", notes: [why] }) });
        step.checkpoint = takeCheckpoint("step " + n);
        renderTimelineItem(idx);
        return "continue";
    }

    step.prose = parsed.prose;
    const notes = [];
    let outcome;
    if (parsed.kind === "files") {
        if (result.finishReason === "length") notes.push("Your reply was cut off at the token limit after these file actions; anything after them was lost.");
        outcome = await executeFileStep(step, idx, parsed.actions, notes);
    } else {
        step.proposedCode = parsed.code;
        step.blockCount = parsed.blockCount;
        if (parsed.blockCount > 1) notes.push(`Only the first of your ${parsed.blockCount} code blocks was run.`);
        outcome = await executeStep(step, idx, notes);
    }
    debugLog("result", `step ${n} done · ${step.status || "?"} · ${step.decision || "no decision"} · changes: ${formatChanges(step.changes)}`);
    step.phase = "done";
    step.endedAt = nowIso();
    S.messages.push({ role: "user", content: outcome.observation });
    step.checkpoint = takeCheckpoint("step " + n);
    collectGarbage();
    renderTimelineItem(idx);
    renderWorkspace();
    renderStatusBar();
    return "continue";
}

// DESIGN §5.4: summarise the older steps into the task message, keeping the last few
// verbatim. reason: "threshold" (the history neared the context limit) or "overflow"
// (the server refused it; then as many steps as it takes are summarised). Returns
// "compacted" | "skipped" (nothing to summarise, or it failed: the history is
// unchanged) | "stopped".
async function compactHistory(reason) {
    const force = reason === "overflow";
    let plan = planCompaction(S.messages, LIMITS.compactKeepSteps, force ? 1 : LIMITS.compactMinSteps);
    for (let keep = LIMITS.compactKeepSteps - 1; !plan && force && keep >= 1; keep--) plan = planCompaction(S.messages, keep, 1);
    if (!plan) return "skipped";
    const prevTo = S.compactions.length ? S.compactions[S.compactions.length - 1].toStep : 0;
    const fromStep = prevTo + 1, toStep = prevTo + plan.steps;
    const tokensBefore = estimateTokens(S.messages, RUN.tokenRatio);
    setActivity("compacting");
    debugLog("model", `→ compacting steps ${fromStep}–${toStep} (${reason}) · ~${tokensBefore} tokens`);
    const payload = {
        model: SETTINGS.model || "local-model",
        messages: buildCompactionRequest(S.messages, plan.cut),
        stream: true,
        stream_options: { include_usage: true },
        ...currentReasoningParams(),
    };
    if (SETTINGS.maxTokens > 0) payload.max_tokens = SETTINGS.maxTokens;
    let text = "";
    let result;
    RUN.abort = new AbortController();
    try {
        result = await streamChat(payload, RUN.abort.signal, (r, c) => { text += c; });
    } catch (e) {
        if (e.name === "AbortError") { debugLog("model", "compaction aborted"); return "stopped"; }
        debugLog("error", "compaction failed: " + (e.message || e));
        RUN.compactAfter = S.stepCount + LIMITS.compactMinSteps;
        if (!force) addNote(`⚠️ Couldn't compact the history (${e.message || e}). Continuing with the full history.`, "warn");
        return "skipped";
    } finally {
        RUN.abort = null;
    }
    S.tokens.prompt += result.usage.prompt;
    S.tokens.completion += result.usage.completion;
    const summary = splitReply(text, true).text.trim();
    if (!summary) {
        debugLog("error", "compaction failed: empty summary");
        RUN.compactAfter = S.stepCount + LIMITS.compactMinSteps;
        addNote("⚠️ Couldn't compact the history: the model returned an empty summary. Continuing with the full history.", "warn");
        return "skipped";
    }
    const files = [...WS.files].map(([p, f]) => ({ path: p, size: (WS.blobs.get(f.hash) || []).length }));
    S.compactions.push({ before: S.messages.map(m => ({ role: m.role, content: m.content })), fromStep, toStep });
    S.messages = buildCompactedMessages(S.messages, plan.cut, summary, toStep, files);
    const tokensAfter = estimateTokens(S.messages, RUN.tokenRatio);
    debugLog("result", `history compacted · steps ${fromStep}–${toStep} · ~${tokensBefore} → ~${tokensAfter} tokens`, clipForDebug(summary, 4000));
    addTimelineItem({ type: "compaction", reason, fromStep, toStep, summary, tokensBefore, tokensAfter });
    renderStatusBar();
    return "compacted";
}

// Run the step's code under the current autonomy level, gate it on its effect, and
// commit or roll back. Returns { observation, stop }.
async function executeStep(step, idx, notes) {
    let code = step.proposedCode;
    const autonomy = SETTINGS.autonomy;
    if (autonomy === "approve") {
        step.phase = "pending-run";
        renderTimelineItem(idx);
        setStatus("awaiting-approval");
        const d = await waitForDecision(idx);
        setStatus("running");
        if (d.action === "reject") {
            step.decision = "rejected"; step.decidedBy = "user"; step.rejectReason = d.reason || ""; step.status = "rejected";
            return { observation: buildObservation({ step: step.n, status: "rejected", reason: d.reason, notes: [...notes, "Your code did not run."] }), stop: !!d.stop };
        }
        if (d.code !== code) { step.edited = true; code = d.code; }
        step.decision = step.edited ? "edited" : "approved";
        step.decidedBy = "user";
    }
    let allowNetwork = false;
    for (;;) {
        step.ranCode = code;
        step.phase = "running";
        setActivity("python");
        debugLog("tool", `python · ${code.split("\n").length} lines${allowNetwork ? " · network allowed" : ""}`, code);
        const t0 = performance.now();
        renderTimelineItem(idx);
        const r = await runInWorker(code, { allowNetwork, timeoutMs: SETTINGS.stepTimeoutSec * 1000 });
        step.notes = [...notes, ...(r.notes || [])];
        step.netAttempts = r.netAttempts || [];
        debugLog(r.status === "ok" ? "result" : "error", `python → ${r.status} · ${Math.round(performance.now() - t0)} ms` + (step.netAttempts.length ? ` · ${step.netAttempts.length} blocked network attempt(s)` : ""), clipForDebug(r.output, 4000) + (step.netAttempts.length ? "\n\nBlocked: " + step.netAttempts.join(", ") : ""));
        if (step.edited) step.notes.push("The user edited your code before it ran. The code that ran:\n```python\n" + code.replace(/\n$/, "") + "\n```");
        if (r.status === "timeout" || r.status === "killed" || r.status === "crashed") {
            const why = {
                timeout: `The step exceeded the ${SETTINGS.stepTimeoutSec} s time limit and was killed.`,
                killed: "The user killed the step.",
                crashed: "The interpreter crashed: " + r.output,
            }[r.status];
            step.status = r.status;
            step.output = (r.output && r.status !== "crashed") ? r.output : why;
            step.changes = { added: [], modified: [], deleted: [] };
            step.decision = step.decision || "rolled back";
            step.notes.push(why, "The interpreter was restarted: variables are lost. Files are as they were before this step.");
            return { observation: buildObservation({ step: step.n, status: r.status === "crashed" ? "error" : r.status, output: why, changes: step.changes, notes: step.notes.filter(n => n !== why) }), stop: false };
        }
        step.status = r.status;
        step.output = r.output;
        const effect = await collectEffect(r);
        step.changes = effect.changes;
        step._held = effect.hashes;
        const origins = {};
        for (const [p, f] of WS.files) origins[p] = f.origin;
        const risk = classifyEffect(effect.diff, origins, { bytesWritten: effect.bytesWritten, netAttempts: step.netAttempts, overLimit: effect.overLimit });
        step.risk = risk;
        if (step.netAttempts.length) step.notes.push("Network access is blocked; these attempts failed: " + step.netAttempts.join(", "));
        const fileHint = filenameCommentHint(code, Object.keys(r.listing));
        if (fileHint) step.notes.push(fileHint);

        let decision = { action: "approve" };
        if (autonomy === "risk" && risk.verdict === "ask" && !allowNetwork) {
            step.phase = "pending-approval";
            renderTimelineItem(idx);
            renderWorkspace();
            setStatus("awaiting-approval");
            decision = await waitForDecision(idx);
            setStatus("running");
        } else if (effect.overLimit && autonomy !== "risk") {
            decision = { action: "reject", reason: effect.overLimit, auto: true };
        }

        if (decision.action === "approve") {
            commitEffect(effect);
            if (!step.decision) { step.decision = risk.verdict === "ask" && autonomy === "risk" ? "approved" : "auto"; step.decidedBy = step.decision === "auto" ? "auto" : "user"; }
            return { observation: buildObservation({ step: step.n, status: r.status, output: r.output, changes: step.changes, notes: step.notes }), stop: false };
        }
        // Reject, or re-run: either way the step's effects are rolled back and the
        // interpreter restarted, since variables may hold data from the step.
        await rollbackStep();
        if (decision.action === "reject") {
            step.decision = "rejected"; step.decidedBy = decision.auto ? "auto" : "user"; step.rejectReason = decision.reason || ""; step.status = "rejected";
            WS.lastChanged = new Set();
            return {
                observation: buildObservation({ step: step.n, status: "rejected", reason: decision.reason, notes: ["Its file changes were rolled back and the interpreter was restarted: variables are lost, files are as they were before this step."] }),
                stop: !!decision.stop,
            };
        }
        // "edit" or "rerun-net": run again on a fresh interpreter.
        if (decision.action === "edit") { code = decision.code; step.edited = true; step.decision = "edited"; }
        if (decision.action === "rerun-net") { allowNetwork = true; step.decision = "approved (network)"; }
        step.decidedBy = "user";
        notes = [...notes, "The interpreter was restarted before this run: variables from earlier steps are lost."];
    }
}

// A file-action step (DESIGN §2.3). The actions are worked out against the canonical
// workspace without changing it, so the effect is gated *before* anything is applied:
// a reject has nothing to roll back and the interpreter keeps its variables.
// Returns { observation, stop }.
async function executeFileStep(step, idx, actions, notes) {
    const ws = { paths: [...WS.files.keys()], read: (p) => { const f = WS.files.get(p); return f ? WS.blobs.get(f.hash) || null : null; } };
    setActivity("files");
    const applied = applyFileActions(actions, ws);
    for (const r of applied.results) {
        const edits = r.edits ? ` · ${r.edits.length} edit${r.edits.length === 1 ? "" : "s"}` : "";
        debugLog(r.ok ? "tool" : "error", `${r.tool} ${r.path}${edits} → ${r.ok ? "ok" : "failed"}${r.message ? ": " + r.message : ""}`,
            r.edits ? clipForDebug(r.edits.map((e, i) => `--- edit ${i + 1}: old\n${e.old}\n+++ new\n${e.new}`).join("\n\n"), 4000)
                : r.tool === "write_file" && applied.writes.has(r.path) ? clipForDebug(applied.writes.get(r.path), 4000)
                : r.output ? clipForDebug(r.output, 4000) : "");
    }
    step.fileActions = applied.results.map(r => {
        const a = { tool: r.tool, path: r.path, ok: r.ok, message: r.message };
        if (r.startLine) { a.startLine = r.startLine; a.endLine = r.endLine; }
        if (r.edits) a.edits = r.edits;
        return a;
    });
    step.output = formatFileResults(applied.results, applied.failed);
    step.status = applied.results.every(r => r.ok) ? "ok" : "error";
    step.notes = [...notes];
    let effect = null;
    if (applied.writes.size) {
        const enc = new TextEncoder();
        const listing = {}, files = {};
        for (const [p, f] of WS.files) listing[p] = f.hash;
        for (const [p, text] of applied.writes) {
            files[p] = enc.encode(text);
            listing[p] = await sha256Hex(files[p]);
        }
        effect = await collectEffect({ listing, files });
        effect.gen = -1;   // not in the worker yet: commitEffect mustn't mark it in sync
        if (!effect.diff.added.length && !effect.diff.modified.length) effect = null;
    }
    if (effect) {
        step.changes = effect.changes;
        step._held = effect.hashes;
        const origins = {};
        for (const [p, f] of WS.files) origins[p] = f.origin;
        step.risk = classifyEffect(effect.diff, origins, { bytesWritten: effect.bytesWritten, overLimit: effect.overLimit });
    } else if (applied.writes.size || actions.some(a => a.tool !== "read_file")) {
        step.changes = { added: [], modified: [], deleted: [] };
    }

    const autonomy = SETTINGS.autonomy;
    let decision = { action: "approve" };
    const hold = autonomy === "approve" || (autonomy === "risk" && effect && step.risk.verdict === "ask");
    if (effect && effect.overLimit && autonomy !== "risk") {
        decision = { action: "reject", reason: effect.overLimit, auto: true };
    } else if (hold) {
        step.phase = "pending-approval";
        renderTimelineItem(idx);
        renderWorkspace();
        setStatus("awaiting-approval");
        decision = await waitForDecision(idx);
        setStatus("running");
    }
    if (decision.action === "approve") {
        if (effect) {
            const prevVersion = WS.version;
            commitEffect(effect);
            await pushEffectToWorker(effect, prevVersion);
        }
        if (effect || hold) {
            step.decision = hold ? "approved" : "auto";
            step.decidedBy = hold ? "user" : "auto";
        }
        return { observation: buildObservation({ step: step.n, status: step.status, output: step.output, changes: step.changes, notes: step.notes, truncate: false }), stop: false };
    }
    step.decision = "rejected";
    step.decidedBy = decision.auto ? "auto" : "user";
    step.rejectReason = decision.reason || "";
    step.status = "rejected";
    WS.lastChanged = new Set();
    const nothing = actions.some(a => a.tool === "read_file") ? "Nothing was applied and you don't get the read results; files are unchanged." : "Nothing was applied; files are unchanged.";
    return { observation: buildObservation({ step: step.n, status: "rejected", reason: decision.reason, notes: [...notes, nothing] }), stop: !!decision.stop };
}

// After a committed file step, hand the new bytes to the worker if it held exactly the
// previous workspace, instead of a full re-seed before the next python step. Anything
// else (not booted, busy, restarted meanwhile) is left to syncWorkspaceToWorker.
async function pushEffectToWorker(effect, prevVersion) {
    if (PY.state !== "idle" || PY.syncedVersion !== prevVersion) return;
    const gen = PY.gen, version = WS.version;
    const files = {};
    for (const [p, hash] of effect.pending) files[p] = WS.blobs.get(hash);
    try {
        await workerCall("write", { files }, 30000);
        if (gen === PY.gen && WS.version === version) PY.syncedVersion = version;
    } catch (e) { /* the next python step re-seeds */ }
}

// Turn a run result into a diff against the canonical workspace, with verified bytes.
async function collectEffect(r) {
    const before = {};
    for (const [p, f] of WS.files) before[p] = f.hash;
    const diff = diffListings(before, r.listing);
    const changes = { added: [], modified: [], deleted: [] };
    const pending = new Map();
    const hashes = [];
    let bytesWritten = 0;
    for (const kind of ["added", "modified"]) {
        for (const p of diff[kind]) {
            const bytes = r.files[p];
            if (!bytes) throw new Error("The worker reported a change to " + p + " without its content.");
            const hash = await sha256Hex(bytes);
            if (hash !== r.listing[p]) throw new Error("The worker reported a wrong hash for " + p + ".");
            WS.blobs.set(hash, bytes);   // held until commit or garbage collection
            hashes.push(hash);
            pending.set(p, hash);
            bytesWritten += bytes.length;
            changes[kind].push(kind === "added" ? { path: p, hash, size: bytes.length } : { path: p, hash, prevHash: before[p], size: bytes.length });
        }
    }
    for (const p of diff.deleted) changes.deleted.push({ path: p, prevHash: before[p] });
    // Would committing this break the workspace limits?
    let total = workspaceSize(), count = WS.files.size;
    for (const p of diff.deleted) { total -= (WS.blobs.get(before[p]) || []).length; count--; }
    for (const p of diff.modified) total -= (WS.blobs.get(before[p]) || []).length;
    total += bytesWritten;
    count += diff.added.length;
    let overLimit = "";
    if (count > LIMITS.maxFiles) overLimit = `would leave ${count} files in the workspace (limit ${LIMITS.maxFiles})`;
    else if (total > LIMITS.maxWorkspaceBytes) overLimit = `would grow the workspace to ${formatBytes(total)} (limit ${formatBytes(LIMITS.maxWorkspaceBytes)})`;
    return { diff, changes, pending, hashes, bytesWritten, overLimit, gen: PY.gen, version: WS.version };
}

function commitEffect(effect) {
    const inSync = effect.gen === PY.gen && effect.version === WS.version;
    for (const p of effect.diff.deleted) WS.files.delete(p);
    for (const [p, hash] of effect.pending) {
        const prev = WS.files.get(p);
        WS.files.set(p, { hash, origin: prev ? prev.origin : "agent" });
    }
    WS.version++;
    // The worker already holds exactly this state, unless it was restarted (Kill while
    // the step waited for approval) or the workspace changed meanwhile (an upload).
    if (inSync) PY.syncedVersion = WS.version;
    WS.lastChanged = new Set([...effect.diff.added, ...effect.diff.modified]);
}

async function rollbackStep() {
    restartInterpreter();
    await ensureInterpreter().catch(() => {});
}

function stopRun() {
    RUN.stopRequested = true;
    if (RUN.abort) RUN.abort.abort();
    if (RUN.decision) resolveDecision({ action: "reject", reason: "Stopped by the user.", stop: true });
    showToast(PY.state === "running" ? "⏹ Stopping after the running step finishes…" : "⏹ Stopping…");
}

function killInterpreter() {
    if (PY.state === "running") {
        RUN.stopRequested = false;
        rejectAllPending("killed");
        restartInterpreter();
        showToast("☠️ Step killed — the interpreter is restarting.");
    } else {
        restartInterpreter();
        if (S.task) RUN.modelNotes.push("The interpreter was restarted by the user: variables are lost, files are intact.");
        showToast("🔄 Interpreter restarting.");
    }
}

async function rewindTo(idx) {
    const item = S.timeline[idx];
    if (!item || !Number.isInteger(item.checkpoint) || !CHECKPOINTS[item.checkpoint]) return;
    if (RUN.active) { showToast("Stop the agent before rewinding."); return; }
    const label = item.type === "task" ? "the start of the task" : `step ${item.n}`;
    if (!(await confirmDialog(`Rewind to ${label}? Everything after it is removed from the timeline, the workspace is restored to that point, and the interpreter restarts.`, "⏪ Rewind"))) return;
    const ci = item.checkpoint;
    const cp = CHECKPOINTS[ci];
    S.timeline.length = cp.timelineLength;
    // A checkpoint from before a compaction: bring back the history it replaced (with
    // today's system prompt, which Settings may have changed since).
    if ((cp.epoch || 0) < S.compactions.length) {
        const system = S.messages[0];
        S.messages = S.compactions[cp.epoch || 0].before.map(m => ({ role: m.role, content: m.content }));
        if (system && system.role === "system" && S.messages[0].role === "system") S.messages[0] = system;
        S.compactions.length = cp.epoch || 0;
    }
    S.messages.length = cp.msgCount;
    S.stepCount = cp.stepCount;
    CHECKPOINTS = CHECKPOINTS.slice(0, ci + 1);
    WS.files = new Map(Object.entries(cp.files).map(([p, f]) => [p, { hash: f.hash, origin: f.origin }]));
    WS.version++;
    WS.lastChanged = new Set();
    collectGarbage();
    RUN.modelNotes = ["The session was rewound to this point and the interpreter was restarted: variables are lost, files are as they were at this point."];
    RUN.compactAfter = 0;
    restartInterpreter();
    const last = S.messages[S.messages.length - 1];
    addNote(`⏪ Rewound to ${label}. ` + (last && last.role === "user" ? "Press Continue to resume, or send a note first." : "Send a follow-up to continue."));
    setStatus("paused");
    renderTimeline();
    renderWorkspace();
}

// ========== 9. UI ==========
const $ = (id) => document.getElementById(id);

let toastTimeout = null;
function showToast(message, opts) {
    const { error = false } = opts || {};
    let toast = $("toastNotification");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "toastNotification";
        toast.className = "toast";
        toast.setAttribute("role", "status");
        toast.setAttribute("aria-live", "polite");
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.toggle("error", error);
    toast.classList.add("show");
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove("show"), error ? 8000 : 2500);
}

function renderMarkdown(text) {
    const html = DOMPurify.sanitize(marked.parse(String(text || "")));
    const div = document.createElement("div");
    div.className = "markdown";
    div.innerHTML = html;
    div.querySelectorAll("pre code").forEach((el) => { try { hljs.highlightElement(el); } catch (e) { /* unknown language */ } });
    return div;
}

function highlightedCode(code, lang) {
    const pre = document.createElement("pre");
    const el = document.createElement("code");
    el.className = "hljs language-" + lang;
    try { el.innerHTML = hljs.highlight(String(code || ""), { language: lang, ignoreIllegals: true }).value; }
    catch (e) { el.textContent = code; }
    pre.appendChild(el);
    return pre;
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function button(label, action, idx, cls, title) {
    const b = el("button", "card-btn " + (cls || ""), label);
    b.type = "button";
    b.dataset.action = action;
    if (idx !== undefined) b.dataset.idx = idx;
    if (title) b.title = title;
    return b;
}

const VERDICT_LABELS = { auto: "✅ auto-committed", approved: "👍 approved", edited: "✏️ edited & approved", rejected: "↩️ rejected", "rolled back": "↩️ rolled back", "approved (network)": "🌐 approved with network" };
const STATUS_LABELS = { unverified: "⚠️ files missing", ok: "ok", error: "error", timeout: "⏱ timeout", killed: "☠️ killed", crashed: "💥 crashed", rejected: "rejected", cutoff: "✂️ cut off", empty: "empty reply", broken: "unclosed code", mixed: "mixed reply", interrupted: "interrupted" };

function renderThink(item, card, streaming) {
    if (!item.reasoning) return;
    const prev = card && card.querySelector("details.think-block");
    const d = el("details", "think-block" + (streaming ? " thinking-active" : ""));
    if (prev ? prev.open : false) d.open = true;
    d.appendChild(el("summary", "", streaming ? "🧠 Thinking…" : `🧠 Reasoning (${item.reasoning.length.toLocaleString()} chars)`));
    d.appendChild(el("div", "think-content", item.reasoning));
    return d;
}

const FILE_ACTION_ICONS = { read_file: "📄", write_file: "✍️", edit_file: "✏️" };
const FILE_ACTION_VERBS = { read_file: "read", write_file: "write", edit_file: "edit" };

// One row per file action; edits expand to their old/new text (as text, never HTML).
function renderFileActions(actions) {
    const ul = el("ul", "file-actions");
    for (const a of actions || []) {
        const li = el("li", "file-action" + (a.ok ? "" : " is-error"));
        li.appendChild(el("span", "file-action-icon", a.ok ? FILE_ACTION_ICONS[a.tool] || "•" : "❌"));
        li.appendChild(el("span", "file-action-verb", FILE_ACTION_VERBS[a.tool] || a.tool));
        li.appendChild(el("code", "file-action-path", a.path || "?"));
        li.appendChild(el("span", "file-action-msg", a.message));
        if ((a.edits || []).length) {
            const d = el("details", "file-edits");
            d.appendChild(el("summary", "", a.edits.length === 1 ? "Show the change" : `Show the ${a.edits.length} changes`));
            for (const e of a.edits) {
                const pair = el("div", "edit-pair");
                pair.appendChild(el("pre", "edit-old", e.old));
                pair.appendChild(el("pre", "edit-new", e.new || "(deleted)"));
                d.appendChild(pair);
            }
            li.appendChild(d);
        }
        ul.appendChild(li);
    }
    return ul;
}

function renderFileChips(changes, idx) {
    const wrap = el("div", "effect");
    const list = [
        ...(changes.added || []).map(f => ["+", "added", f.path, f.hash]),
        ...(changes.modified || []).map(f => ["~", "modified", f.path, f.hash]),
        ...(changes.deleted || []).map(f => ["−", "deleted", f.path, f.prevHash]),
    ];
    wrap.appendChild(el("span", "effect-label", list.length ? "Files:" : "Files: no changes"));
    for (const [sign, kind, path, hash] of list) {
        const b = el("button", "file-chip " + kind, `${sign} ${path}`);
        b.type = "button";
        b.dataset.action = "view-file";
        b.dataset.path = path;
        b.dataset.hash = hash || "";
        b.title = kind === "deleted" ? "View the version before this step" : "View this version";
        wrap.appendChild(b);
    }
    return wrap;
}

function buildStepCard(item, idx, old) {
    const card = el("article", "card step-card phase-" + (item.phase || "done"));
    const head = el("div", "card-head");
    head.appendChild(el("span", "card-title", item.kind === "final" ? (item.status === "unverified" ? "↩️ Answer sent back" : "✅ Final answer") : item.kind === "ask" ? "❓ Question" : `Step ${item.n}`));
    if (item.status && STATUS_LABELS[item.status]) head.appendChild(el("span", "badge status-" + item.status, STATUS_LABELS[item.status]));
    if (item.decision) head.appendChild(el("span", "badge verdict-" + item.decision.replace(/\W+/g, "-"), (VERDICT_LABELS[item.decision] || item.decision) + (item.decidedBy === "user" && item.decision !== "auto" ? " by you" : "")));
    if (item.phase === "thinking") head.appendChild(el("span", "badge live", "streaming…"));
    if (item.phase === "running") head.appendChild(el("span", "badge live", "running…"));
    if (item.phase === "pending-run" || item.phase === "pending-approval") head.appendChild(el("span", "badge waiting", "⏸ waiting for you"));
    card.appendChild(head);

    const think = renderThink(item, old, item.phase === "thinking" && !item.content);
    if (think) card.appendChild(think);

    if (item.phase === "thinking") {
        if (item.content) card.appendChild(renderMarkdown(item.content));
        return card;
    }
    if (item.kind === "final") {
        card.appendChild(renderMarkdown(item.content));
        if ((item.notes || []).length) card.appendChild(el("p", "hint", "⚠️ " + item.notes.join(" ")));
        return finishCard(card, item, idx);
    }
    if (item.kind === "ask") {
        if (item.prose) card.appendChild(renderMarkdown(item.prose));
        card.appendChild(renderMarkdown("**" + (item.question || "") + "**"));
        if (S.status === "awaiting-user" && idx === lastStepIndex()) card.appendChild(el("p", "hint", "Answer in the box below."));
        return finishCard(card, item, idx);
    }
    if (item.prose) card.appendChild(renderMarkdown(item.prose));
    if (item.kind === "files") card.appendChild(renderFileActions(item.fileActions));
    if (item.proposedCode !== undefined && item.proposedCode !== "") {
        if (item.phase === "pending-run") {
            card.appendChild(el("label", "field-label", "Proposed code — edit it before running if you like:"));
            const ta = el("textarea", "code-edit");
            ta.dataset.role = "code-edit";
            ta.value = item._draft !== undefined ? item._draft : item.proposedCode;
            ta.spellcheck = false;
            ta.rows = Math.min(24, Math.max(4, ta.value.split("\n").length + 1));
            card.appendChild(ta);
        } else {
            card.appendChild(highlightedCode(item.edited && item.ranCode ? item.ranCode : item.proposedCode, "python"));
            if (item.edited) card.appendChild(el("p", "hint", "✏️ Edited by you before it ran."));
        }
    }
    if (item.kind === "code" && item.output !== undefined && item.phase !== "pending-run" && item.phase !== "running") {
        const out = String(item.output || "");
        const pre = el("pre", "output" + (item.status === "error" ? " is-error" : ""));
        pre.textContent = out.length > 200000 ? out.slice(0, 200000) + "\n[… display truncated; the full output is in the session export …]" : (out || "(no output)");
        card.appendChild(pre);
    } else if (item.kind === "files") {
        // The model's view of the step: read contents and messages, collapsed.
        if (item.output) {
            const d = el("details", "file-result");
            d.appendChild(el("summary", "", item.phase === "pending-approval" ? "What the agent gets back if you approve" : "What the agent got back"));
            d.appendChild(el("pre", "output", item.output));
            card.appendChild(d);
        }
    } else if (item.kind !== "code" && item.status) {
        card.appendChild(el("p", "hint", { cutoff: "✂️ The reply was cut off at the token limit — nothing ran.", empty: "The reply was empty — nothing ran.", broken: "The reply had an unclosed code block or file tag — nothing ran.", mixed: "The reply mixed file actions with a code block — nothing ran." }[item.status] || ""));
    }
    if (item.changes) card.appendChild(renderFileChips(item.changes, idx));
    const shownNotes = (item.notes || []).filter(n => !n.startsWith("The user edited your code"));
    if (shownNotes.length) {
        const ul = el("ul", "step-notes");
        for (const n of shownNotes) ul.appendChild(el("li", "", n));
        card.appendChild(ul);
    }
    if (item.rejectReason) card.appendChild(el("p", "hint", "Reason given: " + item.rejectReason));

    if (item.phase === "pending-run" || item.phase === "pending-approval") {
        const box = el("div", "decision");
        if (item.phase === "pending-approval" && item.kind === "files") {
            const reasons = item.risk && item.risk.reasons.length ? item.risk.reasons : null;
            box.appendChild(el("p", "decision-why", (reasons ? "⚠️ Held for your approval: this step " + reasons.join("; ") + "." : "⏸ Approve each step is on.") + " Nothing is applied or sent to the agent until you approve; rejecting discards it."));
        } else if (item.phase === "pending-approval") {
            box.appendChild(el("p", "decision-why", "⚠️ Held for your approval: this step " + (item.risk ? item.risk.reasons.join("; ") : "needs review") + ". Its effects are applied only if you approve; rejecting rolls them back."));
        }
        const reason = el("input", "reason-input");
        reason.dataset.role = "reason";
        reason.placeholder = "Reason (optional, sent to the agent)";
        const row = el("div", "decision-row");
        if (item.phase === "pending-run") {
            row.appendChild(button("▶ Run", "run", idx, "primary"));
        } else {
            row.appendChild(button("✅ Approve", "approve", idx, "primary"));
            // A file step has nothing to re-run: nothing has been applied yet.
            if (item.kind !== "files") {
                if ((item.netAttempts || []).length) row.appendChild(button("🌐 Allow network & re-run", "rerun-net", idx, "", "Roll back, restart the interpreter and run the same code with network access"));
                row.appendChild(button("✏️ Edit & re-run", "edit-open", idx, "", "Roll back and run your edited version instead"));
            }
        }
        row.appendChild(button("↩️ Reject", "reject", idx, "danger"));
        box.appendChild(row);
        box.appendChild(reason);
        if (item.phase === "pending-approval" && item._editing) {
            const ta = el("textarea", "code-edit");
            ta.dataset.role = "code-edit";
            ta.value = item._draft !== undefined ? item._draft : (item.ranCode || item.proposedCode);
            ta.spellcheck = false;
            ta.rows = Math.min(24, Math.max(4, ta.value.split("\n").length + 1));
            box.appendChild(ta);
            box.appendChild(button("▶ Run edited code", "edit", idx, "primary"));
        }
        card.appendChild(box);
    }
    return finishCard(card, item, idx);
}

function renderStepStats(stats) {
    const entries = formatStepStats(stats);
    if (!entries.length) return null;
    const box = el("div", "step-stats");
    box.setAttribute("aria-label", "Model stats for this step");
    for (const e of entries) {
        const it = el("span", "stat-item");
        it.title = e.title;
        it.appendChild(el("span", "stat-label", e.label));
        it.appendChild(el("span", "stat-value", e.value));
        if (e.meter !== undefined) {
            const bar = el("span", "stat-meter");
            const fill = el("span", "stat-meter-fill" + (e.meter >= 0.85 ? " is-high" : ""));
            fill.style.width = (e.meter * 100).toFixed(1) + "%";
            bar.appendChild(fill);
            it.appendChild(bar);
        }
        box.appendChild(it);
    }
    return box;
}

function finishCard(card, item, idx) {
    if (item.type === "step") {
        const stats = renderStepStats(item.stats);
        if (stats) card.appendChild(stats);
    }
    if (Number.isInteger(item.checkpoint) && (item.type !== "step" || item.phase === "done") && !RUN.active) {
        const foot = el("div", "card-foot");
        foot.appendChild(button("⏪ Rewind to here", "rewind", idx, "ghost", "Restore the workspace and history as of this point"));
        card.appendChild(foot);
    }
    return card;
}

function lastStepIndex() {
    for (let i = S.timeline.length - 1; i >= 0; i--) if (S.timeline[i].type === "step") return i;
    return -1;
}

function buildCard(item, idx, old) {
    if (item.type === "step") return buildStepCard(item, idx, old);
    if (item.type === "task") {
        const card = el("article", "card task-card");
        card.appendChild(el("div", "card-head")).appendChild(el("span", "card-title", "🎯 Task"));
        card.appendChild(el("p", "task-text", item.text));
        if (item.files && item.files.length) card.appendChild(el("p", "hint", "Workspace at start: " + item.files.join(", ")));
        return finishCard(card, item, idx);
    }
    if (item.type === "user") {
        const card = el("article", "card user-card");
        card.appendChild(el("div", "card-head")).appendChild(el("span", "card-title", { answer: "💬 Your answer", followup: "💬 Follow-up", guidance: "📝 Your note" }[item.kind] || "💬 You"));
        card.appendChild(el("p", "task-text", item.text));
        return card;
    }
    if (item.type === "compaction") {
        const card = el("article", "card compaction-card");
        card.appendChild(el("div", "card-head")).appendChild(el("span", "card-title", "🗜️ History compacted"));
        const k = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v));
        const why = item.reason === "overflow" ? "after the server refused the prompt as too long" : "as it neared the context limit";
        card.appendChild(el("p", "hint", `Steps ${item.fromStep}–${item.toStep} were summarised for the model ${why} (~${k(item.tokensBefore)} → ~${k(item.tokensAfter)} tokens). The timeline keeps the full record, and rewinding to an earlier step restores the full history.`));
        const d = el("details", "think-block");
        d.appendChild(el("summary", "", "📝 Summary the model continues from"));
        d.appendChild(renderMarkdown(item.summary));
        card.appendChild(d);
        return card;
    }
    if (item.type === "error") {
        const card = el("article", "card error-card");
        card.appendChild(el("p", "error-text", "❌ " + item.text));
        if (item.hint) card.appendChild(el("p", "hint", item.hint));
        if (idx === S.timeline.length - 1 && !RUN.active) card.appendChild(button("🔁 Retry", "retry", idx, "primary"));
        return card;
    }
    const card = el("article", "card note-card tone-" + (item.tone || "info"));
    card.appendChild(el("p", "", item.text));
    return card;
}

// While a reply streams, the card is patched in place: rebuilding it on every chunk
// replayed its entry animation and reset the reasoning box's scroll position, which
// made the timeline flicker.
function patchStreamingCard(card, item) {
    const thinking = !item.content;
    const think = card.querySelector(":scope > details.think-block");
    if (item.reasoning) {
        if (!think) return false;   // first reasoning chunk: rebuild once to create the box
        const box = think.querySelector(".think-content");
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
        if (box.textContent !== item.reasoning) box.textContent = item.reasoning;
        if (atBottom) box.scrollTop = box.scrollHeight;
        think.classList.toggle("thinking-active", thinking);
        think.querySelector("summary").textContent = thinking ? "🧠 Thinking…" : `🧠 Reasoning (${item.reasoning.length.toLocaleString()} chars)`;
    }
    const md = card.querySelector(":scope > .markdown");
    if (item.content) {
        const fresh = renderMarkdown(item.content);
        if (md) md.replaceWith(fresh); else card.appendChild(fresh);
    }
    return true;
}

// isNew: the item was just added, so its card gets the entry animation. Re-renders of
// an existing card never animate.
function renderTimelineItem(idx, isNew) {
    const tl = $("timeline");
    const item = S.timeline[idx];
    if (!tl || !item) return;
    const old = tl.querySelector(`[data-idx="${idx}"]`);
    const nearBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 120;
    const phase = item.type === "step" ? item.phase || "" : "";
    if (!(old && phase === "thinking" && old.dataset.phase === "thinking" && patchStreamingCard(old, item))) {
        const card = buildCard(item, idx, old);
        card.dataset.idx = idx;
        card.dataset.phase = phase;
        if (isNew && !old) card.classList.add("is-new");
        if (old) old.replaceWith(card);
        else tl.appendChild(card);
    }
    $("emptyState")?.remove();
    if (isNew || nearBottom) tl.scrollTop = tl.scrollHeight;
}

function renderTimeline() {
    const tl = $("timeline");
    tl.querySelectorAll("[data-idx]").forEach(n => n.remove());
    if (!S.timeline.length) {
        if (!$("emptyState")) tl.appendChild(buildEmptyState());
        return;
    }
    for (let i = 0; i < S.timeline.length; i++) renderTimelineItem(i);
}

function buildEmptyState() {
    const d = el("div", "empty-state");
    d.id = "emptyState";
    d.innerHTML = `<h2>Hand the agent a task.</h2>
        <p>It writes Python, runs it in a sandboxed interpreter in this tab, looks at the result and repeats until the task is done. You watch every step: harmless steps run on their own, risky ones wait for you, and any step can be rewound.</p>
        <p class="hint">Add files to the workspace on the right, describe the task below, and press Start. Nothing is stored: export the session to keep it.</p>`;
    return d;
}

// ---------- Workspace panel ----------
function buildTree(paths) {
    const root = { dirs: new Map(), files: [] };
    for (const p of paths) {
        const parts = p.split("/");
        let node = root;
        for (const dir of parts.slice(0, -1)) {
            if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
            node = node.dirs.get(dir);
        }
        node.files.push(p);
    }
    return root;
}

function renderTreeNode(node, ul) {
    for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        const li = el("li", "ws-dir");
        const det = el("details");
        det.open = true;
        det.appendChild(el("summary", "", "📁 " + name));
        const sub = el("ul");
        renderTreeNode(child, sub);
        det.appendChild(sub);
        li.appendChild(det);
        ul.appendChild(li);
    }
    for (const p of node.files.sort((a, b) => a.localeCompare(b))) {
        const f = WS.files.get(p);
        const li = el("li", "ws-file" + (WS.lastChanged.has(p) ? " changed" : ""));
        const b = el("button", "ws-file-btn");
        b.type = "button";
        b.dataset.action = "view-file";
        b.dataset.path = p;
        b.dataset.hash = f.hash;
        b.appendChild(el("span", "ws-name", p.split("/").pop()));
        b.appendChild(el("span", "ws-size", formatBytes((WS.blobs.get(f.hash) || []).length)));
        b.appendChild(el("span", "origin origin-" + f.origin, f.origin === "user" ? "yours" : "agent"));
        b.title = `${p} — ${f.origin === "user" ? "your file (changes to it need approval)" : "created by the agent"}`;
        li.appendChild(b);
        ul.appendChild(li);
    }
}

function renderWorkspace() {
    const tree = $("wsTree");
    if (!tree) return;
    tree.innerHTML = "";
    if (!WS.files.size) {
        tree.appendChild(el("p", "hint ws-empty", "Empty. Drop files or folders here, or use the buttons above."));
    } else {
        const ul = el("ul", "ws-root");
        renderTreeNode(buildTree([...WS.files.keys()]), ul);
        tree.appendChild(ul);
    }
    $("wsSummary").textContent = `${WS.files.size} file${WS.files.size === 1 ? "" : "s"} · ${formatBytes(workspaceSize())}`;
}

// ---------- File viewer ----------
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" };
const HL_LANGS = { py: "python", js: "javascript", mjs: "javascript", ts: "typescript", json: "json", md: "markdown", html: "xml", xml: "xml", css: "css", csv: "plaintext", sh: "bash", yml: "yaml", yaml: "yaml", java: "java", c: "c", h: "c", cpp: "cpp", rs: "rust", go: "go", sql: "sql", toml: "ini", ini: "ini", txt: "plaintext" };
let viewerUrl = null;

function openViewer(path, hash) {
    const bytes = WS.blobs.get(hash);
    const body = $("viewerBody");
    body.innerHTML = "";
    $("viewerTitle").textContent = path;
    if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
    if (!bytes) {
        $("viewerMeta").textContent = "This version is no longer held in memory (it was rolled back or rewound away).";
        $("viewerDownload").disabled = true;
        openModal("viewerModal");
        return;
    }
    $("viewerDownload").disabled = false;
    $("viewerDownload").onclick = () => downloadBytes(bytes, path.split("/").pop());
    const ext = (path.split(".").pop() || "").toLowerCase();
    const f = WS.files.get(path);
    $("viewerMeta").textContent = `${formatBytes(bytes.length)}${f && f.hash === hash ? " · " + (f.origin === "user" ? "your file" : "created by the agent") : " · an earlier version"}`;
    if (IMAGE_TYPES[ext]) {
        // An <img> never runs scripts, SVG included.
        viewerUrl = URL.createObjectURL(new Blob([bytes], { type: IMAGE_TYPES[ext] }));
        const img = el("img", "viewer-img");
        img.src = viewerUrl;
        img.alt = path;
        body.appendChild(img);
    } else {
        let text = null;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) { text = null; }
        if (text !== null && !text.includes("\0")) {
            const shown = text.length > 500000 ? text.slice(0, 500000) : text;
            const lang = HL_LANGS[ext];
            if (lang && lang !== "plaintext" && shown.length < 300000) body.appendChild(highlightedCode(shown, lang));
            else { const pre = el("pre", "viewer-text"); pre.textContent = shown; body.appendChild(pre); }
            if (shown.length < text.length) body.appendChild(el("p", "hint", "Showing the first 500,000 characters. Download the file to see all of it."));
        } else {
            const pre = el("pre", "viewer-text");
            const head = bytes.subarray(0, 512);
            const rows = [];
            for (let i = 0; i < head.length; i += 16) {
                const chunk = head.subarray(i, i + 16);
                rows.push(i.toString(16).padStart(6, "0") + "  " + Array.from(chunk, b => b.toString(16).padStart(2, "0")).join(" ").padEnd(48) + "  " + Array.from(chunk, b => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join(""));
            }
            pre.textContent = `Binary file. First ${head.length} bytes:\n\n` + rows.join("\n");
            body.appendChild(pre);
        }
    }
    openModal("viewerModal");
}

function downloadBytes(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type: type || "application/octet-stream" }));
    const a = el("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- Modals ----------
let modalReturnFocus = null;
function openModal(id) {
    modalReturnFocus = document.activeElement;
    const m = $(id);
    m.classList.add("active");
    const first = m.querySelector("input, select, textarea, button");
    if (first) first.focus();
}
function closeModal(id) {
    $(id).classList.remove("active");
    if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
}

// Resolves true (OK), false (Cancel/Escape) or "alt" (the optional third button).
function confirmDialog(text, okLabel, altLabel) {
    return new Promise((resolve) => {
        $("confirmText").textContent = text;
        $("confirmOk").textContent = okLabel || "OK";
        $("confirmAlt").hidden = !altLabel;
        $("confirmAlt").textContent = altLabel || "";
        const done = (v) => { $("confirmOk").onclick = null; $("confirmCancel").onclick = null; $("confirmAlt").onclick = null; closeModal("confirmModal"); resolve(v); };
        $("confirmOk").onclick = () => done(true);
        $("confirmCancel").onclick = () => done(false);
        $("confirmAlt").onclick = () => done("alt");
        openModal("confirmModal");
    });
}

// ---------- Debug console ----------
// A drop-down log of what the agent does: model requests, every tool call (python,
// read_file / write_file / edit_file, final answer, ask), their results and the gate
// decisions. Kept in memory only (never exported), capped, and rendered while open.
const DEBUG = { entries: [], max: 1000, filter: "tools" };
const DEBUG_GROUPS = { tools: ["tool", "result", "decision", "error"], model: ["tool", "result", "decision", "error", "model"], all: null };

function debugLog(kind, text, detail) {
    const entry = { ts: new Date(), step: RUN.active && RUN.step ? RUN.step : S.stepCount, kind, text: String(text), detail: detail ? String(detail) : "" };
    DEBUG.entries.push(entry);
    if (DEBUG.entries.length > DEBUG.max) DEBUG.entries.shift();
    const panel = $("debugLog");
    if (panel && $("debugConsole").classList.contains("open") && debugVisible(entry)) {
        const stick = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 8;
        panel.appendChild(buildDebugLine(entry));
        while (panel.childElementCount > DEBUG.max) panel.removeChild(panel.firstElementChild);
        if (stick) panel.scrollTop = panel.scrollHeight;
    }
}

function debugVisible(entry) {
    const g = DEBUG_GROUPS[DEBUG.filter];
    return !g || g.includes(entry.kind);
}

function buildDebugLine(entry) {
    const line = el("div", "dc-line dc-" + entry.kind);
    const t = entry.ts.toLocaleTimeString([], { hour12: false }) + "." + String(entry.ts.getMilliseconds()).padStart(3, "0");
    const head = el("span", "dc-head", `${t}  #${entry.step}  ${entry.kind.padEnd(8)} ${entry.text}`);
    if (!entry.detail) { line.appendChild(head); return line; }
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.appendChild(head);
    det.append(sum, el("pre", "dc-detail", entry.detail));
    line.appendChild(det);
    return line;
}

function renderDebugLog() {
    const panel = $("debugLog");
    panel.replaceChildren(...DEBUG.entries.filter(debugVisible).map(buildDebugLine));
    if (!panel.childElementCount) panel.appendChild(el("div", "dc-empty", "Nothing logged yet. Tool calls show up here as the agent works."));
    panel.scrollTop = panel.scrollHeight;
}

function setDebugConsole(open) {
    $("debugConsole").classList.toggle("open", open);
    $("debugConsole").setAttribute("aria-hidden", open ? "false" : "true");
    $("debugBtn").classList.toggle("active", open);
    $("debugBtn").setAttribute("aria-pressed", open ? "true" : "false");
    if (open) renderDebugLog();
}

function clipForDebug(text, max) {
    const s = String(text || "");
    return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : s;
}

// ---------- Status bar, header, composer ----------
function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const ACTIVITY_LABELS = { thinking: "model thinking…", writing: "model writing…", python: "running Python", files: "file actions", compacting: "compacting history…" };
const STATE_LABELS = { idle: "ready", running: "working", "awaiting-approval": "waiting for you", "awaiting-user": "question for you", done: "done", stopped: "stopped", paused: "paused", error: "error" };
const INTERP_LABELS = { off: "not started", booting: "booting…", idle: "idle", running: "running", failed: "failed" };

function renderStatusBar() {
    if (!$("statStep")) return;
    // While a run is on, show the step being worked on (the card's number), not the
    // last finished one. The limit is where the run pauses; follow-ups move it on.
    const cur = RUN.active && RUN.step ? RUN.step : S.stepCount;
    $("statStep").textContent = `Step ${cur}${S.stepBudget ? " · pauses at " + S.stepBudget : ""}`;
    $("statStep").title = S.stepBudget
        ? `The agent pauses after step ${S.stepBudget}. Each new instruction or follow-up allows ${SETTINGS.stepLimit} more steps (Settings → Step limit); Continue at the limit allows ${LIMITS.stepLimitIncrement} more.`
        : "";
    const active = S.activeMs + (RUN.active ? Date.now() - RUN.activeSince : 0);
    $("statTime").textContent = "⏱ " + formatDuration(active);
    const tok = S.tokens.prompt + S.tokens.completion;
    $("statTokens").textContent = "🔢 " + (tok >= 1000 ? (tok / 1000).toFixed(1) + "k" : tok) + " tokens";
    $("statInterp").textContent = "🐍 Python " + (INTERP_LABELS[PY.state] || PY.state);
    $("statInterp").title = "The Python interpreter. It is idle while the model thinks and busy only while a code step runs, which usually takes well under a second.";
    $("statInterp").dataset.state = PY.state;
    const label = STATE_LABELS[S.status] || S.status;
    $("statState").textContent = S.status === "running" && RUN.active && ACTIVITY_LABELS[RUN.activity] ? `${label} · ${ACTIVITY_LABELS[RUN.activity]}` : label;
    $("statState").dataset.state = S.status;
}

function renderHeader() {
    const remote = describeRemoteEndpoint(SETTINGS.apiUrl);
    let host = SETTINGS.apiUrl;
    try { host = new URL(SETTINGS.apiUrl).host; } catch (e) { /* keep raw */ }
    $("modelBadge").textContent = `🤖 ${SETTINGS.model || "default model"} @ ${host}`;
    $("modelBadge").title = SETTINGS.apiUrl;
    const warn = $("cloudWarning");
    warn.hidden = !remote;
    if (remote) warn.textContent = `☁️ Task text, files the agent prints and its outputs are sent to ${remote}.`;
}

function updateComposer() {
    const input = $("taskInput");
    const send = $("sendBtn");
    const hasSession = !!S.task;
    $("stopBtn").hidden = !RUN.active;
    $("continueBtn").hidden = RUN.active || !hasSession || !["paused", "stopped", "error"].includes(S.status) || (S.messages.length && S.messages[S.messages.length - 1].role !== "user");
    if (!hasSession) { input.placeholder = "Describe a task… (Ctrl+Enter to start)"; send.textContent = "▶ Start"; }
    else if (RUN.active) { input.placeholder = "Add a note for the agent — it goes out with the next request"; send.textContent = "📝 Add note"; }
    else if (S.status === "awaiting-user") { input.placeholder = "Answer the agent's question…"; send.textContent = "↩️ Answer"; }
    else { input.placeholder = "Follow up, or give new instructions…"; send.textContent = "▶ Send"; }
    $("composer").classList.toggle("is-generating", RUN.active);
}

// ---------- Settings ----------
function fillSettingsForm() {
    $("settingUrl").value = SETTINGS.apiUrl;
    $("settingModelInput").value = SETTINGS.model;
    $("settingModelInput").hidden = false;
    $("settingModelSelect").hidden = true;
    $("settingApiKey").value = SETTINGS.apiKey;
    $("settingInstructions").value = SETTINGS.instructions;
    $("settingStepLimit").value = SETTINGS.stepLimit;
    $("settingTimeout").value = SETTINGS.stepTimeoutSec;
    $("settingMaxTokens").value = SETTINGS.maxTokens;
    $("settingAutoCompact").value = SETTINGS.autoCompactPct;
    $("settingContextSize").value = SETTINGS.contextSize;
    $("reasoningStatus").textContent = REASONING.key ? `Reasoning control: ${REASONING.state} (${REASONING.source || ""})` : "";
}

function currentSettingsModel() {
    const select = $("settingModelSelect");
    if (!select.hidden && select.value && select.value !== "custom") return select.value;
    return $("settingModelInput").value.trim();
}

function saveSettings() {
    let url;
    try { url = normalizeApiUrl($("settingUrl").value); }
    catch (e) { showToast(e.message, { error: true }); return false; }
    const int = (id, min, max, d) => { const v = parseInt($(id).value, 10); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    SETTINGS.apiUrl = url;
    SETTINGS.model = currentSettingsModel();
    SETTINGS.apiKey = $("settingApiKey").value.trim();
    SETTINGS.instructions = $("settingInstructions").value;
    SETTINGS.stepLimit = int("settingStepLimit", 1, 500, 20);
    SETTINGS.stepTimeoutSec = int("settingTimeout", 1, 3600, 60);
    SETTINGS.maxTokens = int("settingMaxTokens", 0, 1000000, 8192);
    SETTINGS.autoCompactPct = int("settingAutoCompact", 0, 95, 85);
    SETTINGS.contextSize = int("settingContextSize", 0, 10000000, 0);
    RUN.compactAfter = 0;
    if (S.messages.length && S.messages[0].role === "system") S.messages[0].content = buildSystemPrompt(SETTINGS.instructions);
    renderHeader();
    return true;
}

async function testConnection() {
    const btn = $("testConnectionBtn");
    const original = btn.textContent;
    btn.textContent = "⏳ Testing…";
    btn.disabled = true;
    try {
        const url = normalizeApiUrl($("settingUrl").value);
        const key = $("settingApiKey").value.trim();
        const res = await fetch(apiEndpoint(url, "/models"), { headers: { "Authorization": "Bearer " + (key || "none") } });
        if (!res.ok) {
            let detail = res.statusText || "Unknown Error";
            try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || detail; } catch { /* not JSON */ }
            throw new Error(`Server Error ${res.status}: ${detail}`);
        }
        const data = await res.json();
        let models = data.data;
        if (!Array.isArray(models)) models = Array.isArray(data) ? data : (data.models || []);
        if (!models.length) throw new Error("the server answered but lists no models — type the model name in manually.");
        const select = $("settingModelSelect");
        select.innerHTML = "";
        for (const m of models) {
            const id = typeof m === "string" ? m : (m.id || m.name || m.model || "");
            if (!id) continue;
            const opt = el("option", "", id);
            opt.value = id;
            select.appendChild(opt);
        }
        const custom = el("option", "", "✍️ Custom / manual entry");
        custom.value = "custom";
        select.appendChild(custom);
        const current = $("settingModelInput").value.trim();
        if ([...select.options].some(o => o.value === current)) select.value = current;
        select.hidden = false;
        $("settingModelInput").hidden = true;
        const r = await probeReasoningSupport(url, key, currentSettingsModel());
        $("reasoningStatus").textContent = `Reasoning control: ${r.state} (${r.source})` + (r.nCtx ? ` · context ${r.nCtx.toLocaleString("en-US")} tokens` : "");
        showToast(`✅ Connection successful! Found ${models.length} model${models.length === 1 ? "" : "s"}.`);
    } catch (error) {
        const baseUrl = $("settingUrl").value.trim();
        const hint = chatErrorHint(error.message, { apiUrl: baseUrl, mixedContent: isBlockedMixedContent(baseUrl) });
        showToast(`❌ Connection failed: ${error.message}${hint ? "\n" + hint : ""}`, { error: true });
    } finally {
        btn.textContent = original;
        btn.disabled = false;
    }
}

// ---------- Export / import ----------
function sessionSnapshot() {
    return {
        session: {
            task: S.task, createdAt: S.createdAt, status: S.status, messages: S.messages, timeline: S.timeline,
            stepCount: S.stepCount, tokens: S.tokens, activeMs: S.activeMs, compactions: S.compactions,
            // Non-secret connection settings only: the API key is never exported.
            settings: { apiUrl: SETTINGS.apiUrl, model: SETTINGS.model, autonomy: SETTINGS.autonomy, stepLimit: SETTINGS.stepLimit, stepTimeoutSec: SETTINGS.stepTimeoutSec, maxTokens: SETTINGS.maxTokens, effort: SETTINGS.effort, autoCompactPct: SETTINGS.autoCompactPct, contextSize: SETTINGS.contextSize },
        },
        files: WS.files, blobs: WS.blobs, checkpoints: CHECKPOINTS,
    };
}

function stampForFile() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`;
}

async function exportSession(includeCheckpoints) {
    if (RUN.active) { showToast("Stop the agent before exporting, so the export is consistent."); return; }
    try {
        const entries = buildSessionArchive(sessionSnapshot(), { includeCheckpoints });
        const zip = await zipWrite(entries);
        downloadBytes(zip, `hermit-agent-session-${stampForFile()}.zip`, "application/zip");
        showToast(`💾 Session exported (${formatBytes(zip.length)}).`);
    } catch (e) {
        showToast("❌ Export failed: " + e.message, { error: true });
    }
}

async function exportWorkspace() {
    try {
        const entries = [...WS.files].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([p, f]) => ({ path: p, data: WS.blobs.get(f.hash) }));
        const zip = await zipWrite(entries);
        downloadBytes(zip, `hermit-agent-workspace-${stampForFile()}.zip`, "application/zip");
    } catch (e) {
        showToast("❌ Export failed: " + e.message, { error: true });
    }
}

async function importSessionFile(file) {
    if (RUN.active) { showToast("Stop the agent before importing a session."); return; }
    let parsed;
    try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        parsed = await parseSessionArchive(await zipRead(bytes));
    } catch (e) {
        showToast("❌ Import failed: " + e.message, { error: true });
        return;
    }
    if ((S.timeline.length || WS.files.size) && !(await confirmDialog("Replace the current session and workspace with the imported one? Export first if you want to keep them.", "📂 Replace"))) return;
    const s = parsed.session;
    S = freshSession();
    Object.assign(S, {
        task: s.task, createdAt: s.createdAt, status: "paused", messages: s.messages, timeline: s.timeline,
        stepCount: s.stepCount, stepBudget: s.stepCount + SETTINGS.stepLimit, tokens: s.tokens, activeMs: s.activeMs,
        compactions: s.compactions,
    });
    WS.files = parsed.files;
    WS.blobs = parsed.blobs;
    WS.version++;
    WS.lastChanged = new Set();
    CHECKPOINTS = parsed.checkpoints;
    // Checkpoint links on the timeline only survive when the checkpoints came along.
    for (const item of S.timeline) {
        if (!Number.isInteger(item.checkpoint) || item.checkpoint >= CHECKPOINTS.length) delete item.checkpoint;
    }
    // Autonomy and limits carry over; connection settings don't (they would silently
    // send the session somewhere else), and approvals never do (DESIGN §3.3).
    SETTINGS.autonomy = s.settings.autonomy;
    SETTINGS.stepLimit = s.settings.stepLimit;
    SETTINGS.stepTimeoutSec = s.settings.stepTimeoutSec;
    SETTINGS.maxTokens = s.settings.maxTokens;
    SETTINGS.autoCompactPct = s.settings.autoCompactPct;
    SETTINGS.contextSize = s.settings.contextSize;
    RUN.compactAfter = 0;
    $("autonomySelect").value = SETTINGS.autonomy;
    RUN.modelNotes = ["This session was restored from an export into a fresh interpreter: variables are lost, files are intact."];
    restartInterpreter();
    renderTimeline();
    renderWorkspace();
    const last = S.messages[S.messages.length - 1];
    const conn = s.settings.apiUrl && s.settings.apiUrl !== SETTINGS.apiUrl ? ` It was recorded against ${s.settings.model || "a model"} at ${s.settings.apiUrl}; the current connection settings were kept.` : "";
    addNote(`📂 Session imported, paused. Nothing has run.${conn} ` + (last && last.role === "user" ? "Press Continue to resume." : "Send a follow-up to continue."));
    setStatus("paused");
}

// ---------- Uploads ----------
async function readEntry(entry, prefix, out) {
    if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ path: prefix + file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
            const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
            if (!batch.length) break;
            for (const e of batch) await readEntry(e, prefix + entry.name + "/", out);
        }
    }
}

async function uploadFileList(files) {
    if (PY.state === "running") { showToast("Wait for the running step to finish before adding files."); return; }
    const list = [];
    for (const f of files) list.push({ path: f.webkitRelativePath || f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    reportUpload(await addUserFiles(list));
}

function reportUpload({ added, skipped }) {
    if (added.length) showToast(`📎 Added ${added.length} file${added.length === 1 ? "" : "s"} to the workspace.`);
    if (skipped.length) showToast("Skipped: " + skipped.slice(0, 5).join(", ") + (skipped.length > 5 ? " …" : ""), { error: true });
}

// ---------- Event wiring ----------
function handleTimelineClick(e) {
    const b = e.target.closest("[data-action]");
    if (!b) return;
    const action = b.dataset.action;
    const idx = Number(b.dataset.idx);
    const item = S.timeline[idx];
    const card = b.closest(".card");
    const reason = card && card.querySelector("[data-role=reason]") ? card.querySelector("[data-role=reason]").value.trim() : "";
    const code = card && card.querySelector("[data-role=code-edit]") ? card.querySelector("[data-role=code-edit]").value : null;
    if (action === "view-file") { openViewer(b.dataset.path, b.dataset.hash); return; }
    if (action === "rewind") { rewindTo(idx); return; }
    if (action === "retry") { S.timeline.splice(idx, 1); renderTimeline(); runLoop(); return; }
    if (!RUN.decision || RUN.decision.idx !== idx) return;
    if (action === "run") resolveDecision({ action: "run", code: code !== null ? code : item.proposedCode });
    else if (action === "approve") resolveDecision({ action: "approve" });
    else if (action === "reject") resolveDecision({ action: "reject", reason });
    else if (action === "rerun-net") resolveDecision({ action: "rerun-net" });
    else if (action === "edit-open") {
        item._editing = true;
        renderTimelineItem(idx);
        document.querySelector(`[data-idx="${idx}"] [data-role=code-edit]`)?.focus();
    }
    else if (action === "edit") resolveDecision({ action: "edit", code: code !== null ? code : item.ranCode });
}

function wireEvents() {
    $("timeline").addEventListener("click", handleTimelineClick);
    $("timeline").addEventListener("input", (e) => {
        if (e.target.dataset.role !== "code-edit") return;
        const card = e.target.closest("[data-idx]");
        const item = card && S.timeline[Number(card.dataset.idx)];
        if (item) item._draft = e.target.value;
    });
    $("wsTree").addEventListener("click", (e) => {
        const b = e.target.closest("[data-action=view-file]");
        if (b) openViewer(b.dataset.path, b.dataset.hash);
    });
    $("composer").addEventListener("submit", (e) => {
        e.preventDefault();
        const text = $("taskInput").value.trim();
        if (!S.task) {
            if (!text) { showToast("Describe a task first."); return; }
            startTask(text);
        } else {
            if (!text && RUN.active) return;
            submitUserText(text);
        }
        $("taskInput").value = "";
    });
    $("taskInput").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("composer").requestSubmit(); }
    });
    $("stopBtn").addEventListener("click", stopRun);
    $("killBtn").addEventListener("click", killInterpreter);
    $("continueBtn").addEventListener("click", () => {
        if (S.status === "paused" && S.stepCount >= S.stepBudget) continueAfterLimit();
        else submitUserText("");
    });
    $("autonomySelect").addEventListener("change", (e) => { SETTINGS.autonomy = e.target.value; });
    $("effortSelect").addEventListener("change", (e) => { SETTINGS.effort = e.target.value; });
    $("newSessionBtn").addEventListener("click", async () => {
        if (RUN.active) { showToast("Stop the agent first."); return; }
        let choice = true;
        if (WS.files.size) choice = await confirmDialog("Start a new session? The timeline and the model history are cleared. Keep the workspace files, or clear everything? Export first if you want to keep them.", "🗑️ Clear everything", "📁 Keep files");
        else if (S.timeline.length) choice = await confirmDialog("Start a new session? The timeline is cleared. Export first if you want to keep it.", "➕ New session");
        if (!choice) return;
        S = freshSession();
        CHECKPOINTS = [];
        if (choice === "alt") {
            // Files carried over are the user's inputs now: only files the agent created in
            // *this* session are changed without approval (DESIGN §2.3).
            for (const f of WS.files.values()) f.origin = "user";
            WS.version++; WS.lastChanged = new Set();
            collectGarbage();
            showToast(`➕ New session, ${WS.files.size} workspace file${WS.files.size === 1 ? "" : "s"} kept.`);
        } else {
            WS.files = new Map(); WS.blobs = new Map(); WS.version++; WS.lastChanged = new Set();
        }
        RUN.modelNotes = [];
        restartInterpreter();
        renderTimeline(); renderWorkspace(); setStatus("idle");
    });
    $("settingsBtn").addEventListener("click", () => { fillSettingsForm(); openModal("settingsModal"); });
    $("settingCancel").addEventListener("click", () => closeModal("settingsModal"));
    $("settingSave").addEventListener("click", () => { if (saveSettings()) { closeModal("settingsModal"); showToast("✅ Settings saved (in memory only)."); } });
    $("testConnectionBtn").addEventListener("click", testConnection);
    $("settingModelSelect").addEventListener("change", (e) => {
        if (e.target.value === "custom") { e.target.hidden = true; $("settingModelInput").hidden = false; $("settingModelInput").focus(); }
    });
    $("viewerClose").addEventListener("click", () => closeModal("viewerModal"));
    $("exportBtn").addEventListener("click", () => openModal("exportModal"));
    $("exportCancel").addEventListener("click", () => closeModal("exportModal"));
    $("exportSessionBtn").addEventListener("click", () => { closeModal("exportModal"); exportSession($("exportCheckpoints").checked); });
    $("exportWorkspaceBtn").addEventListener("click", () => { closeModal("exportModal"); exportWorkspace(); });
    $("importBtn").addEventListener("click", () => $("importInput").click());
    $("importInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importSessionFile(f); });
    $("wsUploadBtn").addEventListener("click", () => $("wsFileInput").click());
    $("wsFolderBtn").addEventListener("click", () => $("wsFolderInput").click());
    $("wsDownloadBtn").addEventListener("click", exportWorkspace);
    for (const id of ["wsFileInput", "wsFolderInput"]) {
        $(id).addEventListener("change", async (e) => { const files = [...e.target.files]; e.target.value = ""; await uploadFileList(files); });
    }
    const pane = $("workspacePane");
    pane.addEventListener("dragover", (e) => { e.preventDefault(); pane.classList.add("drag-over"); });
    pane.addEventListener("dragleave", (e) => { if (!pane.contains(e.relatedTarget)) pane.classList.remove("drag-over"); });
    pane.addEventListener("drop", async (e) => {
        e.preventDefault();
        pane.classList.remove("drag-over");
        if (PY.state === "running") { showToast("Wait for the running step to finish before adding files."); return; }
        const items = [...(e.dataTransfer.items || [])];
        const entries = items.map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
        if (entries.length) {
            const out = [];
            for (const en of entries) await readEntry(en, "", out);
            reportUpload(await addUserFiles(out));
        } else {
            await uploadFileList([...e.dataTransfer.files]);
        }
    });
    $("themeBtn").addEventListener("click", () => {
        const dark = document.documentElement.getAttribute("data-theme") === "dark";
        document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
    });
    document.querySelectorAll(".modal-overlay").forEach((m) => {
        m.addEventListener("click", (e) => { if (e.target === m && m.id !== "confirmModal") closeModal(m.id); });
    });
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        const open = document.querySelector(".modal-overlay.active");
        if (open) { if (open.id === "confirmModal") $("confirmCancel").click(); else closeModal(open.id); }
        else if ($("debugConsole").classList.contains("open")) setDebugConsole(false);
    });
    $("debugBtn").addEventListener("click", () => setDebugConsole(!$("debugConsole").classList.contains("open")));
    $("debugClose").addEventListener("click", () => setDebugConsole(false));
    $("debugClear").addEventListener("click", () => { DEBUG.entries = []; renderDebugLog(); });
    $("debugFilter").addEventListener("change", (e) => { DEBUG.filter = e.target.value; renderDebugLog(); });
    window.addEventListener("beforeunload", (e) => {
        if (!S.timeline.length && !WS.files.size) return;
        e.preventDefault();
        e.returnValue = "";
    });
    setInterval(() => { if (RUN.active) renderStatusBar(); }, 1000);
}

function init() {
    const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    $("versionBadge").textContent = "v" + APP_VERSION;
    $("autonomySelect").value = SETTINGS.autonomy;
    $("effortSelect").value = SETTINGS.effort;
    wireEvents();
    renderHeader();
    renderTimeline();
    renderWorkspace();
    renderStatusBar();
    updateComposer();
    restartInterpreter();
}

if (typeof document !== "undefined") init();
