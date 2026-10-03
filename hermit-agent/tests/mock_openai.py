"""A scripted OpenAI-compatible endpoint for the end-to-end tests.

Replies are picked by a keyword in the task (the first user message) and by how many
assistant messages the request already holds, so a test is a list of model turns.
Every request is recorded, and so is every hit on /exfil/…, which the network-guard
probes in the e2e test aim at: a non-empty `exfil` list means something got out.

History compaction: the summariser's request (recognised by its system prompt) gets
SUMMARY back, and a compacted history's `<history_summary steps="1-K">` adds K to the
turn count, since those K assistant messages are gone. A reply marked
`overflow_unless_compacted` answers a 400 context-size error until the history has
been compacted.
"""
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


SUMMARY = "## Task\nMock task.\n## Done so far\nMOCK-SUMMARY of the earlier steps."
SUMMARISER_MARK = "You compress the history of an AI agent's session"


class MockState:
    def __init__(self, scripts):
        self.scripts = scripts          # keyword -> [ {reasoning, content, finish} ]
        self.requests = []              # chat request bodies
        self.exfil = []                 # (method, path) of every /exfil hit
        self.lock = threading.Lock()


def make_handler(state):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

        def send_json(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def record_exfil(self):
            if self.path.startswith("/exfil"):
                with state.lock:
                    state.exfil.append((self.command, self.path))
                return True
            return False

        def do_OPTIONS(self):
            self.record_exfil()
            self.send_response(204)
            self.cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if self.record_exfil():
                return self.send_json(200, {"got": "it"})
            if self.path == "/props":   # llama.cpp's: context size only, no template
                return self.send_json(200, {"default_generation_settings": {"n_ctx": 4096}})
            if self.path.endswith("/models"):
                return self.send_json(200, {"data": [{"id": "mock-model"}]})
            self.send_json(404, {"error": {"message": "not found"}})

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            if self.record_exfil():
                return self.send_json(200, {"got": "it"})
            if not self.path.endswith("/chat/completions"):
                return self.send_json(404, {"error": {"message": "not found"}})
            body = json.loads(raw or b"{}")
            with state.lock:
                state.requests.append(body)
            msgs = body.get("messages", [])
            first_user = next((m["content"] for m in msgs if m["role"] == "user"), "")
            if msgs and SUMMARISER_MARK in msgs[0]["content"]:
                reply = {"content": SUMMARY}
            else:
                compacted = re.search(r'<history_summary steps="1-(\d+)">', first_user)
                turn = sum(1 for m in msgs if m["role"] == "assistant") + (int(compacted.group(1)) if compacted else 0)
                script = next((v for k, v in state.scripts.items() if k in first_user), None)
                if script is None or turn >= len(script):
                    return self.send_json(500, {"error": {"message": f"mock has no reply for turn {turn}"}})
                reply = script[turn]
                if reply.get("overflow_unless_compacted") and not compacted:
                    return self.send_json(400, {"error": {"message": "the request exceeds the available context size, try increasing it"}})
            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()

            def chunk(delta, finish=None, usage=None, timings=None):
                d = {"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                if usage:
                    d["usage"] = usage
                if timings:
                    d["timings"] = timings
                self.wfile.write(b"data: " + json.dumps(d).encode() + b"\n\n")
                self.wfile.flush()
                if reply.get("delay"):
                    time.sleep(reply["delay"])   # stream slowly, like a real model

            reasoning = reply.get("reasoning", "")
            content = reply.get("content", "")
            for i in range(0, len(reasoning), 40):
                chunk({"reasoning_content": reasoning[i:i + 40]})
            for i in range(0, len(content), 40):
                chunk({"content": content[i:i + 40]})
            chunk({}, reply.get("finish", "stop"), {"prompt_tokens": 100, "completion_tokens": 20},
                  {"cache_n": 60, "prompt_n": 40, "prompt_per_second": 500.0, "predicted_n": 20, "predicted_per_second": 33.3})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            self.close_connection = True

    return Handler


def serve(scripts):
    """Start the mock on a free port; returns (server, port, state)."""
    state = MockState(scripts)
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(state))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1], state
