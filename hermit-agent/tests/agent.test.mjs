// Agent logic: reply parsing, observations, diffing, risk classification and the
// helpers carried over from HermitUI. Run: node tests/agent.test.mjs
import { check, section, report } from "./check.mjs";
import X from "./extract.mjs";

const F = "```";

section("1. parseReply — what runs and what doesn't (DESIGN §5.1)");
{
    let r = X.parseReply(`Let me look.\n${F}python\nprint(1)\n${F}`, "stop");
    check("python block runs", r.kind === "code" && r.code === "print(1)\n" && r.blockCount === 1);
    check("prose before the block is kept", r.prose === "Let me look.");
    r = X.parseReply(`${F}py\nx=1\n${F}\nthen\n${F}python\nx=2\n${F}`, "stop");
    check("only the first of two blocks runs, both counted", r.kind === "code" && r.code === "x=1\n" && r.blockCount === 2);
    check("python3 tag runs", X.parseReply(`${F}python3\nprint(3)\n${F}`).kind === "code");
    check("CRLF after the tag still runs", X.parseReply(`${F}python\r\nprint(1)\r\n${F}`).kind === "code");
    // The spike bug: a bare fence used to *show* output was executed as Python.
    r = X.parseReply(`The script printed:\n${F}\n2026-10-03 15:25:27\n${F}\nDone.`, "stop");
    check("bare fence is prose, not code", r.kind === "final", JSON.stringify(r));
    check("text fence is prose", X.parseReply(`Output:\n${F}text\nhello\n${F}`).kind === "final");
    check("pyproject fence is not python", X.parseReply(`${F}pyproject\nx\n${F}`).kind === "final");
    check("unclosed block is broken", X.parseReply(`${F}python\nprint(1`, "stop").kind === "broken");
    check("unclosed block at the token limit is a cut-off", X.parseReply(`${F}python\nprint(1`, "length").kind === "cutoff");
    check("no block at the token limit is a cut-off, not a final answer", X.parseReply("I think the answer", "length").kind === "cutoff");
    r = X.parseReply("I need one detail.\nask: Which column holds the dates?", "stop");
    check("ask: line pauses", r.kind === "ask" && r.question === "Which column holds the dates?" && r.prose === "I need one detail.");
    check("bold **ask:** too", X.parseReply("**ask:** which file?").kind === "ask");
    check("empty reply", X.parseReply("   ", "stop").kind === "empty");
    r = X.parseReply("The total is 42. I saved report.md.", "stop");
    check("final answer", r.kind === "final" && r.answer === "The total is 42. I saved report.md.");
}

section("2. splitReply — inline think tags become reasoning");
{
    const r = X.splitReply("<think>plan it</think>Answer here", true);
    check("reasoning extracted", r.reasoning === "plan it" && r.text === "Answer here");
    const s = X.splitReply("<think>still going", false);
    check("unclosed think while streaming stays reasoning", s.reasoning === "still going" && s.text === "");
}

section("3. truncateOutput — first 2 KB + last 4 KB (DESIGN §5.2)");
{
    check("short output unchanged", X.truncateOutput("abc") === "abc");
    const long = "h".repeat(3000) + "m".repeat(20000) + "t".repeat(5000);
    const t = X.truncateOutput(long);
    check("head kept", t.startsWith("h".repeat(2048) + "\n[…"));
    check("tail kept", t.endsWith("t".repeat(4096)));
    check("omission marked in KB", /\[… 2\d KB omitted …\]/.test(t), t.slice(2040, 2080));
    check("boundary: exactly head+tail is unchanged", X.truncateOutput("x".repeat(6144)).length === 6144);
}

section("4. diffListings / formatChanges");
{
    const d = X.diffListings({ a: "1", b: "2", c: "3" }, { a: "1", b: "9", d: "4" });
    check("added/modified/deleted", JSON.stringify(d) === JSON.stringify({ added: ["d"], modified: ["b"], deleted: ["c"] }));
    check("formatChanges", X.formatChanges(d) === "+d  ~b  -c");
    check("formatChanges takes objects", X.formatChanges({ added: [{ path: "x.csv" }] }) === "+x.csv");
    check("formatChanges none", X.formatChanges({ added: [], modified: [], deleted: [] }) === "none" && X.formatChanges(null) === "none");
}

section("5. classifyEffect — gate on what the step did (DESIGN §2.3)");
{
    const origins = { "data.csv": "user", "out.txt": "agent" };
    const c = (diff, o) => X.classifyEffect(Object.assign({ added: [], modified: [], deleted: [] }, diff), origins, o);
    check("new files only → auto", c({ added: ["new.txt"] }).verdict === "auto");
    check("changing an agent file → auto", c({ modified: ["out.txt"] }).verdict === "auto");
    check("deleting an agent file → auto", c({ deleted: ["out.txt"] }).verdict === "auto");
    let r = c({ deleted: ["data.csv"] });
    check("deleting a user file → ask", r.verdict === "ask" && r.reasons[0] === "deletes your file data.csv", r.reasons);
    check("overwriting a user file → ask", c({ modified: ["data.csv"] }).verdict === "ask");
    check("renaming a user file (delete + add) → ask", c({ added: ["renamed.csv"], deleted: ["data.csv"] }).verdict === "ask");
    const many = Array.from({ length: 21 }, (_, i) => `f${i}.txt`);
    check("more than 20 files → ask", c({ added: many }).verdict === "ask");
    check("20 files → auto", c({ added: many.slice(0, 20) }).verdict === "auto");
    check("more than 10 MB written → ask", c({ added: ["big.bin"] }, { bytesWritten: 11 * 1024 * 1024 }).verdict === "ask");
    r = c({}, { netAttempts: ["fetch https://x", "WebSocket wss://y"] });
    check("blocked network attempt → ask", r.verdict === "ask" && /network.*fetch https:\/\/x and 1 more/.test(r.reasons[0]), r.reasons);
    check("workspace limit → ask", c({ added: ["x"] }, { overLimit: "would grow the workspace to 300 MB" }).verdict === "ask");
}

section("6. buildObservation — the envelope");
{
    const o = X.buildObservation({ step: 4, status: "ok", output: "hello\n", changes: { added: [{ path: "a.txt" }], modified: [], deleted: [] }, notes: ["Loaded numpy"] });
    check("ok envelope", o === '<observation step="4" status="ok">\nhello\nfiles changed: +a.txt\nnote: Loaded numpy\n</observation>', o);
    check("empty output says so", X.buildObservation({ step: 1, status: "ok", output: "", changes: { added: [], modified: [], deleted: [] } }).includes("(no output)\nfiles changed: none"));
    const rej = X.buildObservation({ step: 2, status: "rejected", reason: "keep the raw file", notes: ["rolled back"] });
    check("rejection carries the reason, not the output", rej === '<observation step="2" status="rejected">\nThe user rejected this step. Reason: keep the raw file\nnote: rolled back\n</observation>', rej);
    check("note-only observation (nothing ran)", X.buildObservation({ step: 3, status: "error", notes: ["cut off"] }) === '<observation step="3" status="error">\nnote: cut off\n</observation>');
}

section("7. appendToLastUserMessage — never two user messages in a row");
{
    const m = [{ role: "system", content: "s" }, { role: "user", content: "obs" }];
    X.appendToLastUserMessage(m, "note");
    check("merged into the last user message", m.length === 2 && m[1].content === "obs\n\nnote");
    m.push({ role: "assistant", content: "a" });
    X.appendToLastUserMessage(m, "follow-up");
    check("new user message after the assistant", m.length === 4 && m[3].role === "user");
}

section("8. Paths");
{
    for (const p of ["a.txt", "dir/sub/ü file.csv", "x/.hidden"]) check(`safe: ${p}`, X.isSafeRelPath(p));
    for (const p of ["", "/etc/passwd", "../x", "a/../b", "a//b", "a/./b", "C:/x", "a\\b", "a\0b", "dir/", "x".repeat(600)]) check(`unsafe: ${JSON.stringify(p).slice(0, 30)}`, !X.isSafeRelPath(p));
    check("upload path normalised", X.normalizeUploadPath("\\folder\\a.txt") === "folder/a.txt" && X.normalizeUploadPath("/x//y.txt") === "x/y.txt");
    check("upload traversal rejected", X.normalizeUploadPath("../../a.txt") === null);
}

section("9. makeFence — longer than any backtick run in the content");
check("plain", X.makeFence("abc") === "```");
check("content with a 3-fence", X.makeFence("```py\nx\n```") === "````");
check("content with a 5-fence", X.makeFence("`````") === "``````");

section("10. Reasoning params & error hints (copied from HermitUI)");
{
    const qwen = "{%- if reasoning_effort is defined %}{%- set resolved_reasoning_effort = reasoning_effort %}{%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}{{ raise_exception('bad') }}";
    const t = X.parseReasoningTemplateSupport(qwen);
    check("Qwen levels read from the template", JSON.stringify(t.levels) === '["xhigh","medium","low"]' && t.maxLevel === "xhigh");
    check("high → xhigh where the template calls it that", X.buildReasoningParams("high", { levels: t.levels }).reasoning_effort === "xhigh");
    check("low passes through", X.buildReasoningParams("low", { levels: t.levels }).reasoning_effort === "low");
    check("off → enable_thinking:false", X.buildReasoningParams("off").chat_template_kwargs.enable_thinking === false);
    check("unlisted level dropped", JSON.stringify(X.buildReasoningParams("high", { levels: ["low", "medium"] })) === "{}");
    check("rejection detection", X.looksLikeReasoningRejection("Unexpected reasoning effort high"));
    check("401 hint", /API key/.test(X.chatErrorHint("Server Error 401: nope")));
    check("network hint local", /server is running/.test(X.chatErrorHint("Failed to fetch", { apiUrl: "http://localhost:8080/v1" })));
    check("context hint mentions rewind", /rewind/.test(X.chatErrorHint("the request exceeds the available context size")));
    check("unknown error → no hint", X.chatErrorHint("weird") === "");
    check("scheme-less local URL gets http", X.normalizeApiUrl("localhost:8080/v1") === "http://localhost:8080/v1");
    check("apiRoot strips /v1", X.apiRoot("http://h:8080/v1/") === "http://h:8080");
}

section("11. Prompts");
{
    const p = X.buildSystemPrompt("Prefer pandas.");
    check("system prompt ends with the user's instructions", p.endsWith("Additional instructions from the user:\nPrefer pandas."));
    check("system prompt warns about subprocess and int32", /no subprocesses/.test(p) && /int32/.test(p));
    check("only python fences run (said in the prompt)", p.includes("Only ```python blocks are executed"));
    check("no instructions → base prompt", !X.buildSystemPrompt("  ").includes("Additional instructions"));
    const m = X.buildTaskMessage("Sum it", [{ path: "a.csv", size: 2048 }]);
    check("task message lists files", m === "Task: Sum it\n\nFiles in /workspace: a.csv (2.0 KB)", m);
    check("task message with an empty workspace", X.buildTaskMessage("x", []).endsWith("(empty)"));
}

section("12. sha256 — WebCrypto and the JS fallback agree");
{
    const enc = new TextEncoder();
    check("known vector 'abc'", (await X.sha256Hex(enc.encode("abc"))) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 100000]) {
        const b = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
        check(`fallback matches WebCrypto at ${n} bytes`, X.sha256HexJs(b) === (await X.sha256Hex(b)));
    }
}

report();
