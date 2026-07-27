// Persistence layer. The writer portal is backed by Supabase (via platform/db.js,
// the ONLY module that talks to the database). The File System Access helpers
// below are retained for the legacy local tooling but are no longer the writer's
// path — openPuzzle/savePuzzle/etc. now delegate to db.js.
import { getState, dispatch, isPuzzlePDLComplete, isPuzzleWritingComplete, computeBoardStats, migratePuzzle, normalizeDerivedData } from './state.js';
import { loadSchema } from './schema.js';
import { getDraft, saveDraft, createDraft, deleteDraft, getMyDrafts, submitPuzzle as dbSubmitPuzzle } from './platform/db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── IndexedDB for directory handle persistence ──
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('relink-cms', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDirectoryHandle(handle) {
  const db = await openDB();
  const tx = db.transaction('handles', 'readwrite');
  tx.objectStore('handles').put(handle, 'workingDirectory');
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadDirectoryHandle() {
  try {
    const db = await openDB();
    const tx = db.transaction('handles', 'readonly');
    const req = tx.objectStore('handles').get('workingDirectory');
    return new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

// ── File System Access API ──
export function isFileSystemAccessSupported() {
  return typeof window.showDirectoryPicker === 'function';
}

export async function pickDirectory() {
  return await window.showDirectoryPicker({ mode: 'readwrite' });
}

async function verifyPermission(handle) {
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

// ── HTTP fallback (reads from save-data/ served by the HTTP server) ──
const SAVE_DATA_PATH = 'save-data';

async function fetchJSON(path) {
  try {
    const res = await fetch(`${SAVE_DATA_PATH}/${path}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── Puzzle file read/write ──
export async function readPuzzleFile(dirHandle, id) {
  try {
    const fileHandle = await dirHandle.getFileHandle(`${id}.json`);
    const file = await fileHandle.getFile();
    const text = await file.text();
    return JSON.parse(text);
  } catch { return null; }
}

export async function writePuzzleFile(dirHandle, puzzle) {
  const fileHandle = await dirHandle.getFileHandle(`${puzzle.id}.json`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(puzzle, null, 2));
  await writable.close();
}

export async function deletePuzzleFile(dirHandle, id) {
  try {
    await dirHandle.removeEntry(`${id}.json`);
  } catch { /* file may not exist */ }
}

// ── Index management ──
function buildIndexEntry(puzzle) {
  return {
    id: puzzle.id,
    date: puzzle.date,
    name: puzzle.name,
    ...(puzzle.canonicalId ? { canonicalId: puzzle.canonicalId } : {}),
    phase2TileCount: puzzle.relink.tiles.filter(t => t.source === 'grid').length,
    writingComplete: isPuzzleWritingComplete(puzzle),
    pdlComplete: isPuzzlePDLComplete(puzzle),
    searchFields: {
      tiles: (puzzle.rows || []).flatMap(r => (r.tiles || []).map(t => t.text || '')).join(' '),
      categories: (puzzle.rows || []).map(r => r.category || '').join(' '),
      answer: puzzle.relink?.answer || '',
      decoyDescriptions: (puzzle.decoys || []).map(d => d.pdl?.description || '').join(' '),
    },
  };
}

async function readPuzzleIndex(dirHandle) {
  try {
    const fh = await dirHandle.getFileHandle('puzzles-index.json');
    const file = await fh.getFile();
    return JSON.parse(await file.text());
  } catch { return { puzzles: [] }; }
}

async function writePuzzleIndex(dirHandle, index) {
  const fh = await dirHandle.getFileHandle('puzzles-index.json', { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(index, null, 2));
  await w.close();
}

// ── Row Bank persistence (save-data/row-bank.json) ──
const ROW_BANK_FILENAME = 'row-bank.json';

export async function loadRowBank() {
  const { dirHandle } = getState();
  let data = null;
  if (dirHandle) {
    try {
      const fh = await dirHandle.getFileHandle(ROW_BANK_FILENAME);
      const file = await fh.getFile();
      data = JSON.parse(await file.text());
    } catch { data = null; }
  } else {
    data = await fetchJSON(ROW_BANK_FILENAME);
  }
  if (data && Array.isArray(data.rows)) {
    dispatch({ type: 'SET_ROW_BANK', rowBank: data });
  }
}

export async function saveRowBank(rowBank) {
  const { dirHandle } = getState();
  if (!dirHandle) return; // read-only HTTP mode — bank stays in memory only
  const fh = await dirHandle.getFileHandle(ROW_BANK_FILENAME, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(rowBank ?? getState().rowBank, null, 2));
  await w.close();
}

export async function updateIndex(dirHandle, puzzle) {
  const index = await readPuzzleIndex(dirHandle);
  const entry = buildIndexEntry(puzzle);
  const idx = index.puzzles.findIndex(p => p.id === entry.id);
  if (idx >= 0) index.puzzles[idx] = entry;
  else index.puzzles.push(entry);
  index.puzzles.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  await writePuzzleIndex(dirHandle, index);
  return index;
}

export async function removeFromIndex(dirHandle, id) {
  const index = await readPuzzleIndex(dirHandle);
  index.puzzles = index.puzzles.filter(p => p.id !== id);
  await writePuzzleIndex(dirHandle, index);
  return index;
}

// Non-puzzle JSON files that live alongside the puzzles in save-data/.
const NON_PUZZLE_FILES = new Set(['puzzles-index.json', 'pdl-schema.json', 'row-bank.json']);

export async function rebuildIndex(dirHandle) {
  const index = { puzzles: [] };
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.endsWith('.json') && !NON_PUZZLE_FILES.has(name) && handle.kind === 'file') {
      try {
        const file = await handle.getFile();
        const puzzle = JSON.parse(await file.text());
        // Include every valid puzzle. migratePuzzle is a no-op for the current
        // schema, so this also covers v4+ — the previous `<= 3` cap silently
        // dropped all current puzzles from the rebuilt index.
        if (puzzle.schemaVersion >= 1) {
          migratePuzzle(puzzle);
          // Ensure puzzle has an id (migrate old date-based files)
          if (!puzzle.id) puzzle.id = name.replace('.json', '');
          // Backfill auto-derived data (relink answer + board stats); persist if changed
          if (normalizeDerivedData(puzzle)) {
            await writePuzzleFile(dirHandle, puzzle);
          }
          index.puzzles.push(buildIndexEntry(puzzle));
        }
      } catch { /* skip bad files */ }
    }
  }
  index.puzzles.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  await writePuzzleIndex(dirHandle, index);
  return index;
}

// ── High-level operations ──
export async function connectDirectory() {
  const handle = await pickDirectory();
  if (!await verifyPermission(handle)) throw new Error('Permission denied');
  await saveDirectoryHandle(handle);
  dispatch({ type: 'SET_DIR_HANDLE', handle });
  await loadSchema(handle);
  const index = await rebuildIndex(handle);
  dispatch({ type: 'SET_INDEX', index });
  await loadRowBank();
}

export async function restoreDirectory() {
  // The writer portal loads the signed-in writer's drafts from the database
  // instead of a local folder.
  await loadMyDrafts();
  return true;
}

export async function openPuzzle(id) {
  // Returns the editor-shaped puzzle for the composer (throws on failure).
  return await getDraft(id);
}

// Load the signed-in writer's drafts into the store as the list the sidebar
// renders. Each entry carries the state so the list can show it and gate editing.
export async function loadMyDrafts() {
  const drafts = await getMyDrafts();
  const puzzles = drafts.map(d => ({
    id: d.id,
    name: d.title || '',
    date: d.publish_date || '',
    state: d.state,
  }));
  dispatch({ type: 'SET_INDEX', index: { puzzles } });
  return { puzzles };
}

export async function savePuzzle(puzzle, opts = {}) {
  // New puzzles created in-memory get a database row on first save; existing ones
  // update in place. Keeps a draft a draft (state is unchanged by a save).
  let id = puzzle.serverId || puzzle.id;
  if (!UUID_RE.test(id || '')) {
    const created = await createDraft();
    id = created.id;
    puzzle.id = id;
    puzzle.serverId = id;
    puzzle.state = created.state;
  }
  await saveDraft(id, puzzle, opts);
  await loadMyDrafts();
  dispatch({ type: 'MARK_SAVED' });
}

// Submit the current puzzle for review (draft/changes_requested -> submitted).
// The DB trigger validates the transition; RLS enforces ownership.
export async function submitPuzzle(id) {
  const res = await dbSubmitPuzzle(id);
  await loadMyDrafts();
  return res;
}

export async function deletePuzzle(id) {
  try {
    await deleteDraft(id);
    if (getState().puzzle?.id === id) dispatch({ type: 'CLEAR_PUZZLE' });
  } finally {
    // Always resync the list to the true DB state — so a genuinely deleted
    // puzzle disappears, and a stale card (already gone, or state advanced)
    // corrects itself even when the delete is refused.
    await loadMyDrafts();
  }
}

export async function refreshIndex() {
  await loadMyDrafts();
}

// Re-read the writer's drafts into the store.
export async function reloadIndex() {
  return await loadMyDrafts();
}

// ── Live Puzzlr sync (via the server.py proxy) ──────────────────────────────
// These POST to local server endpoints that shell out to tools/puzzlr_api.py.
// The Puzzlr API key stays server-side (.puzzlr.local) — never in the browser.
// The CLI writes the puzzle file + index directly; callers reload afterwards.
async function callSync(endpoint, id, apply) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, apply: !!apply }),
    });
  } catch (err) {
    throw new Error(`Could not reach the local server (${endpoint}). Is it running? ${err.message}`);
  }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok && !data.error && !data.stderr) {
    throw new Error(`Sync failed (HTTP ${res.status}).`);
  }
  return data; // { ok, code, stdout, stderr } or { ok:false, error }
}

export function pushToLive(id, { apply = true } = {}) {
  return callSync('/api/push', id, apply);
}

export function pullFromLive(id, { apply = false } = {}) {
  return callSync('/api/pull', id, apply);
}

// Library-wide live -> local sync. Content-syncs every already-linked puzzle
// from its live level (preserving local PDL) AND imports every live-only level
// (no local match) as a new local puzzle. No puzzle id. Dry-run unless apply is
// true. The CLI writes the files + index server-side; callers reload afterwards.
export async function syncFromLive({ apply = false } = {}) {
  let res;
  try {
    res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apply: !!apply }),
    });
  } catch (err) {
    throw new Error(`Could not reach the local server (/api/sync). Is it running? ${err.message}`);
  }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok && !data.error && !data.stderr) {
    throw new Error(`Sync failed (HTTP ${res.status}).`);
  }
  return data; // { ok, code, stdout, stderr } or { ok:false, error }
}


export async function importPuzzles(puzzles) {
  const { dirHandle } = getState();
  if (!dirHandle) throw new Error('No folder connected. Please connect a folder first.');
  for (const p of puzzles) {
    await writePuzzleFile(dirHandle, p);
    await updateIndex(dirHandle, p);
  }
  const index = await readPuzzleIndex(dirHandle);
  dispatch({ type: 'SET_INDEX', index });
  return puzzles.length;
}

// ── Download/Upload fallbacks ──
export function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function uploadJSON() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = async () => {
      try {
        const file = input.files[0];
        if (!file) return reject(new Error('No file selected'));
        const text = await file.text();
        resolve(JSON.parse(text));
      } catch (e) { reject(e); }
    };
    input.click();
  });
}
