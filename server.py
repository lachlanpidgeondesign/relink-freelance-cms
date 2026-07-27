"""Minimal static file server with a /shutdown endpoint.

Used by Launch CMS.command so the browser can stop the server
when the tab is closed (via navigator.sendBeacon).
"""

import os
import sys
import re
import json
import signal
import threading
import subprocess
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

# Paths for the live-sync proxy (POST /api/push, /api/pull, /api/sync). The proxy
# shells out to the validated CLI so the Puzzlr API key stays server-side
# (.puzzlr.local) and is never exposed to the browser.
REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
SYNC_TOOL = os.path.join(REPO_ROOT, "tools", "puzzlr_api.py")
PUZZLE_ID_RE = re.compile(r"^l\d+$")

# Will be set after the server is created
_server = None


def _do_shutdown():
    """Shut down the server and kill the parent process (the shell script)."""
    if _server:
        _server.shutdown()  # cleanly stops serve_forever()
    # Kill the parent shell script so Automator / Terminal exit too
    ppid = os.getppid()
    if ppid > 1:
        os.kill(ppid, signal.SIGTERM)


class RelinkServer(HTTPServer):
    allow_reuse_address = True


class RequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Prevent browser caching of JS/CSS/JSON during development (so live-sync
        # writes are picked up immediately on reload).
        if self.path.endswith(('.js', '.css', '.html', '.json')):
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        super().end_headers()

    def do_POST(self):
        if self.path == "/shutdown":
            self.send_response(200)
            self.end_headers()
            # Clean shutdown from a separate thread so the response completes
            threading.Thread(target=_do_shutdown, daemon=True).start()
        elif self.path == "/api/push":
            self._handle_sync("push")
        elif self.path == "/api/pull":
            self._handle_sync("pull")
        elif self.path == "/api/sync":
            self._handle_library_sync()
        else:
            self.send_error(404)

    def _handle_sync(self, command):
        """Proxy a push/pull to the puzzlr_api CLI. The API key stays here on the
        server (read from .puzzlr.local by the CLI) and is never sent to the browser.

        Loopback-only: this runs a local subprocess, so any non-localhost caller is
        refused even though the dev server binds all interfaces. Running through the
        CLI also means its #0 safety guard applies — a non-interactive subprocess is
        'auto mode', so LIVE puzzles are hard-refused (no flag can bypass that)."""
        client = self.client_address[0] if self.client_address else ""
        if client not in ("127.0.0.1", "::1"):
            self._send_json(403, {"ok": False, "error": "forbidden (localhost only)"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            length = 0
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except (json.JSONDecodeError, ValueError):
            self._send_json(400, {"ok": False, "error": "invalid JSON body"})
            return
        pid = str(body.get("id", ""))
        if not PUZZLE_ID_RE.match(pid):
            self._send_json(400, {"ok": False, "error": f"invalid puzzle id: {pid!r}"})
            return
        args = [command, pid]
        if body.get("apply"):
            args.append("--apply")
        try:
            proc = subprocess.run(
                [sys.executable, SYNC_TOOL, *args],
                cwd=REPO_ROOT, capture_output=True, text=True, timeout=60,
            )
        except subprocess.TimeoutExpired:
            self._send_json(504, {"ok": False, "error": "the live API request timed out"})
            return
        except OSError as exc:
            self._send_json(500, {"ok": False, "error": f"could not run sync tool: {exc}"})
            return
        self._send_json(200, {
            "ok": proc.returncode == 0,
            "code": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        })

    def _handle_library_sync(self):
        """Proxy `sync` to the puzzlr_api CLI: a library-wide live -> local sync that
        (1) content-syncs every already-linked local puzzle from its live level,
        preserving local PDL, and (2) creates new local files for every live-only
        level (ones with no local match). No puzzle id — this is library-wide.
        Read-only against the live system (it only GETs levels and writes local
        files), so it can never touch a live puzzle. Dry-run unless body.apply.

        Loopback-only, like the push/pull proxy: the API key stays server-side in
        .puzzlr.local and is never exposed to the browser."""
        client = self.client_address[0] if self.client_address else ""
        if client not in ("127.0.0.1", "::1"):
            self._send_json(403, {"ok": False, "error": "forbidden (localhost only)"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            length = 0
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except (json.JSONDecodeError, ValueError):
            self._send_json(400, {"ok": False, "error": "invalid JSON body"})
            return
        args = ["sync"]
        if body.get("apply"):
            args.append("--apply")
        try:
            proc = subprocess.run(
                [sys.executable, SYNC_TOOL, *args],
                cwd=REPO_ROOT, capture_output=True, text=True, timeout=180,
            )
        except subprocess.TimeoutExpired:
            self._send_json(504, {"ok": False, "error": "the live API request timed out"})
            return
        except OSError as exc:
            self._send_json(500, {"ok": False, "error": f"could not run sync tool: {exc}"})
            return
        self._send_json(200, {
            "ok": proc.returncode == 0,
            "code": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        })

    def _send_json(self, status, obj):
        payload = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    # Silence per-request log lines
    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    _server = RelinkServer(("", PORT), RequestHandler)

    # Handle SIGTERM (from kill command) — must call shutdown() from a
    # separate thread to avoid deadlocking with serve_forever()
    signal.signal(signal.SIGTERM,
                  lambda *_: threading.Thread(target=_do_shutdown, daemon=True).start())

    print(f"Relink CMS server running on http://localhost:{PORT}")
    try:
        _server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _server.server_close()
        print("Server stopped.")
