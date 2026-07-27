// State management — simple observable store

let _idCounter = 0;
function uid(prefix) {
  return `${prefix}-${Date.now()}-${++_idCounter}`;
}

export function generatePuzzleId() {
  const puzzles = _state.puzzleIndex?.puzzles || [];
  let max = 0;
  for (const p of puzzles) {
    const m = p.id && p.id.match(/^l(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  // Also check the currently loaded puzzle (may not be in the index yet)
  if (_state.puzzle?.id) {
    const m = _state.puzzle.id.match(/^l(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `l${max + 1}`;
}

export const generateTileId = () => uid('tile');
export const generateRowId = () => uid('row');
export const generateDecoyId = () => uid('decoy');

function emptyGroupPDL() {
  return { knowledge: null, manipulation: null, abstraction: null, knowledgeDomain: null, nicheKnowledge: null };
}
function emptyImpostorColumnPDL() {
  return { knowledge: null, manipulation: null, abstraction: null, knowledgeDomain: null, nicheKnowledge: null };
}
function emptyAnswerConstructionPDL() {
  return { manipulation: null, knowledge: null };
}
function emptyBoardPDL() {
  return { specialistGroupCount: 0, decoyCount: 0, phase2TileCount: 0, isThemed: false, themeDomain: null };
}

export function createEmptyRow(position) {
  return {
    id: generateRowId(),
    position,
    category: '',
    tiles: [
      { id: generateTileId(), text: '', isImpostor: false, isRelink: false },
      { id: generateTileId(), text: '', isImpostor: false, isRelink: false },
      { id: generateTileId(), text: '', isImpostor: false, isRelink: false },
      { id: generateTileId(), text: '', isImpostor: false, isRelink: false },
    ],
    pdl: { group: emptyGroupPDL() },
  };
}

export function createNewPuzzle(date) {
  return {
    schemaVersion: 5,
    id: generatePuzzleId(),
    date: date || '',
    name: '',
    rows: [createEmptyRow(0), createEmptyRow(1), createEmptyRow(2), createEmptyRow(3)],
    relink: { tiles: [], answer: '', pdl: { answerConstruction: emptyAnswerConstructionPDL() } },
    impostorColumn: { pdl: emptyImpostorColumnPDL() },
    decoys: [],
    board: emptyBoardPDL(),
  };
}

// ── Row Bank helpers ──
function emptyTile() {
  return { id: generateTileId(), text: '', isImpostor: false, isRelink: false };
}

// A blank row authored directly in the bank.
export function createEmptyBankRow() {
  return {
    id: generateRowId(),
    category: '',
    tiles: [emptyTile(), emptyTile(), emptyTile(), emptyTile()],
    pdl: { group: emptyGroupPDL() },
    bankedFrom: null,
    bankedAt: new Date().toISOString(),
    note: '',
  };
}

// Snapshot a live puzzle row into an independent bank entry (fresh ids).
function toBankedRow(row, puzzle) {
  return {
    id: generateRowId(),
    category: row.category || '',
    tiles: (row.tiles || []).map(t => ({
      id: generateTileId(), text: t.text || '',
      isImpostor: !!t.isImpostor, isRelink: !!t.isRelink,
    })),
    pdl: { group: row.pdl?.group ? JSON.parse(JSON.stringify(row.pdl.group)) : emptyGroupPDL() },
    bankedFrom: puzzle ? { puzzleId: puzzle.id, name: puzzle.name || '' } : null,
    bankedAt: new Date().toISOString(),
    note: '',
  };
}

// Build a live puzzle row from a bank entry (fresh ids, padded to 4 tiles).
function fromBankedRow(banked, position) {
  const tiles = (banked.tiles || []).slice(0, 4).map(t => ({
    id: generateTileId(), text: t.text || '',
    isImpostor: !!t.isImpostor, isRelink: !!t.isRelink,
  }));
  while (tiles.length < 4) tiles.push(emptyTile());
  return {
    id: generateRowId(),
    position,
    category: banked.category || '',
    tiles,
    pdl: { group: banked.pdl?.group ? JSON.parse(JSON.stringify(banked.pdl.group)) : emptyGroupPDL() },
  };
}

// True when a row holds any author content (used to gate banking / displacement prompts).
export function rowHasContent(row) {
  if (!row) return false;
  if (row.category && row.category.trim()) return true;
  return (row.tiles || []).some(t => t.text && t.text.trim());
}

// ── Reactive store ──
const _listeners = new Set();

const _state = {
  puzzle: null,          // current puzzle being edited (or null)
  selection: { type: 'none' },
  isDirty: false,
  dirHandle: null,       // FileSystemDirectoryHandle
  puzzleIndex: { puzzles: [] },
  isConnected: false,
  rowBank: { rows: [] }, // orphaned rows saved for reuse across puzzles
};

// ── Undo / Redo history ──
const MAX_HISTORY = 50;
let _undoStack = [];   // snapshots before each mutation
let _redoStack = [];
// Actions that don't mutate puzzle or bank state — skip history for these
const _nonMutating = new Set(['SET_SELECTION', 'TOGGLE_TILE_SELECTION', 'CLEAR_SELECTION',
  'SET_DIR_HANDLE', 'SET_INDEX', 'MARK_SAVED', 'SET_ROW_BANK']);
// Bank-affecting actions record history even when no puzzle is loaded.
const _bankMutating = new Set(['BANK_ROW', 'IMPORT_ROW', 'ADD_BANK_ROW', 'UPDATE_BANK_ROW_CATEGORY',
  'UPDATE_BANK_ROW_TILE_TEXT', 'TOGGLE_BANK_ROW_IMPOSTOR', 'DELETE_BANK_ROW']);

// Snapshots capture both the puzzle and the row bank so a single undo reverses
// a coupled move (e.g. banking a row removes it from the puzzle AND adds it to the bank).
function _snapshot() {
  return JSON.stringify({ puzzle: _state.puzzle, rowBank: _state.rowBank });
}

function _restore(json) {
  const snap = JSON.parse(json);
  _state.puzzle = snap.puzzle ?? null;
  _state.rowBank = snap.rowBank ?? { rows: [] };
  _state.selection = { type: 'none' };
  if (_state.puzzle) _state.isDirty = true;
}

export function canUndo() { return _undoStack.length > 0; }
export function canRedo() { return _redoStack.length > 0; }

export function undo() {
  if (!_undoStack.length) return;
  _redoStack.push(_snapshot());
  _restore(_undoStack.pop());
  notify();
}

export function redo() {
  if (!_redoStack.length) return;
  _undoStack.push(_snapshot());
  _restore(_redoStack.pop());
  notify();
}

export function getState() { return _state; }

export function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function notify() {
  for (const fn of _listeners) fn(_state);
}

export function dispatch(action) {
  // Push undo snapshot before mutating actions. Puzzle edits record when a puzzle
  // is loaded; row-bank edits always record (they can happen with no puzzle open).
  const recordable = !_nonMutating.has(action.type) && action.type !== 'SET_PUZZLE' && action.type !== 'CLEAR_PUZZLE';
  if (recordable && (_state.puzzle || _bankMutating.has(action.type))) {
    _undoStack.push(_snapshot());
    if (_undoStack.length > MAX_HISTORY) _undoStack.shift();
    _redoStack.length = 0; // new edit clears redo
  }
  // Reset history when switching puzzles
  if (action.type === 'SET_PUZZLE' || action.type === 'CLEAR_PUZZLE') {
    _undoStack = [];
    _redoStack = [];
  }
  switch (action.type) {
    case 'SET_PUZZLE':
      _state.puzzle = action.puzzle;
      _state.isDirty = false;
      _state.selection = { type: 'none' };
      syncRelinkAnswer(); // derive answer from loaded tiles without dirtying
      break;
    case 'CLEAR_PUZZLE':
      _state.puzzle = null;
      _state.isDirty = false;
      _state.selection = { type: 'none' };
      break;
    case 'SET_DATE':
      if (_state.puzzle) { _state.puzzle.date = action.date; _state.isDirty = true; }
      break;
    case 'SET_NAME':
      if (_state.puzzle) { _state.puzzle.name = action.name; _state.isDirty = true; }
      break;
    case 'SET_CANONICAL_ID':
      if (_state.puzzle) { _state.puzzle.canonicalId = action.canonicalId || null; _state.isDirty = true; }
      break;
    case 'UPDATE_CATEGORY': {
      const row = _state.puzzle?.rows.find(r => r.id === action.rowId);
      if (row) { row.category = action.category; _state.isDirty = true; }
      break;
    }
    case 'UPDATE_TILE_TEXT': {
      const row = _state.puzzle?.rows.find(r => r.id === action.rowId);
      if (row) {
        const tile = row.tiles.find(t => t.id === action.tileId);
        if (tile) { tile.text = action.text; rebuildRelinkTiles(); _state.isDirty = true; }
      }
      break;
    }
    case 'TOGGLE_IMPOSTOR': {
      const row = _state.puzzle?.rows.find(r => r.id === action.rowId);
      if (row) {
        const tile = row.tiles.find(t => t.id === action.tileId);
        if (tile) {
          const wasImpostor = tile.isImpostor;
          row.tiles.forEach(t => t.isImpostor = false);
          tile.isImpostor = !wasImpostor;
          if (tile.isImpostor && tile.isRelink) { tile.isRelink = false; rebuildRelinkTiles(); }
          _state.isDirty = true;
        }
      }
      break;
    }
    case 'TOGGLE_RELINK': {
      const row = _state.puzzle?.rows.find(r => r.id === action.rowId);
      if (row) {
        const tile = row.tiles.find(t => t.id === action.tileId);
        if (tile) {
          tile.isRelink = !tile.isRelink;
          if (tile.isRelink && tile.isImpostor) { tile.isImpostor = false; }
          rebuildRelinkTiles();
          _state.isDirty = true;
        }
      }
      break;
    }
    case 'REORDER_ROWS': {
      if (_state.puzzle) {
        const rows = _state.puzzle.rows;
        const [moved] = rows.splice(action.fromIndex, 1);
        rows.splice(action.toIndex, 0, moved);
        rows.forEach((r, i) => r.position = i);
        _state.isDirty = true;
      }
      break;
    }
    case 'ADD_FODDER_TILE':
      if (_state.puzzle) {
        _state.puzzle.relink.tiles.push({ text: action.text ?? '', source: 'fodder' });
        syncRelinkAnswer();
        _state.isDirty = true;
      }
      break;
    case 'UPDATE_FODDER_TEXT':
      if (_state.puzzle) {
        const ft = _state.puzzle.relink.tiles[action.index];
        if (ft && ft.source === 'fodder') { ft.text = action.text; syncRelinkAnswer(); _state.isDirty = true; }
      }
      break;
    case 'REMOVE_RELINK_TILE':
      if (_state.puzzle) {
        const removed = _state.puzzle.relink.tiles[action.index];
        if (removed && removed.source === 'grid') {
          // Unmark the grid tile so it no longer feeds into relink
          for (const row of _state.puzzle.rows) {
            if (row.id !== removed.sourceRowId) continue;
            const gridTile = removed.sourceTileId
              ? row.tiles.find(t => t.id === removed.sourceTileId)
              : row.tiles.find(t => t.text === removed.text && t.isRelink);
            if (gridTile) { gridTile.isRelink = false; break; }
          }
        }
        _state.puzzle.relink.tiles.splice(action.index, 1);
        syncRelinkAnswer();
        _state.isDirty = true;
      }
      break;
    case 'REORDER_RELINK_TILES': {
      if (_state.puzzle) {
        const tiles = _state.puzzle.relink.tiles;
        const [moved] = tiles.splice(action.fromIndex, 1);
        tiles.splice(action.toIndex, 0, moved);
        syncRelinkAnswer();
        _state.isDirty = true;
      }
      break;
    }
    case 'TOGGLE_RELINK_JOIN': {
      // Smoosh adjacent relink tiles into a compound (no gap before the next tile).
      // joinNext lives on the tile at `index`; the last tile can never join.
      if (_state.puzzle) {
        const tiles = _state.puzzle.relink.tiles;
        const tile = tiles[action.index];
        if (tile && action.index < tiles.length - 1) {
          if (tile.joinNext) delete tile.joinNext;
          else tile.joinNext = true;
          _state.isDirty = true;
        }
      }
      break;
    }
    case 'ADD_DECOY':
      if (_state.puzzle) {
        _state.puzzle.decoys.push({
          id: generateDecoyId(),
          tileIds: [],
          pdl: { knowledge: null, manipulation: null, abstraction: null, completeness: null, groupsSpanned: '', description: '' },
        });
        _state.isDirty = true;
      }
      break;
    case 'ADD_DECOY_FROM_TILES':
      if (_state.puzzle && action.tileIds?.length) {
        _state.puzzle.decoys.push({
          id: generateDecoyId(),
          tileIds: [...action.tileIds],
          pdl: { knowledge: null, manipulation: null, abstraction: null, completeness: null, groupsSpanned: '', description: '' },
        });
        _state.selection = { type: 'none' };
        _state.isDirty = true;
      }
      break;
    case 'REMOVE_DECOY':
      if (_state.puzzle) {
        _state.puzzle.decoys = _state.puzzle.decoys.filter(d => d.id !== action.decoyId);
        if (_state.selection.type === 'decoy' && _state.selection.decoyId === action.decoyId) {
          _state.selection = { type: 'none' };
        }
        _state.isDirty = true;
      }
      break;
    case 'UPDATE_DECOY_PDL': {
      const decoy = _state.puzzle?.decoys.find(d => d.id === action.decoyId);
      if (decoy) { Object.assign(decoy.pdl, action.pdl); _state.isDirty = true; }
      break;
    }
    case 'UPDATE_DECOY_TILES': {
      const decoy = _state.puzzle?.decoys.find(d => d.id === action.decoyId);
      if (decoy) { decoy.tileIds = action.tileIds; _state.isDirty = true; }
      break;
    }
    case 'UPDATE_GROUP_PDL': {
      const row = _state.puzzle?.rows.find(r => r.id === action.rowId);
      if (row) { Object.assign(row.pdl.group, action.pdl); _state.isDirty = true; }
      break;
    }
    case 'UPDATE_IMPOSTOR_COLUMN_PDL':
      if (_state.puzzle) { Object.assign(_state.puzzle.impostorColumn.pdl, action.pdl); _state.isDirty = true; }
      break;
    case 'UPDATE_ANSWER_CONST_PDL':
      if (_state.puzzle) { Object.assign(_state.puzzle.relink.pdl.answerConstruction, action.pdl); _state.isDirty = true; }
      break;
    case 'UPDATE_BOARD_PDL':
      if (_state.puzzle) { Object.assign(_state.puzzle.board, action.pdl); _state.isDirty = true; }
      break;
    case 'SET_SELECTION':
      _state.selection = action.selection;
      break;
    case 'TOGGLE_TILE_SELECTION': {
      const sel = _state.selection;
      if (sel.type === 'tiles' && sel.tileIds) {
        const idx = sel.tileIds.indexOf(action.tileId);
        if (idx >= 0) {
          sel.tileIds.splice(idx, 1);
          if (sel.tileIds.length === 0) _state.selection = { type: 'none' };
        } else {
          sel.tileIds.push(action.tileId);
        }
      } else {
        _state.selection = { type: 'tiles', tileIds: [action.tileId] };
      }
      break;
    }
    case 'CLEAR_SELECTION':
      _state.selection = { type: 'none' };
      break;
    case 'SET_DIR_HANDLE':
      _state.dirHandle = action.handle;
      _state.isConnected = !!action.handle;
      break;
    case 'SET_INDEX':
      _state.puzzleIndex = action.index;
      break;
    case 'MARK_SAVED':
      _state.isDirty = false;
      break;
    case 'SET_ROW_BANK':
      _state.rowBank = action.rowBank && Array.isArray(action.rowBank.rows) ? action.rowBank : { rows: [] };
      break;
    case 'BANK_ROW': {
      if (!_state.puzzle) break;
      const idx = _state.puzzle.rows.findIndex(r => r.id === action.rowId);
      if (idx < 0) break;
      const row = _state.puzzle.rows[idx];
      // Save a copy into the bank (newest first)
      _state.rowBank.rows.unshift(toBankedRow(row, _state.puzzle));
      // Strip this row's tiles from any decoys; drop decoys left empty
      const removed = new Set(row.tiles.map(t => t.id));
      for (const d of _state.puzzle.decoys) d.tileIds = d.tileIds.filter(id => !removed.has(id));
      _state.puzzle.decoys = _state.puzzle.decoys.filter(d => d.tileIds.length > 0);
      // Replace with a fresh empty row so the puzzle keeps its 4 rows
      _state.puzzle.rows[idx] = createEmptyRow(idx);
      rebuildRelinkTiles();               // drops the old row's stale relink entries
      normalizeDerivedData(_state.puzzle); // refresh answer + board stats
      _state.selection = { type: 'none' };
      _state.isDirty = true;
      break;
    }
    case 'IMPORT_ROW': {
      if (!_state.puzzle) break;
      const targetIdx = _state.puzzle.rows.findIndex(r => r.id === action.targetRowId);
      const bankIdx = _state.rowBank.rows.findIndex(b => b.id === action.bankRowId);
      if (targetIdx < 0 || bankIdx < 0) break;
      const banked = _state.rowBank.rows[bankIdx];
      const oldRow = _state.puzzle.rows[targetIdx];
      // Decide what happens to the row being displaced
      if (rowHasContent(oldRow) && action.displaced === 'bank') {
        _state.rowBank.rows.unshift(toBankedRow(oldRow, _state.puzzle));
      }
      // Strip the displaced row's tiles from decoys; drop empties
      const removed = new Set(oldRow.tiles.map(t => t.id));
      for (const d of _state.puzzle.decoys) d.tileIds = d.tileIds.filter(id => !removed.has(id));
      _state.puzzle.decoys = _state.puzzle.decoys.filter(d => d.tileIds.length > 0);
      // Place the imported row (fresh ids) and consume it from the bank
      _state.puzzle.rows[targetIdx] = fromBankedRow(banked, targetIdx);
      // Re-find by id: unshifting the displaced row above would have shifted indices.
      const consumeIdx = _state.rowBank.rows.findIndex(b => b.id === action.bankRowId);
      if (consumeIdx >= 0) _state.rowBank.rows.splice(consumeIdx, 1);
      rebuildRelinkTiles();               // re-adds imported relink tiles, drops stale
      normalizeDerivedData(_state.puzzle);
      _state.selection = { type: 'none' };
      _state.isDirty = true;
      break;
    }
    case 'ADD_BANK_ROW':
      _state.rowBank.rows.unshift(createEmptyBankRow());
      break;
    case 'UPDATE_BANK_ROW_CATEGORY': {
      const r = _state.rowBank.rows.find(b => b.id === action.bankRowId);
      if (r) r.category = action.category;
      break;
    }
    case 'UPDATE_BANK_ROW_TILE_TEXT': {
      const r = _state.rowBank.rows.find(b => b.id === action.bankRowId);
      const tile = r?.tiles.find(t => t.id === action.tileId);
      if (tile) tile.text = action.text;
      break;
    }
    case 'TOGGLE_BANK_ROW_IMPOSTOR': {
      const r = _state.rowBank.rows.find(b => b.id === action.bankRowId);
      const tile = r?.tiles.find(t => t.id === action.tileId);
      if (tile) {
        const was = tile.isImpostor;
        r.tiles.forEach(t => t.isImpostor = false);
        tile.isImpostor = !was;
      }
      break;
    }
    case 'DELETE_BANK_ROW': {
      const i = _state.rowBank.rows.findIndex(b => b.id === action.bankRowId);
      if (i >= 0) _state.rowBank.rows.splice(i, 1);
      break;
    }
    default:
      console.warn('Unknown action:', action.type);
  }
  notify();
}

// Rebuild relink tiles from grid when tiles are toggled.
// Preserves custom chip ordering — only adds/removes/updates as needed.
function rebuildRelinkTiles() {
  if (!_state.puzzle) return;
  const existing = _state.puzzle.relink.tiles;

  // Build set of grid tile IDs that should be in the relink list
  const wantedGridTiles = new Map(); // tileId → { text, sourceRowId }
  for (const row of _state.puzzle.rows) {
    for (const tile of row.tiles) {
      if (tile.isRelink) {
        wantedGridTiles.set(tile.id, { text: tile.text, sourceRowId: row.id });
      }
    }
  }

  // Update existing grid entries in-place (text sync) and remove stale ones
  const kept = [];
  for (const entry of existing) {
    if (entry.source === 'fodder') {
      kept.push(entry);
    } else if (entry.sourceTileId && wantedGridTiles.has(entry.sourceTileId)) {
      // Matched by tile ID — update text in place
      const info = wantedGridTiles.get(entry.sourceTileId);
      entry.text = info.text;
      entry.sourceRowId = info.sourceRowId;
      kept.push(entry);
      wantedGridTiles.delete(entry.sourceTileId);
    } else if (!entry.sourceTileId) {
      // Legacy entry without sourceTileId — match by sourceRowId
      let matched = false;
      for (const [tileId, info] of wantedGridTiles) {
        if (info.sourceRowId === entry.sourceRowId) {
          entry.text = info.text;
          entry.sourceTileId = tileId;
          kept.push(entry);
          wantedGridTiles.delete(tileId);
          matched = true;
          break;
        }
      }
      // If no match, the tile was unmarked — drop the entry
    }
    // else: stale grid entry (tile no longer marked relink) — drop it
  }

  // Append any newly-toggled grid tiles at the end
  for (const [tileId, info] of wantedGridTiles) {
    kept.push({ text: info.text, source: 'grid', sourceRowId: info.sourceRowId, sourceTileId: tileId });
  }

  _state.puzzle.relink.tiles = kept;
  syncRelinkAnswer();
}

// Derive relink.answer from the ordered relink tiles + fodder (exact display order)
export function deriveRelinkAnswer(puzzle) {
  if (!puzzle?.relink?.tiles) return '';
  return puzzle.relink.tiles
    .map(t => (t.text || '').trim())
    .filter(Boolean)
    .join(' ');
}

function syncRelinkAnswer() {
  if (!_state.puzzle) return;
  _state.puzzle.relink.answer = deriveRelinkAnswer(_state.puzzle);
}

// Backfill all auto-derived fields onto a puzzle object: the relink answer and
// the computed board stats. Returns true if any stored value changed (so callers
// can decide whether to persist the file). Does NOT touch manual fields.
export function normalizeDerivedData(puzzle) {
  if (!puzzle) return false;
  let changed = false;

  const answer = deriveRelinkAnswer(puzzle);
  if ((puzzle.relink?.answer || '') !== answer) {
    if (puzzle.relink) puzzle.relink.answer = answer;
    changed = true;
  }

  const stats = computeBoardStats(puzzle);
  puzzle.board = puzzle.board || {};
  for (const key of ['specialistGroupCount', 'decoyCount', 'phase2TileCount']) {
    if (puzzle.board[key] !== stats[key]) { puzzle.board[key] = stats[key]; changed = true; }
  }

  return changed;
}

// ── Validation helpers ──
// nicheKnowledge is intentionally skip-keyed: it is an optional obscurity axis
// layered on after the corpus was already tagged, so it must NOT flip the 81
// existing puzzles to 'partial' for a blank value. (It still saves and feeds
// analytics when set.)
const PDL_SKIP_KEYS = new Set(['completeness', 'groupsSpanned', 'description', 'nicheKnowledge']);
function pdlFieldCount(obj) {
  return Object.entries(obj).filter(([k, v]) => {
    if (PDL_SKIP_KEYS.has(k)) return false;
    if (v === null || v === '' || v === undefined) return false;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  }).length;
}

function pdlFieldTotal(obj) {
  return Object.keys(obj).filter(k => !k.endsWith('Other') && !PDL_SKIP_KEYS.has(k)).length;
}

export function getGroupPDLStatus(pdl) {
  const filled = pdlFieldCount(pdl);
  if (filled === 0) return 'empty';
  const total = pdlFieldTotal(pdl);
  return filled >= total ? 'complete' : 'partial';
}

export function getRowPDLStatus(row) {
  return getGroupPDLStatus(row.pdl.group);
}

export function getImpostorColumnPDLStatus(pdl) {
  const filled = pdlFieldCount(pdl);
  if (filled === 0) return 'empty';
  const total = pdlFieldTotal(pdl);
  return filled >= total ? 'complete' : 'partial';
}

export function getAnswerConstPDLStatus(pdl) {
  const filled = pdlFieldCount(pdl);
  if (filled === 0) return 'empty';
  const total = pdlFieldTotal(pdl);
  return filled >= total ? 'complete' : 'partial';
}

export function computeBoardStats(puzzle) {
  if (!puzzle) return { specialistGroupCount: 0, decoyCount: 0, phase2TileCount: 0 };
  const specialistGroupCount = puzzle.rows.filter(r => {
    const k = r.pdl.group.knowledge;
    return Array.isArray(k) ? k.includes('Specialist cultural') : k === 'Specialist cultural';
  }).length;
  const decoyCount = puzzle.decoys.length;
  const phase2TileCount = puzzle.relink.tiles.filter(t => t.source === 'grid').length;
  return { specialistGroupCount, decoyCount, phase2TileCount };
}

export function isPuzzlePDLComplete(puzzle) {
  if (!puzzle) return false;
  for (const row of puzzle.rows) {
    if (getRowPDLStatus(row) !== 'complete') return false;
  }
  if (getImpostorColumnPDLStatus(puzzle.impostorColumn.pdl) !== 'complete') return false;
  if (getAnswerConstPDLStatus(puzzle.relink.pdl.answerConstruction) !== 'complete') return false;
  for (const decoy of puzzle.decoys) {
    const filled = pdlFieldCount(decoy.pdl);
    if (filled < pdlFieldTotal(decoy.pdl)) return false;
    // Lone-impostor decoys are PDL-incomplete
    if (decoy.tileIds.length === 1) {
      const tile = puzzle.rows.flatMap(r => r.tiles).find(t => t.id === decoy.tileIds[0]);
      if (tile && tile.isImpostor) return false;
    }
  }
  return true;
}

export function isPuzzleWritingComplete(puzzle) {
  if (!puzzle) return false;
  if (!puzzle.name?.trim()) return false;
  if (!puzzle.rows || puzzle.rows.length !== 4) return false;
  for (const row of puzzle.rows) {
    if (!row.category?.trim()) return false;
    if (!row.tiles || row.tiles.length !== 4) return false;
    if (!row.tiles.every(t => t.text?.trim())) return false;
    if (row.tiles.filter(t => t.isImpostor).length !== 1) return false;
  }
  if (!puzzle.rows.flatMap(r => r.tiles).some(t => t.isRelink)) return false;
  const hasAnswer = !!puzzle.relink?.answer?.trim();
  const hasAssembledTiles = (puzzle.relink?.tiles || []).some(t => t.text?.trim());
  if (!hasAnswer && !hasAssembledTiles) return false;
  return true;
}

export function getPDLIncompleteReasons(puzzle) {
  if (!puzzle) return ['No puzzle loaded'];
  const reasons = [];
  for (const row of puzzle.rows) {
    const status = getRowPDLStatus(row);
    if (status !== 'complete') {
      const label = row.category || `Row ${row.position + 1}`;
      reasons.push(`${label}: group PDL incomplete`);
    }
  }
  if (getImpostorColumnPDLStatus(puzzle.impostorColumn.pdl) !== 'complete') {
    reasons.push('Impostor Column PDL incomplete');
  }
  if (getAnswerConstPDLStatus(puzzle.relink.pdl.answerConstruction) !== 'complete') {
    reasons.push('Answer Construction PDL incomplete');
  }
  for (let i = 0; i < puzzle.decoys.length; i++) {
    const decoy = puzzle.decoys[i];
    const filled = pdlFieldCount(decoy.pdl);
    const total = pdlFieldTotal(decoy.pdl);
    if (filled < total) reasons.push(`Decoy ${i + 1}: PDL fields incomplete (${filled}/${total})`);
    if (decoy.tileIds.length === 1) {
      const tile = puzzle.rows.flatMap(r => r.tiles).find(t => t.id === decoy.tileIds[0]);
      if (tile && tile.isImpostor) reasons.push(`Decoy ${i + 1}: lone impostor tile`);
    }
  }
  return reasons;
}

// ── Schema migration v1 → v2 → v3 → v4 → v5 ──
export function migratePuzzle(puzzle) {
  if (puzzle.schemaVersion === 1 && puzzle.relink?.pdl?.metaConnection) {
    const mc = puzzle.relink.pdl.metaConnection;
    puzzle.relink.pdl.connectionIdentification = {
      knowledge: mc.knowledge,
      manipulation: mc.manipulation,
      abstraction: mc.abstraction,
      knowledgeDomain: mc.knowledgeDomain,
    };
    puzzle.relink.pdl.answerConstruction = { manipulation: null, knowledge: null };
    delete puzzle.relink.pdl.metaConnection;
    puzzle.schemaVersion = 2;
  }
  if (puzzle.schemaVersion === 2) {
    // Move connectionIdentification → impostorColumn
    const ci = puzzle.relink?.pdl?.connectionIdentification;
    puzzle.impostorColumn = { pdl: ci ? { ...ci } : emptyImpostorColumnPDL() };
    if (puzzle.relink?.pdl) {
      delete puzzle.relink.pdl.connectionIdentification;
    }
    // Remove per-row impostor PDL
    for (const row of (puzzle.rows || [])) {
      if (row.pdl) delete row.pdl.impostor;
    }
    puzzle.schemaVersion = 3;
  }
  if (puzzle.schemaVersion === 3) {
    // PDL v4: retire 'Synonym substitution' manipulation (it described a semantic
    // relation, not a mechanical edit). Map it to 'None'; the correct abstraction
    // ('Lexical rewrite') is set by the corpus retag, not inferable here.
    const fixManip = (pdl) => {
      if (!pdl) return;
      if (Array.isArray(pdl.manipulation)) {
        pdl.manipulation = pdl.manipulation.map(v => v === 'Synonym substitution' ? 'None' : v);
      } else if (pdl.manipulation === 'Synonym substitution') {
        pdl.manipulation = 'None';
      }
    };
    for (const row of (puzzle.rows || [])) fixManip(row.pdl?.group);
    fixManip(puzzle.impostorColumn?.pdl);
    fixManip(puzzle.relink?.pdl?.answerConstruction);
    for (const decoy of (puzzle.decoys || [])) fixManip(decoy.pdl);
    puzzle.schemaVersion = 4;
  }
  if (puzzle.schemaVersion === 4) {
    // PDL v5: add the niche-knowledge (obscurity) axis. It lives on TWO objects:
    // each group row (phase-1 / spotting the impostor) and the impostor column
    // (phase-2 / recognising the hidden link). Backfill null NON-destructively —
    // only add the key where absent, never overwrite a value already present
    // (e.g. one written straight into the JSON by a bulk tagging pass), so the
    // migration is safe to run over partially-tagged files.
    for (const row of (puzzle.rows || [])) {
      const g = row.pdl?.group;
      if (g && !('nicheKnowledge' in g)) g.nicheKnowledge = null;
    }
    const ic = puzzle.impostorColumn?.pdl;
    if (ic && !('nicheKnowledge' in ic)) ic.nicheKnowledge = null;
    puzzle.schemaVersion = 5;
  }
  return puzzle;
}
