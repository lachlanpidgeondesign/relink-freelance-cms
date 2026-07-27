#!/usr/bin/env python3
"""Puzzlr live-API sync tool for Relink levels.

Push local PDL-rich puzzles (save-data/l*.json) up to the live Puzzlr management
API, and pull live levels down to backfill ``canonicalId`` on local files.

Runs on system Python 3 with only the standard library (urllib) — no pip
installs, mirroring tools that run outside Docker (e.g. pdl_analysis.py).

==============================  SAFETY  ==============================
 #0 RULE — NEVER mutate a LIVE puzzle without explicit human authorisation.
   * LIVE  = a level whose date / publishDate is today or earlier (playable now).
   * Mutating ops (push / re-push) HARD-REFUSE live targets.
   * In auto / non-interactive mode (no TTY) live puzzles are completely
     off-limits — there is NO flag that bypasses this.
   * ``pull`` only ever writes to LOCAL files (canonicalId); it never calls a
     mutating live endpoint, so it cannot affect live puzzles.
=====================================================================

Config (API key + game id), resolved in this order:
  1. env   PUZZLR_API_KEY / PUZZLR_GAME_ID
  2. file  .puzzlr.local  (repo root, untracked via *.local in .gitignore)
             { "apiKey": "...", "gameId": "..." }

Usage:
  python3 tools/puzzlr_api.py list
  python3 tools/puzzlr_api.py pull   [<id>] [--apply]
  python3 tools/puzzlr_api.py push   <id> [--apply] [--force] [--allow-live]
  python3 tools/puzzlr_api.py import <levelId...> [--all-new] [--apply]
  python3 tools/puzzlr_api.py sync   [--apply]
  python3 tools/puzzlr_api.py diff   <id>

All mutating commands are DRY-RUN by default; pass --apply to perform writes.
"""

import argparse
import copy
import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import date

# ── Paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
SAVE_DIR = os.path.join(REPO_ROOT, "save-data")
CONFIG_FILE = os.path.join(REPO_ROOT, ".puzzlr.local")
REBUILD_INDEX = os.path.join(SCRIPT_DIR, "rebuild_index.py")

# ── API constants ──────────────────────────────────────────────────────────
BASE_URL = "https://api.puzzlr.net/api/v1"
DEFAULT_GAME_ID = "30454bd0-3a84-4ea0-8d6f-9ef560d8f31a"
# Row accent colours, indexed by row.position (matches the live CMS ordering).
COLORS = ["purple", "blue", "green", "yellow"]

# Cloudflare fronts the API and blocks urllib's default UA (error 1010).
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

TODAY = date.today().isoformat()  # 'YYYY-MM-DD' — ISO strings sort chronologically.


# ── Small helpers ───────────────────────────────────────────────────────────
def die(msg, code=1):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def norm(s):
    """Normalise a tile word for content matching (case/space-insensitive)."""
    return (s or "").strip().upper()


def date_only(s):
    """Return just the YYYY-MM-DD portion of a date/datetime string, dropping any
    time component. The live API's publishDate can carry a time (e.g.
    '2026-07-10T00:00:00.000Z'); locally we only ever store the date."""
    if not s:
        return s
    return re.split(r"[T ]", str(s).strip(), 1)[0]


def is_live(date_str):
    """A date string is LIVE if it is set and is today or earlier."""
    return bool(date_str) and date_str <= TODAY


def interactive():
    return sys.stdin.isatty() and sys.stdout.isatty()


# ── Config / auth ───────────────────────────────────────────────────────────
def resolve_config(require_key=True):
    """Resolve (api_key, game_id). game_id always resolves (falls back to the
    default); api_key may be None when require_key is False (e.g. an offline
    dry-run that performs no network call)."""
    api_key = os.environ.get("PUZZLR_API_KEY")
    game_id = os.environ.get("PUZZLR_GAME_ID")
    if (not api_key or not game_id) and os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            die(f"could not read {CONFIG_FILE}: {exc}")
        api_key = api_key or data.get("apiKey")
        game_id = game_id or data.get("gameId")
    game_id = game_id or DEFAULT_GAME_ID
    if require_key and not api_key:
        die(
            "no API key found. Set PUZZLR_API_KEY, or create .puzzlr.local in the "
            'repo root:\n  { "apiKey": "your-key", "gameId": "..." }'
        )
    return api_key, game_id


# ── HTTP ────────────────────────────────────────────────────────────────────
def _make_ssl_context():
    """Return a verifying SSL context with a usable CA bundle.

    python.org framework Python often ships with no CA store configured
    (ssl default paths empty, no certifi), which breaks HTTPS verification.
    We locate a valid bundle instead of ever disabling verification.
    """
    try:
        import certifi  # type: ignore
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    paths = ssl.get_default_verify_paths()
    if paths.cafile or paths.capath:
        return ssl.create_default_context()
    for cafile in (
        "/etc/ssl/cert.pem",                       # macOS / LibreSSL system bundle
        "/opt/homebrew/etc/openssl@3/cert.pem",   # Homebrew (Apple silicon)
        "/usr/local/etc/openssl@3/cert.pem",      # Homebrew (Intel)
        "/etc/pki/tls/certs/ca-bundle.crt",       # RHEL/Fedora
    ):
        if os.path.exists(cafile):
            return ssl.create_default_context(cafile=cafile)
    return ssl.create_default_context()  # last resort — still verifies


_SSL_CONTEXT = _make_ssl_context()


def api_request(method, path, api_key, body=None):
    """Return (status_code, parsed_json). status_code is None on a network error."""
    url = f"{BASE_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")
    # A real User-Agent avoids Cloudflare blocking urllib's default (error 1010).
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, context=_SSL_CONTEXT) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode(errors="replace")
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {"raw": raw}
        return exc.code, parsed
    except urllib.error.URLError as exc:
        return None, {"error": str(exc)}


def get_levels(api_key, game_id):
    status, body = api_request("GET", f"/games/{game_id}/levels", api_key)
    if status is None:
        die(f"network error reaching the API: {body.get('error')}")
    if status != 200 or not body.get("success", True):
        die(f"GET levels failed (HTTP {status}): {json.dumps(body)[:400]}")
    return body.get("data", [])


# ── Local puzzle IO ─────────────────────────────────────────────────────────
def puzzle_path(pid):
    pid = pid if pid.startswith("l") else f"l{pid}"
    return os.path.join(SAVE_DIR, f"{pid}.json"), pid


def load_local_puzzle(pid):
    path, pid = puzzle_path(pid)
    if not os.path.exists(path):
        die(f"local puzzle not found: {path}")
    with open(path) as fh:
        return json.load(fh), path, pid


def iter_local_puzzles():
    for name in sorted(os.listdir(SAVE_DIR)):
        if not name.startswith("l") or not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(SAVE_DIR, name)) as fh:
                yield json.load(fh), os.path.join(SAVE_DIR, name)
        except (OSError, json.JSONDecodeError):
            continue


def rebuild_index():
    """Regenerate save-data/puzzles-index.json (preserves canonicalId)."""
    subprocess.run([sys.executable, REBUILD_INDEX], cwd=REPO_ROOT, check=True)


def set_index_canonical(pid, canonical_id):
    """Surgically set one index entry's canonicalId (placed after `name`, matching
    the CMS field order) without rebuilding the whole index.

    The happy path is purely surgical, so linking one puzzle touches exactly one
    line. A full rebuild is used ONLY to create a missing index from scratch —
    never to "repair" a present one, because rebuild_index.py re-sorts every entry
    and escapes non-ASCII (ensure_ascii=True), which would churn the whole
    committed file. If the entry can't be found we warn and leave the index
    untouched (canonicalId still lives on the puzzle file, the source of truth)."""
    index_path = os.path.join(SAVE_DIR, "puzzles-index.json")
    if not os.path.exists(index_path):
        rebuild_index()
        return
    try:
        with open(index_path) as fh:
            index = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"  (warning: index unreadable ({exc}); left untouched — {pid}'s "
              "canonicalId is saved on the puzzle file)")
        return
    puzzles = index.get("puzzles", [])
    pos = next((i for i, p in enumerate(puzzles) if p.get("id") == pid), None)
    if pos is None:
        print(f"  (warning: {pid} not in index; left untouched — its canonicalId "
              "is saved on the puzzle file. Rebuild the index to add it.)")
        return
    entry = puzzles[pos]
    ordered = {}
    for k, v in entry.items():
        if k == "canonicalId":
            continue
        ordered[k] = v
        if k == "name":
            ordered["canonicalId"] = canonical_id
    ordered.setdefault("canonicalId", canonical_id)
    puzzles[pos] = ordered
    with open(index_path, "w") as fh:
        json.dump(index, fh, indent=2, ensure_ascii=False)


def set_index_entry(puzzle):
    """Rewrite one index entry's content-derived fields after a content sync
    (date, name, phase2TileCount, writingComplete, searchFields). Keeps the
    existing pdlComplete (PDL is preserved by the sync) and canonicalId."""
    index_path = os.path.join(SAVE_DIR, "puzzles-index.json")
    try:
        with open(index_path) as fh:
            index = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"  (warning: index unreadable ({exc}); search fields not refreshed)")
        return
    puzzles = index.get("puzzles", [])
    pos = next((i for i, p in enumerate(puzzles) if p.get("id") == puzzle.get("id")), None)
    if pos is None:
        print(f"  (warning: {puzzle.get('id')} not in index; search fields not "
              "refreshed. Rebuild the index to add it.)")
        return
    rows = puzzle.get("rows", [])
    relink = puzzle.get("relink", {})
    entry = {"id": puzzle.get("id"), "date": puzzle.get("date", ""), "name": puzzle.get("name", "")}
    if puzzle.get("canonicalId"):
        entry["canonicalId"] = puzzle["canonicalId"]
    entry["phase2TileCount"] = sum(1 for t in relink.get("tiles", []) if t.get("source") == "grid")
    entry["writingComplete"] = writing_complete(puzzle)
    entry["pdlComplete"] = puzzles[pos].get("pdlComplete", False)
    entry["searchFields"] = {
        "tiles": " ".join(t.get("text", "") for r in rows for t in r.get("tiles", [])),
        "categories": " ".join(r.get("category", "") for r in rows),
        "answer": relink.get("answer", ""),
        "decoyDescriptions": " ".join(
            d.get("pdl", {}).get("description", "") for d in puzzle.get("decoys", [])
        ),
    }
    puzzles[pos] = entry
    with open(index_path, "w") as fh:
        json.dump(index, fh, indent=2, ensure_ascii=False)

# ── Import: create a NEW local puzzle from a live-only level ─────────────────
_UID_COUNTER = 0


def _uid(prefix):
    """Tile/row id in the CMS `{prefix}-{ms}-{n}` style (js/state.js uid())."""
    global _UID_COUNTER
    _UID_COUNTER += 1
    return f"{prefix}-{int(time.time() * 1000)}-{_UID_COUNTER}"


def next_local_id_num():
    """Smallest unused l{N} number, scanning save-data/l*.json (matches the CMS)."""
    mx = 0
    for name in os.listdir(SAVE_DIR):
        m = re.match(r"^l(\d+)\.json$", name)
        if m:
            mx = max(mx, int(m.group(1)))
    return mx + 1


def make_local_skeleton(pid, pub_date=None):
    """A blank schemaVersion-5 puzzle mirroring js/state.js createNewPuzzle, with
    empty PDL. Content (rows/relink/name) is filled in by apply_live_to_local."""
    rows = []
    for pos in range(4):
        rows.append({
            "id": _uid("row"),
            "position": pos,
            "category": "",
            "tiles": [
                {"id": _uid("tile"), "text": "", "isImpostor": False, "isRelink": False}
                for _ in range(4)
            ],
            "pdl": {"group": {"knowledge": None, "manipulation": None, "abstraction": None,
                              "knowledgeDomain": None, "nicheKnowledge": None}},
        })
    return {
        "schemaVersion": 5,
        "id": pid,
        "date": pub_date or "",
        "name": "",
        "rows": rows,
        "relink": {"tiles": [], "answer": "",
                   "pdl": {"answerConstruction": {"manipulation": None, "knowledge": None}}},
        "impostorColumn": {"pdl": {"knowledge": None, "manipulation": None, "abstraction": None,
                                   "knowledgeDomain": None, "nicheKnowledge": None}},
        "decoys": [],
        "board": {"specialistGroupCount": 0, "decoyCount": 0, "phase2TileCount": 0,
                  "isThemed": False, "themeDomain": None},
    }


def build_index_entry(puzzle, pdl_complete=False):
    """Build an index entry mirroring js/fileio.js buildIndexEntry (field order:
    id, date, name, canonicalId, phase2TileCount, writingComplete, pdlComplete,
    searchFields)."""
    rows = puzzle.get("rows", [])
    relink = puzzle.get("relink", {})
    entry = {"id": puzzle.get("id"), "date": puzzle.get("date", ""), "name": puzzle.get("name", "")}
    if puzzle.get("canonicalId"):
        entry["canonicalId"] = puzzle["canonicalId"]
    entry["phase2TileCount"] = sum(1 for t in relink.get("tiles", []) if t.get("source") == "grid")
    entry["writingComplete"] = writing_complete(puzzle)
    entry["pdlComplete"] = pdl_complete
    entry["searchFields"] = {
        "tiles": " ".join(t.get("text", "") for r in rows for t in r.get("tiles", [])),
        "categories": " ".join(r.get("category", "") for r in rows),
        "answer": relink.get("answer", ""),
        "decoyDescriptions": " ".join(
            d.get("pdl", {}).get("description", "") for d in puzzle.get("decoys", [])
        ),
    }
    return entry


def insert_index_entry(puzzle):
    """Add a NEW index entry for a freshly imported puzzle, inserted in date-desc
    position to match the CMS. If the entry already exists, refresh it instead."""
    index_path = os.path.join(SAVE_DIR, "puzzles-index.json")
    try:
        with open(index_path) as fh:
            index = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"  (warning: index unreadable ({exc}); {puzzle.get('id')} not indexed)")
        return
    puzzles = index.get("puzzles", [])
    if any(p.get("id") == puzzle.get("id") for p in puzzles):
        return set_index_entry(puzzle)
    entry = build_index_entry(puzzle)
    d = entry.get("date") or ""
    pos = len(puzzles)
    for i, p in enumerate(puzzles):
        if (p.get("date") or "") < d:
            pos = i
            break
    puzzles.insert(pos, entry)
    with open(index_path, "w") as fh:
        json.dump(index, fh, indent=2, ensure_ascii=False)

# ── Conversion: local puzzle → API payload ──────────────────────────────────
def _build_relink(puzzle):
    """Build the API relink blob (answerWords, connection, optional answerGroups)
    from the local ordered relink tiles, honouring joinNext compounds.

    Matches the live wire format: one ``{}`` per GROUP (a run of grid tiles
    joined by joinNext); fodder tiles render as literal text; adjacent group
    placeholders have no space between them; fodder is space-separated from
    neighbours. answerGroups is included only when a real compound exists.
    """
    tiles = puzzle.get("relink", {}).get("tiles", [])
    answer_words, groups, tokens, cur = [], [], [], []
    for t in tiles:
        text = t.get("text", "")
        if t.get("source") == "grid":
            answer_words.append(text)
            cur.append(text)
            if not t.get("joinNext"):
                groups.append(cur)
                tokens.append(("group", None))
                cur = []
        else:  # fodder
            if cur:
                groups.append(cur)
                tokens.append(("group", None))
                cur = []
            tokens.append(("fodder", text))
    if cur:
        groups.append(cur)
        tokens.append(("group", None))

    parts = []
    for i, (kind, text) in enumerate(tokens):
        tok = "{}" if kind == "group" else text
        if i == 0:
            parts.append(tok)
        else:
            both_groups = kind == "group" and tokens[i - 1][0] == "group"
            parts.append(("" if both_groups else " ") + tok)
    connection = "".join(parts)

    relink = {"answerWords": answer_words, "connection": connection}
    if any(len(g) > 1 for g in groups):
        relink["answerGroups"] = groups
    return relink


def puzzle_to_api_data(puzzle):
    """Convert a local puzzle into the API ``data`` blob (rows + relink)."""
    rows_sorted = sorted(puzzle.get("rows", []), key=lambda r: r.get("position", 0))
    api_rows = []
    for i, row in enumerate(rows_sorted):
        tiles = row.get("tiles", [])
        imp_idx = next((j for j, t in enumerate(tiles) if t.get("isImpostor")), None)
        impostor = tiles[imp_idx] if imp_idx is not None else None
        words = [t.get("text", "") for t in tiles if not t.get("isImpostor")]
        api_rows.append(
            {
                "color": COLORS[i] if i < len(COLORS) else COLORS[-1],
                "connection": row.get("category", ""),
                "words": words,
                "imposter": impostor.get("text", "") if impostor else "",
                "imposterIndex": imp_idx if imp_idx is not None else 0,
            }
        )
    return {"name": puzzle.get("name", ""), "rows": api_rows, "relink": _build_relink(puzzle)}


def reconstruct_answer(relink):
    """Rebuild a display answer from an API relink blob (for list/diff).

    Fills each ``{}`` placeholder with its group (compound-joined) when
    answerGroups is present, otherwise with the next answerWord.
    """
    conn = relink.get("connection", "") or ""
    groups = relink.get("answerGroups")
    fills = ["".join(g) for g in groups] if groups else list(relink.get("answerWords", []) or [])
    out, i, fi = [], 0, 0
    while i < len(conn):
        if conn[i : i + 2] == "{}":
            out.append(fills[fi] if fi < len(fills) else "{}")
            fi += 1
            i += 2
        else:
            out.append(conn[i])
            i += 1
    return "".join(out)


# ── Inverse conversion: live level → local puzzle (content-sync) ─────────────
def apply_live_to_local(puzzle, live_data, live_pubdate=None):
    """Mutate `puzzle` in place so its CONTENT matches the live level, while
    preserving local-only data: all PDL, tile ids, decoys, impostorColumn,
    board, and the editorial `name`. Returns a list of human-readable changes.

    Rows are matched by position (live colour order). Relink tiles are rebuilt
    from the live answerWords/answerGroups/connection and re-pointed at the grid
    tiles by text; isRelink is re-derived from those answer tiles.
    """
    changes = []
    rows_sorted = sorted(puzzle.get("rows", []), key=lambda r: r.get("position", 0))

    for i, lrow in enumerate(live_data.get("rows", [])):
        if i >= len(rows_sorted):
            break
        row = rows_sorted[i]
        new_cat = lrow.get("connection", "")
        if (row.get("category") or "") != new_cat:
            changes.append(f"row{i + 1} category: {row.get('category')!r} -> {new_cat!r}")
            row["category"] = new_cat
        words = list(lrow.get("words", []))
        idx = lrow.get("imposterIndex")
        if idx is None or idx < 0 or idx > len(words):
            idx = len(words)
        full = words[:idx] + [lrow.get("imposter", "")] + words[idx:]
        for j, tile in enumerate(row.get("tiles", [])):
            if j < len(full):
                if (tile.get("text") or "") != full[j]:
                    changes.append(
                        f"row{i + 1} tile{j + 1} text: {tile.get('text')!r} -> {full[j]!r}")
                    tile["text"] = full[j]
                tile["isImpostor"] = j == idx
                tile["isRelink"] = False  # re-derived from the relink answer below

    relink_live = live_data.get("relink", {})
    answer_words = list(relink_live.get("answerWords", []))
    groups = relink_live.get("answerGroups") or [[w] for w in answer_words]
    connection = relink_live.get("connection", "") or ""
    all_tiles = [(r, t) for r in rows_sorted for t in r.get("tiles", [])]
    used = set()

    def find_tile(text):
        for r, t in all_tiles:  # prefer an unused tile with matching text
            if t.get("id") not in used and (t.get("text") or "") == text:
                return r, t
        for r, t in all_tiles:  # fall back to any matching tile
            if (t.get("text") or "") == text:
                return r, t
        return None, None

    new_tiles, gi = [], 0
    for tok in re.split(r"(\{\})", connection):
        if tok == "{}":
            grp = groups[gi] if gi < len(groups) else None
            gi += 1
            if not grp:
                continue
            for k, word in enumerate(grp):
                r, t = find_tile(word)
                entry = {"text": word, "source": "grid"}
                if r and t:
                    entry["sourceRowId"] = r.get("id")
                    entry["sourceTileId"] = t.get("id")
                    t["isRelink"] = True
                    used.add(t.get("id"))
                if k < len(grp) - 1:
                    entry["joinNext"] = True
                new_tiles.append(entry)
        elif tok.strip():
            new_tiles.append({"text": tok.strip(), "source": "fodder"})

    relink_local = puzzle.setdefault("relink", {})
    old_answer = relink_local.get("answer")
    old_tiles_json = json.dumps(relink_local.get("tiles"), sort_keys=True, ensure_ascii=False)
    relink_local["tiles"] = new_tiles
    new_answer = " ".join(t["text"].strip() for t in new_tiles if t.get("text", "").strip())
    relink_local["answer"] = new_answer
    if (old_answer or "") != new_answer:
        changes.append(f"relink answer: {old_answer!r} -> {new_answer!r}")
    elif old_tiles_json != json.dumps(new_tiles, sort_keys=True, ensure_ascii=False):
        changes.append("relink tiles refreshed (sources/joins re-derived from live)")

    if live_pubdate and (puzzle.get("date") or None) != live_pubdate:
        changes.append(f"date: {puzzle.get('date')!r} -> {live_pubdate!r}")
        puzzle["date"] = live_pubdate

    return changes


# ── Content fingerprint (for pull / list matching) ──────────────────────────
def local_wordset(puzzle):
    return frozenset(
        norm(t.get("text"))
        for r in puzzle.get("rows", [])
        for t in r.get("tiles", [])
        if norm(t.get("text"))
    )


def api_wordset(level):
    data = level.get("data", {})
    words = set()
    for r in data.get("rows", []):
        for w in r.get("words", []):
            if norm(w):
                words.add(norm(w))
        if norm(r.get("imposter")):
            words.add(norm(r.get("imposter")))
    return frozenset(words)


def build_local_index():
    """Return list of (puzzle, path, wordset)."""
    out = []
    for puzzle, path in iter_local_puzzles():
        out.append((puzzle, path, local_wordset(puzzle)))
    return out


def match_level_to_local(level, local_index):
    """Return (puzzle, path) for the unique local puzzle with the same 16 words,
    or None if zero or ambiguous (>1) matches."""
    ws = api_wordset(level)
    if not ws:
        return None
    hits = [(p, path) for (p, path, lws) in local_index if lws == ws]
    return hits[0] if len(hits) == 1 else None


# ── Writing-complete validation (mirrors js/state.js isPuzzleWritingComplete) ──
def writing_complete(puzzle):
    if not puzzle.get("name", "").strip():
        return False
    rows = puzzle.get("rows", [])
    if len(rows) != 4:
        return False
    for row in rows:
        if not row.get("category", "").strip():
            return False
        tiles = row.get("tiles", [])
        if len(tiles) != 4 or not all(t.get("text", "").strip() for t in tiles):
            return False
        if sum(1 for t in tiles if t.get("isImpostor")) != 1:
            return False
    # At least one relink tile across the whole puzzle (not per-row).
    if not any(t.get("isRelink") for r in rows for t in r.get("tiles", [])):
        return False
    relink = puzzle.get("relink", {})
    has_answer = bool(relink.get("answer", "").strip())
    has_tiles = any(t.get("text", "").strip() for t in relink.get("tiles", []))
    return has_answer or has_tiles


# ── Live-puzzle safety guard ────────────────────────────────────────────────
def guard_not_live(local_date, live_date, allow_live, what):
    """HARD-REFUSE mutating a live puzzle.

    `local_date` is the scheduled date in the local file; `live_date` is the
    publishDate already on the server (or None for a brand-new push). The target
    is LIVE if EITHER is today-or-earlier.
    """
    live_local = is_live(local_date)
    live_remote = is_live(live_date)
    if not (live_local or live_remote):
        return  # future-dated / unscheduled — safe to proceed
    which = []
    if live_local:
        which.append(f"local date {local_date}")
    if live_remote:
        which.append(f"live publishDate {live_date}")
    reason = " and ".join(which)
    if not interactive():
        die(
            f"REFUSED: {what} targets a LIVE puzzle ({reason}). Live puzzles are "
            "OFF-LIMITS in auto / non-interactive mode. No flag overrides this."
        )
    if not allow_live:
        die(
            f"REFUSED: {what} targets a LIVE puzzle ({reason}). Re-run with "
            "--allow-live and confirm interactively to override."
        )
    ans = input(
        f"\n*** You are about to MUTATE a LIVE puzzle ({reason}). ***\n"
        "Type exactly  MUTATE LIVE  to proceed (anything else aborts): "
    )
    if ans.strip() != "MUTATE LIVE":
        die("aborted — live-mutation confirmation not given.")


# ── Commands ────────────────────────────────────────────────────────────────
def cmd_list(args):
    api_key, game_id = resolve_config()
    levels = get_levels(api_key, game_id)
    local_index = build_local_index()
    print(f"{len(levels)} level(s) on game {game_id}\n")
    print(f"{'levelId':<22} {'publishDate':<12} {'live':<5} {'local':<6} answer")
    print("-" * 88)
    for lvl in sorted(levels, key=lambda x: x.get("publishDate") or "9999"):
        lid = lvl.get("levelId", "?")
        pub = lvl.get("publishDate") or "—"
        live = "LIVE" if is_live(lvl.get("publishDate")) else ""
        match = match_level_to_local(lvl, local_index)
        local_id = match[0].get("id", "?") if match else "—"
        answer = (
            match[0].get("relink", {}).get("answer")
            if match
            else reconstruct_answer(lvl.get("data", {}).get("relink", {}))
        )
        print(f"{lid:<22} {pub:<12} {live:<5} {local_id:<6} {answer}")


def cmd_pull(args):
    if getattr(args, "id", None):
        return cmd_pull_one(args)
    api_key, game_id = resolve_config()
    levels = get_levels(api_key, game_id)
    local_index = build_local_index()

    to_set, conflicts, unmatched, already = [], [], [], 0
    for lvl in levels:
        level_id = lvl.get("levelId")
        match = match_level_to_local(lvl, local_index)
        if not match:
            unmatched.append(lvl)
            continue
        puzzle, path = match
        existing = puzzle.get("canonicalId")
        if existing == level_id:
            already += 1
        elif existing:
            conflicts.append((puzzle.get("id"), existing, level_id))
        else:
            to_set.append((puzzle, path, level_id))

    print(f"Pull summary for game {game_id}:")
    print(f"  live levels:          {len(levels)}")
    print(f"  already linked:       {already}")
    print(f"  would backfill:       {len(to_set)}")
    print(f"  conflicts (skipped):  {len(conflicts)}")
    print(f"  unmatched live levels:{len(unmatched)}")

    for puzzle, _path, level_id in to_set:
        print(f"    + {puzzle.get('id'):<5} canonicalId -> {level_id}")
    for pid, existing, level_id in conflicts:
        print(f"    ! {pid:<5} local={existing}  live={level_id}  (left unchanged)")
    for lvl in unmatched:
        ans = reconstruct_answer(lvl.get("data", {}).get("relink", {}))
        print(f"    ? live {lvl.get('levelId')} ({lvl.get('publishDate') or '—'}) "
              f"no local match: {ans}")

    if not to_set:
        print("\nNothing to backfill.")
        return
    if not args.apply:
        print("\nDRY-RUN. Re-run with --apply to write canonicalId to local files.")
        return

    for puzzle, path, level_id in to_set:
        puzzle["canonicalId"] = level_id
        with open(path, "w") as fh:
            json.dump(puzzle, fh, indent=2, ensure_ascii=False)
        set_index_canonical(puzzle.get("id"), level_id)
        print(f"    wrote {os.path.basename(path)}")
    print(f"\nBackfilled {len(to_set)} canonicalId(s) into local files + index.")


def cmd_pull_one(args):
    """Content-sync a single local puzzle from its live level (live -> local),
    preserving PDL. Read-only against the live system; writes only local files."""
    api_key, game_id = resolve_config()
    puzzle, path, pid = load_local_puzzle(args.id)
    canonical = puzzle.get("canonicalId")
    newly_linked = False
    if not canonical:  # try a unique content match so we can still sync + link
        ws = local_wordset(puzzle)
        hits = [l for l in get_levels(api_key, game_id) if api_wordset(l) == ws]
        if len(hits) != 1:
            die(f"{pid} has no canonicalId and no unique content match on live — "
                "run `pull` (bulk) first, or check it exists live.")
        canonical = hits[0].get("levelId")
        newly_linked = True
        print(f"(matched {pid} -> live {canonical} by content)")

    status, body = api_request("GET", f"/games/{game_id}/levels/{canonical}", api_key)
    if status != 200 or not body.get("success", True):
        die(f"GET level {canonical} failed (HTTP {status}): {json.dumps(body)[:300]}")
    record = body.get("data") or {}
    live_data = record.get("data", {})
    live_pubdate = date_only(record.get("publishDate"))

    def snap(p):
        return json.dumps(
            {"rows": p.get("rows"), "relink": p.get("relink"), "date": p.get("date")},
            sort_keys=True, ensure_ascii=False,
        )

    before = snap(puzzle)
    target = puzzle if args.apply else copy.deepcopy(puzzle)
    changes = apply_live_to_local(target, live_data, live_pubdate)
    unchanged = snap(target) == before

    if unchanged and not newly_linked:
        print(f"{pid}: already congruent with live ({canonical}) — no changes.")
        return
    print(f"{pid}: live -> local sync ({canonical}):")
    for c in changes:
        print(f"    {c}")
    if unchanged:
        print("    (content identical; only the canonicalId link will be added)")
    if newly_linked:
        print(f"    + canonicalId -> {canonical}")

    if not args.apply:
        print("\nDRY-RUN. Re-run with --apply to write these changes to the local file.")
        return

    if newly_linked:
        puzzle["canonicalId"] = canonical
    with open(path, "w") as fh:
        json.dump(puzzle, fh, indent=2, ensure_ascii=False)
    set_index_entry(puzzle)
    print(f"\nWrote {os.path.basename(path)} and updated the index.")


def cmd_import(args):
    """Create NEW local puzzle files from live-only levels (live -> local), pulling
    full content + canonicalId. PDL is left empty for tagging in the CMS.

    Read-only against the live system: it only GETs levels and writes new local
    files + index entries, so it never touches a live puzzle.
    """
    api_key, game_id = resolve_config()
    levels = get_levels(api_key, game_id)
    by_id = {l.get("levelId"): l for l in levels}
    local_index = build_local_index()
    linked = {p.get("canonicalId") for p, _, _ in local_index if p.get("canonicalId")}

    wanted = list(args.level_ids or [])
    if args.all_new:
        for l in levels:
            lid = l.get("levelId")
            if lid in linked or match_level_to_local(l, local_index):
                continue
            if lid not in wanted:
                wanted.append(lid)
    if not wanted:
        die("nothing to import — pass one or more live levelIds, or --all-new.")

    plans, skipped = [], []
    next_n = next_local_id_num()
    for lid in wanted:
        lvl = by_id.get(lid)
        if not lvl:
            skipped.append((lid, "not found on live"))
            continue
        if lid in linked:
            skipped.append((lid, "already linked to a local puzzle"))
            continue
        match = match_level_to_local(lvl, local_index)
        if match:
            skipped.append((lid, f"content already exists locally as {match[0].get('id')}"))
            continue
        plans.append((f"l{next_n}", lvl))
        next_n += 1

    for lid, why in skipped:
        print(f"  - skip {lid}: {why}")
    if not plans:
        print("Nothing to import.")
        return

    print(f"Import {len(plans)} live level(s) as new local puzzle(s):")
    for pid, lvl in plans:
        data = lvl.get("data", {})
        name = data.get("name") or reconstruct_answer(data.get("relink", {}))
        print(f"    {pid}  <-  {lvl.get('levelId')}  {lvl.get('publishDate') or '—'}  {name!r}")

    if not args.apply:
        print("\nDRY-RUN. Re-run with --apply to create these local files + index entries.")
        return

    for pid, lvl in plans:
        data = lvl.get("data", {})
        pub_date = date_only(lvl.get("publishDate"))
        skel = make_local_skeleton(pid, pub_date)
        apply_live_to_local(skel, data, pub_date)
        if data.get("name"):
            skel["name"] = data["name"]
        skel["canonicalId"] = lvl.get("levelId")  # appended last, matching the CMS
        path, _ = puzzle_path(pid)
        with open(path, "w") as fh:
            json.dump(skel, fh, indent=2, ensure_ascii=False)
        insert_index_entry(skel)
        print(f"    wrote {os.path.basename(path)}  (canonicalId={skel['canonicalId']}, "
              f"date={skel['date']})")
    print(f"\nImported {len(plans)} new local puzzle(s) + index. Open them in the CMS to tag PDL.")


def cmd_sync(args):
    """Library-wide live -> local sync (read-only against live; writes only local
    files). Two parts, both preserving every bit of local-only data — all PDL,
    tile ids, decoys, impostorColumn, board, and the editorial name:

      1. CONTENT-SYNC every already-linked local puzzle down from its live level
         (rows / relink / date), so edits made in the live CMS land locally.
      2. IMPORT every live-only level (no local match yet) as a NEW local puzzle
         with empty PDL, ready to tag.

    Dry-run by default; --apply writes. Only ever GETs live levels and writes
    local files, so — like pull/import — it can never touch a live puzzle. The
    one bulk GET already carries each level's full data, so no per-puzzle calls.
    """
    api_key, game_id = resolve_config()
    levels = get_levels(api_key, game_id)
    by_id = {l.get("levelId"): l for l in levels}
    local_index = build_local_index()

    # 1. Content-sync every linked local puzzle from its live level.
    linked_updates = []   # (synced_puzzle, path, level_id, changes)
    linked_ok = 0
    linked_missing = []   # (pid, canonicalId) linked locally but absent from live
    for puzzle, path, _ws in local_index:
        canonical = puzzle.get("canonicalId")
        if not canonical:
            continue
        lvl = by_id.get(canonical)
        if not lvl:
            linked_missing.append((puzzle.get("id"), canonical))
            continue
        target = copy.deepcopy(puzzle)
        changes = apply_live_to_local(
            target, lvl.get("data", {}), date_only(lvl.get("publishDate"))
        )
        if changes:
            linked_updates.append((target, path, canonical, changes))
        else:
            linked_ok += 1

    # 2. Import live-only levels (no local match, not already linked) as new files.
    linked_ids = {p.get("canonicalId") for p, _, _ in local_index if p.get("canonicalId")}
    import_plans, next_n = [], next_local_id_num()
    for lvl in levels:
        lid = lvl.get("levelId")
        if lid in linked_ids or match_level_to_local(lvl, local_index):
            continue
        import_plans.append((f"l{next_n}", lvl))
        next_n += 1

    print(f"Sync summary for game {game_id}:")
    print(f"  live levels:            {len(levels)}")
    print(f"  linked & up to date:    {linked_ok}")
    print(f"  linked, would update:   {len(linked_updates)}")
    print(f"  new to import:          {len(import_plans)}")
    if linked_missing:
        print(f"  linked but gone live:   {len(linked_missing)} (left unchanged)")

    for target, _p, cid, changes in linked_updates:
        print(f"    ~ {target.get('id'):<5} <- {cid}")
        for c in changes:
            print(f"        {c}")
    for pid, lvl in import_plans:
        data = lvl.get("data", {})
        name = data.get("name") or reconstruct_answer(data.get("relink", {}))
        print(f"    + {pid:<5} <- {lvl.get('levelId')}  {lvl.get('publishDate') or '—'}  {name!r}")
    for pid, cid in linked_missing:
        print(f"    ! {pid:<5} canonicalId {cid} not found on live (left unchanged)")

    if not linked_updates and not import_plans:
        print("\nEverything is already in sync with live.")
        return
    if not args.apply:
        print("\nDRY-RUN. Re-run with --apply to write these changes to local files.")
        return

    for target, path, _cid, _changes in linked_updates:
        with open(path, "w") as fh:
            json.dump(target, fh, indent=2, ensure_ascii=False)
        set_index_entry(target)
        print(f"    updated {os.path.basename(path)}")
    for pid, lvl in import_plans:
        data = lvl.get("data", {})
        pub_date = date_only(lvl.get("publishDate"))
        skel = make_local_skeleton(pid, pub_date)
        apply_live_to_local(skel, data, pub_date)
        if data.get("name"):
            skel["name"] = data["name"]
        skel["canonicalId"] = lvl.get("levelId")  # appended last, matching the CMS
        path, _ = puzzle_path(pid)
        with open(path, "w") as fh:
            json.dump(skel, fh, indent=2, ensure_ascii=False)
        insert_index_entry(skel)
        print(f"    imported {os.path.basename(path)}  (canonicalId={skel['canonicalId']})")

    print(f"\nSynced: {len(linked_updates)} updated, {len(import_plans)} imported. "
          "Local PDL preserved throughout.")


def cmd_push(args):
    # game_id always resolves; the key is only required for a real network call.
    api_key, game_id = resolve_config(require_key=False)
    puzzle, path, pid = load_local_puzzle(args.id)

    if not writing_complete(puzzle):
        die(f"{pid} is not writing-complete (4 full rows, 1 impostor & a relink "
            "tile per row, non-empty answer). Refusing to push.")

    local_date = puzzle.get("date")
    existing_canonical = puzzle.get("canonicalId")

    # The public API is CREATE-only (POST) + READ (GET): no update, no working
    # delete. An existing level can only be edited/removed in the live CMS UI.
    # POST is date-unique, so re-pushing a DATED linked puzzle 409s; an UNDATED
    # one would create a duplicate. Hence --force is an explicit escape hatch only.
    if existing_canonical and not args.force:
        die(f"{pid} already has canonicalId={existing_canonical}. The public API "
            "cannot update or delete a level — edit it in the live CMS UI instead. "
            "(--force forces a raw re-POST: 409 on a taken date, or a DUPLICATE if undated.)")

    if args.apply and not api_key:
        die("--apply needs an API key. Set PUZZLR_API_KEY or create .puzzlr.local.")

    # Discover the live publishDate for an already-linked puzzle so the live guard
    # sees the server's truth as well as the local date. (Best-effort: needs a key.)
    live_date = None
    if existing_canonical and api_key:
        status, body = api_request(
            "GET", f"/games/{game_id}/levels/{existing_canonical}", api_key
        )
        if status == 200 and body.get("success", True):
            live_date = (body.get("data") or {}).get("publishDate")

    guard_not_live(local_date, live_date, args.allow_live, f"push {pid}")

    data = puzzle_to_api_data(puzzle)
    payload = {"gameName": game_id, "data": data}
    if local_date:
        payload["date"] = local_date

    print(f"Push payload for {pid}:")
    print(json.dumps(payload, indent=2, ensure_ascii=False))

    if not args.apply:
        print("\nDRY-RUN. Re-run with --apply to POST this to the live API.")
        return

    status, body = api_request("POST", "/games/levels", api_key, payload)
    if status is None:
        die(f"network error during push: {body.get('error')}")
    if status not in (200, 201) or not body.get("success", True):
        die(f"push failed (HTTP {status}): {json.dumps(body)[:400]}")

    level_id = _extract_level_id(body)
    print(f"\nPushed {pid} OK (HTTP {status}).")
    if not level_id:
        print("Could not read a levelId from the response — run `pull` to backfill.")
        print(json.dumps(body, indent=2)[:600])
        return

    puzzle["canonicalId"] = level_id
    with open(path, "w") as fh:
        json.dump(puzzle, fh, indent=2, ensure_ascii=False)
    set_index_canonical(pid, level_id)
    print(f"canonicalId={level_id} written to {os.path.basename(path)}; index updated.")


def _extract_level_id(body):
    data = body.get("data", body) if isinstance(body, dict) else {}
    if isinstance(data, dict):
        return data.get("levelId") or data.get("shortId") or data.get("id")
    return None


def cmd_diff(args):
    api_key, game_id = resolve_config()
    puzzle, _path, pid = load_local_puzzle(args.id)
    canonical = puzzle.get("canonicalId")
    if not canonical:
        die(f"{pid} has no canonicalId — nothing to diff. Run `pull` or `push` first.")
    status, body = api_request("GET", f"/games/{game_id}/levels/{canonical}", api_key)
    if status is None:
        die(f"network error: {body.get('error')}")
    if status != 200 or not body.get("success", True):
        die(f"GET level failed (HTTP {status}): {json.dumps(body)[:400]}")

    live = (body.get("data") or {}).get("data", {})
    local = puzzle_to_api_data(puzzle)
    local_json = json.dumps(local, indent=2, sort_keys=True, ensure_ascii=False)
    live_json = json.dumps(
        {"name": live.get("name", ""), "rows": live.get("rows"), "relink": live.get("relink")},
        indent=2, sort_keys=True, ensure_ascii=False,
    )
    if local_json == live_json:
        print(f"{pid}: local and live rows/relink are IDENTICAL.")
        return
    print(f"{pid}: DIFFERENCES (local left / live right) — full blobs:\n")
    print("── LOCAL (converted) ──")
    print(local_json)
    print("\n── LIVE ──")
    print(live_json)


# ── CLI ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Sync Relink levels with the live Puzzlr API.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="SAFETY: mutating a LIVE puzzle (date <= today) is refused in auto "
        "mode and requires --allow-live + interactive confirmation otherwise.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="list live levels (with matched local id)")

    p_pull = sub.add_parser(
        "pull",
        help="sync from live: backfill canonicalId (all), or content-sync one puzzle",
    )
    p_pull.add_argument("id", nargs="?",
                        help="optional puzzle id to content-sync from live (e.g. l19)")
    p_pull.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")

    p_push = sub.add_parser("push", help="upload a NEW local puzzle to the live API (create)")
    p_push.add_argument("id", help="local puzzle id, e.g. l20 or 20")
    p_push.add_argument("--apply", action="store_true", help="POST (default: dry-run)")
    p_push.add_argument("--force", action="store_true",
                        help="raw re-POST a linked puzzle (409s if dated/taken; dup if undated)")
    p_push.add_argument("--allow-live", action="store_true",
                        help="permit mutating a LIVE puzzle (interactive only)")

    p_diff = sub.add_parser("diff", help="diff a local puzzle against its live level")
    p_diff.add_argument("id", help="local puzzle id, e.g. l20 or 20")

    p_import = sub.add_parser(
        "import",
        help="create NEW local puzzles from live-only levels (live -> local)",
    )
    p_import.add_argument("level_ids", nargs="*", help="live levelId(s) to import")
    p_import.add_argument("--all-new", action="store_true",
                          help="import every live level with no local match")
    p_import.add_argument("--apply", action="store_true", help="write files (default: dry-run)")

    p_sync = sub.add_parser(
        "sync",
        help="library-wide live -> local: content-sync linked puzzles + import new ones",
    )
    p_sync.add_argument("--apply", action="store_true", help="write files (default: dry-run)")

    args = parser.parse_args()
    {
        "list": cmd_list,
        "pull": cmd_pull,
        "push": cmd_push,
        "diff": cmd_diff,
        "import": cmd_import,
        "sync": cmd_sync,
    }[args.command](args)


if __name__ == "__main__":
    main()
