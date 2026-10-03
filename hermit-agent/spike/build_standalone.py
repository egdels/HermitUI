"""Throwaway spike: inline a pinned Pyodide core into one HTML file (DESIGN §8).

Downloads the core files into vendor/ (gitignored) once, gzips + base64-encodes them
into window.__PYODIDE_INLINE__ and writes build/pyodide-standalone.html. Open that
from file://, or run probe_file_boot.py.

    ../../benchmark/.venv/bin/python build_standalone.py
"""
import base64
import gzip
import pathlib
import sys
import urllib.request

sys.stdout.reconfigure(line_buffering=True)

HERE = pathlib.Path(__file__).resolve().parent
VERSION = "0.29.5"
CORE = ["pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]


def main():
    vendor = HERE / "vendor" / f"pyodide-{VERSION}"
    vendor.mkdir(parents=True, exist_ok=True)
    parts = []
    for name in CORE:
        path = vendor / name
        if not path.exists():
            print(f"downloading {name} …")
            url = f"https://cdn.jsdelivr.net/pyodide/v{VERSION}/full/{name}"
            path.write_bytes(urllib.request.urlopen(url).read())
        raw = path.read_bytes()
        b64 = base64.b64encode(gzip.compress(raw, 9)).decode()
        print(f"{name:20} raw {len(raw) / 1e6:6.2f} MB  inlined {len(b64) / 1e6:6.2f} MB")
        parts.append(f'"{name}":"{b64}"')
    inline = "<script>window.__PYODIDE_INLINE__={" + ",".join(parts) + "};</script>"
    html = (HERE / "standalone.template.html").read_text()
    html = html.replace("<!-- @pyodide:inline -->", inline).replace("@PYODIDE_VERSION@", VERSION)
    out = HERE / "build" / "pyodide-standalone.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(html)
    print(f"wrote {out.relative_to(HERE)}: {out.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
