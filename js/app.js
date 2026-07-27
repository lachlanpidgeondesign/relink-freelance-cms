// Main application — wires state, rendering, and events
import { ROW_COLOURS, DECOY_COLOURS, CANONICAL_ID_RE } from './constants.js';
import { getKnowledgeLevels, getManipulationTypes, getAbstractionLevels, getKnowledgeDomains,
         getImpostorColumnManipulationTypes, getAnswerConstructionManipulationTypes,
         getManipulationModifiers, getNicheKnowledgeLevels,
         SCHEMA_FIELDS, updateSchemaField, resetSchemaToDefaults, onSchemaChange,
         saveSchema, getSchemaForExport } from './schema.js';
import { getState, dispatch, subscribe, createNewPuzzle, createEmptyRow, generateDecoyId, generatePuzzleId,
         getRowPDLStatus, getGroupPDLStatus, getImpostorColumnPDLStatus, getAnswerConstPDLStatus, computeBoardStats, isPuzzlePDLComplete,
         getPDLIncompleteReasons, undo, redo, canUndo, canRedo, rowHasContent } from './state.js';
import { connectDirectory, restoreDirectory, openPuzzle, savePuzzle, deletePuzzle,
         refreshIndex, importPuzzles, downloadJSON, uploadJSON, isFileSystemAccessSupported,
         readPuzzleFile, loadRowBank, saveRowBank,
         loadMyDrafts, submitPuzzle } from './fileio.js';
import { doExportCurrentJSON, doExportAllJSON, doExportPDLSummary } from './export.js';
import { getSession, signOut } from './platform/auth.js';
import { isEditableState, getBounceBacks } from './platform/db.js';

// ── DOM refs ──
const $ = id => document.getElementById(id);

// ── Embedded editor mode ──
// When the composer is loaded as `index.html?edit=<puzzleId>` it is running inside
// the platform editing view's iframe (phase 6). In that mode it opens that one
// puzzle for an editor/admin and talks to the host window over postMessage instead
// of showing the writer's own chrome (drafts sidebar, header, PDL sidebar). The
// is_editor_plus() RLS policies decide what may actually be saved — this flag only
// changes the UI, never the security boundary.
const EMBED_EDIT_ID = new URLSearchParams(location.search).get('edit');
const IS_EMBED_EDIT = !!EMBED_EDIT_ID;

// ── Escape HTML to prevent XSS ──
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

// ── Read-only gate ──
// A puzzle is read-only for the writer once it leaves their editable states
// (draft / changes_requested). RLS enforces this at the database; the UI mirrors
// it. A brand-new, not-yet-saved puzzle (no state) is treated as editable.
function isReadOnly() {
  if (IS_EMBED_EDIT) return false; // editors edit any puzzle in place; RLS gates the save
  const p = getState().puzzle;
  return !!(p && p.state && !isEditableState(p.state));
}

// ── Row Bank persistence (debounced write to save-data/row-bank.json) ──
let _bankSaveTimer = null;
function persistRowBank() {
  if (!getState().dirHandle) return; // read-only mode — nothing to write to
  clearTimeout(_bankSaveTimer);
  _bankSaveTimer = setTimeout(() => {
    saveRowBank(getState().rowBank).catch(err => console.warn('Row bank save failed:', err));
  }, 300);
}

// Undo/redo can change the bank (banking/importing are transactional), so re-persist after.
function doUndo() { undo(); persistRowBank(); }
function doRedo() { redo(); persistRowBank(); }

// ══════════════════════════════════════════
//  RENDERING
// ══════════════════════════════════════════

function render() {
  const state = getState();
  renderHeader(state);
  renderPuzzleList(state);
  renderEditor(state);
}

// ── Header ──
function renderHeader(state) {
  const statusEl = $('header-status');
  const dot = $('status-dot');
  const text = $('status-text');

  // Update breadcrumb
  const breadcrumb = $('header-breadcrumb');
  if (state.puzzle) {
    breadcrumb.innerHTML = `<span>Puzzles</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
      <span class="current">${esc(state.puzzle.date)}${state.puzzle.name ? ' — ' + esc(state.puzzle.name) : ''}</span>`;
  } else {
    breadcrumb.innerHTML = '<span class="current">Dashboard</span>';
  }

  // Status badge (only present in the legacy tooling header; the writer portal
  // header shows the signed-in email instead, so guard for missing elements).
  if (statusEl && dot && text) {
    statusEl.className = 'header-status';
    dot.className = 'dot';
    if (!state.isConnected) {
      statusEl.classList.add('status-disconnected');
      text.textContent = 'Not connected';
    } else if (state.isDirty) {
      statusEl.classList.add('status-unsaved');
      text.textContent = 'Unsaved changes';
    } else {
      statusEl.classList.add('status-connected');
      text.textContent = 'Saved';
    }
  }

  // Undo / Redo button state
  $('btn-undo').disabled = !canUndo();
  $('btn-redo').disabled = !canRedo();
}

// ── Puzzle List ──
function getSearchFields() {
  try { return JSON.parse(localStorage.getItem('search-fields')); } catch { return null; }
}
const DEFAULT_SEARCH_FIELDS = ['name', 'id'];

function getSortPref() {
  try {
    const v = JSON.parse(localStorage.getItem('sort-pref'));
    if (v && v.field) return v;
  } catch {}
  return { field: 'date', dir: 'desc' };
}

function getCompletenessFilters() {
  try {
    const v = JSON.parse(localStorage.getItem('completeness-filters'));
    if (v) return { writing: 'off', pdl: 'off', queued: 'off', ...v };
  } catch {}
  return { writing: 'off', pdl: 'off', queued: 'off' };
}

function renderPuzzleList(state) {
  const container = $('puzzle-list-items');
  const count = $('puzzle-count');
  const fromVal = $('filter-from').value;
  const toVal = $('filter-to').value;

  let items = state.puzzleIndex.puzzles;
  if (fromVal) items = items.filter(p => p.date >= fromVal);
  if (toVal) items = items.filter(p => p.date <= toVal);

  // Text search filter
  const searchEl = $('search-input');
  const query = searchEl ? searchEl.value.trim().toLowerCase() : '';
  if (query) {
    const fields = getSearchFields() || DEFAULT_SEARCH_FIELDS;
    items = items.filter(p => {
      for (const f of fields) {
        const val = (f === 'name' || f === 'id') ? (p[f] || '') : (p.searchFields?.[f] || '');
        if (val.toLowerCase().includes(query)) return true;
      }
      return false;
    });
  }

  // Completeness filters
  const cFilters = getCompletenessFilters();
  if (cFilters.writing === 'complete') items = items.filter(p => p.writingComplete === true);
  else if (cFilters.writing === 'incomplete') items = items.filter(p => !p.writingComplete);
  if (cFilters.pdl === 'complete') items = items.filter(p => p.pdlComplete === true);
  else if (cFilters.pdl === 'incomplete') items = items.filter(p => !p.pdlComplete);
  if (cFilters.queued === 'complete') items = items.filter(p => !!(p.date && p.canonicalId));
  else if (cFilters.queued === 'incomplete') items = items.filter(p => !(p.date && p.canonicalId));

  // Sort
  const sort = getSortPref();
  items = [...items].sort((a, b) => {
    const av = (a[sort.field] || '').toLowerCase();
    const bv = (b[sort.field] || '').toLowerCase();
    const cmp = av.localeCompare(bv, undefined, { numeric: true });
    return sort.dir === 'asc' ? cmp : -cmp;
  });
  // Show/hide clear button
  const clearBtn = $('btn-search-clear');
  if (clearBtn) clearBtn.style.display = query ? '' : 'none';

  count.textContent = `${items.length} draft${items.length !== 1 ? 's' : ''}`;

  if (items.length === 0) {
    container.innerHTML = '<div class="puzzle-list-empty">No drafts yet. Create one with “+ New”.</div>';
    return;
  }

  const STATE_LABELS = {
    draft: 'Draft', changes_requested: 'Changes requested', submitted: 'Submitted',
    in_review: 'In review', ready: 'Ready', published: 'Published',
  };
  container.innerHTML = items.map(item => {
    const isActive = state.puzzle?.id === item.id;
    const stateKey = item.state || 'draft';
    const label = STATE_LABELS[stateKey] || stateKey;
    const editable = ['draft', 'changes_requested'].includes(stateKey);
    return `<div class="puzzle-list-item${isActive ? ' active' : ''}" data-id="${esc(item.id)}">
      <div class="puzzle-list-item-info">
        <div class="puzzle-list-item-title">${esc(item.name) || 'Untitled'}</div>
        <div class="puzzle-list-item-date">
          <span class="draft-state-badge state-${esc(stateKey)}">${esc(label)}</span>
          ${item.date ? esc(item.date) : ''}
        </div>
      </div>
      <div class="puzzle-list-item-actions">
        ${editable ? `<button class="btn-icon btn-sm" data-action="delete" data-id="${esc(item.id)}" title="Delete draft"><i class="fa-solid fa-trash"></i></button>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ── Editor ──
function renderEditor(state) {
  const empty = $('editor-empty');
  const content = $('editor-content');
  if (!state.puzzle) {
    empty.style.display = '';
    content.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  content.style.display = '';

  // Read-only reflection: lock the editor and Save/Send when not editable.
  const readOnly = isReadOnly();
  content.classList.toggle('readonly', readOnly);
  const roBanner = $('readonly-banner');
  if (roBanner) roBanner.style.display = readOnly ? '' : 'none';
  const saveBtn = $('btn-save');
  const sendBtn = $('btn-send');
  if (saveBtn) saveBtn.disabled = readOnly;
  if (sendBtn) sendBtn.disabled = readOnly;

  // Update header input without refocusing
  setInputValue('puzzle-name', state.puzzle.name);
  setInputValue('puzzle-canonical-id', state.puzzle.canonicalId || '');

  renderFeedbackBox(state);
  renderRows(state);
  renderRelinkSection(state);

  // Editor-only authoring surface (PDL sidebar + decoys). Only the platform
  // editing view (embed mode) shows these; the writer portal stays deliberately
  // simple, so we skip rendering them there entirely.
  if (IS_EMBED_EDIT) {
    renderDecoys(state);
    renderPDLSidebar(state);
  }
}

// ── Editor feedback box ──
// When a puzzle has been sent back, the editor's bounce-back note is stored in
// the DB. We fetch it on open (see handleOpenPuzzle) into `_feedback` and show
// the most recent note here so the writer knows what to change. British English,
// XSS-safe via esc(). Hidden when there's no feedback for the loaded puzzle.
let _feedback = { puzzleId: null, entries: [] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function renderFeedbackBox(state) {
  const box = $('feedback-box');
  if (!box) return;
  const p = state.puzzle;
  const entries = (p && _feedback.puzzleId === (p.serverId || p.id)) ? _feedback.entries : [];
  if (!entries.length) { box.style.display = 'none'; return; }

  const latest = entries[entries.length - 1];
  const who = latest.author?.display_name || 'Editor';
  const when = latest.created_at ? new Date(latest.created_at).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '';
  const rounds = entries.length > 1 ? ` · ${entries.length} rounds of feedback` : '';
  $('feedback-box-meta').textContent = `${who}${when ? ' — ' + when : ''}${rounds}`;
  $('feedback-box-body').textContent = latest.feedback || '';
  box.style.display = '';
}

// Load the bounce-back history for the loaded puzzle, then refresh the box.
// Ignores puzzles with no server row yet (a brand-new in-memory draft).
async function loadFeedback(puzzle) {
  const id = puzzle?.serverId || puzzle?.id;
  if (!id || !UUID_RE.test(id)) { _feedback = { puzzleId: null, entries: [] }; return; }
  try {
    const entries = await getBounceBacks(id);
    _feedback = { puzzleId: id, entries: entries || [] };
  } catch (err) {
    console.warn('Could not load editor feedback:', err);
    _feedback = { puzzleId: id, entries: [] };
  }
  // Only refresh if this is still the open puzzle.
  const cur = getState().puzzle;
  if (cur && (cur.serverId || cur.id) === id) renderFeedbackBox(getState());
}

function setInputValue(id, val) {
  const el = $(id);
  if (el && document.activeElement !== el) el.value = val ?? '';
}

// ── Grid Rows ──
const GRIP_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/></svg>`;

/** Build map: tileId → [colour1, colour2, ...] for all decoys */
function buildTileDecoyColours(puzzle) {
  const map = new Map();
  puzzle.decoys.forEach((d, i) => {
    const col = DECOY_COLOURS[i % DECOY_COLOURS.length];
    for (const tid of d.tileIds) {
      if (!map.has(tid)) map.set(tid, []);
      const arr = map.get(tid);
      if (!arr.includes(col)) arr.push(col);
    }
  });
  return map;
}

/** Generate border style for the .decoy-ring wrapper */
function decoyRingBorder(colours) {
  if (!colours || colours.length === 0) return '';
  if (colours.length === 1) {
    return `border-color:${colours[0]};`;
  }
  // Multi-decoy: use CSS custom property for the pseudo-element approach
  const seg = 100 / colours.length;
  const stops = colours.map((c, i) => `${c} ${(i * seg).toFixed(1)}% ${((i + 1) * seg).toFixed(1)}%`).join(', ');
  return `border-color:transparent;--ring-gradient:conic-gradient(from 90deg, ${stops});`;
}

function renderRows(state) {
  const container = $('row-list');
  const puzzle = state.puzzle;
  const sel = state.selection;
  const tileDecoyColours = buildTileDecoyColours(puzzle);
  const decoyTileIds = new Set(puzzle.decoys.flatMap(d => d.tileIds));
  const selectedTileIds = new Set(sel.type === 'tiles' ? (sel.tileIds || []) : []);

  // If a text input inside the rows is focused, do an in-place update instead
  // of replacing innerHTML (which destroys focus).
  const activeEl = document.activeElement;
  const isEditingInRows = activeEl && container.contains(activeEl) &&
    (activeEl.dataset.field === 'tile' || activeEl.dataset.field === 'category');

  if (isEditingInRows) {
    // Patch existing DOM in-place: sync values, classes, toggles
    puzzle.rows.forEach((row, idx) => {
      const rowEl = container.querySelector(`[data-row-id="${row.id}"]`);
      if (!rowEl) return;
      const isRowSelected = sel.type === 'row' && sel.rowId === row.id;
      rowEl.classList.toggle('selected', isRowSelected);

      // Sync category (skip if focused)
      const catInput = rowEl.querySelector('[data-field="category"]');
      if (catInput && catInput !== activeEl) catInput.value = row.category ?? '';

      // Keep the bank button enabled only while the row has content
      const bankBtn = rowEl.querySelector('[data-action="bank-row"]');
      if (bankBtn) bankBtn.disabled = !rowHasContent(row);

      // Sync tiles
      row.tiles.forEach(tile => {
        const tileInput = rowEl.querySelector(`[data-tile-id="${tile.id}"][data-field="tile"]`);
        if (!tileInput) return;
        if (tileInput !== activeEl) tileInput.value = tile.text ?? '';
        const isSel = selectedTileIds.has(tile.id);
        tileInput.classList.toggle('selected', isSel);
        tileInput.classList.toggle('is-impostor', !!tile.isImpostor);
        tileInput.placeholder = tile.isImpostor ? 'Impostor' : 'Tile';

        // Update decoy ring colour
        const colours = tileDecoyColours.get(tile.id);
        const ring = tileInput.closest('.decoy-ring');
        if (ring) ring.style.cssText = colours?.length ? decoyRingBorder(colours) : '';

        // Sync toggle button states
        const slot = tileInput.closest('.tile-slot');
        if (slot) {
          const rlBtn = slot.querySelector('[data-toggle="relink"]');
          const imBtn = slot.querySelector('[data-toggle="impostor"]');
          if (rlBtn) rlBtn.classList.toggle('active', !!tile.isRelink);
          if (imBtn) imBtn.classList.toggle('active', !!tile.isImpostor);
        }
      });
    });
    return;
  }

  container.innerHTML = puzzle.rows.map((row, idx) => {
    const colour = ROW_COLOURS[idx] || ROW_COLOURS[0];
    const isRowSelected = sel.type === 'row' && sel.rowId === row.id;
    const pdlStatus = getRowPDLStatus(row);

    const tilesHtml = row.tiles.map(tile => {
      const isSel = selectedTileIds.has(tile.id);
      const isImpostor = tile.isImpostor;
      const colours = tileDecoyColours.get(tile.id);
      const ringStyle = colours?.length ? decoyRingBorder(colours) : '';
      return `<div class="tile-slot">
        <div class="tile-toggles">
          <button class="tile-toggle relink${tile.isRelink ? ' active' : ''}"
                  data-row-id="${row.id}" data-tile-id="${tile.id}" data-toggle="relink">relink</button>
          <button class="tile-toggle impostor${isImpostor ? ' active' : ''}"
                  data-row-id="${row.id}" data-tile-id="${tile.id}" data-toggle="impostor">impostor</button>
        </div>
        <div class="decoy-ring"${ringStyle ? ` style="${ringStyle}"` : ''}>
          <input class="tile-input${isSel ? ' selected' : ''}${isImpostor ? ' is-impostor' : ''}"
                 type="text" value="${esc(tile.text)}"
                 placeholder="${isImpostor ? 'Impostor' : 'Tile'}"
                 data-row-id="${row.id}" data-tile-id="${tile.id}" data-field="tile">
        </div>
      </div>`;
    }).join('');

    return `<div class="puzzle-row${isRowSelected ? ' selected' : ''}"
                 data-row-id="${row.id}" data-row-idx="${idx}">
      <div class="row-color-bar" style="background-color:${colour.bg}"></div>
      <div class="row-body">
        <div class="row-content">
          <div class="row-category" style="display:flex;align-items:center;gap:8px;">
            <input type="text" value="${esc(row.category)}" placeholder="Category..."
                   data-row-id="${row.id}" data-field="category" style="flex:1;">
            <button class="btn-icon btn-sm row-bank-btn" data-action="bank-row" data-row-id="${row.id}" title="Send this row to the bank"${rowHasContent(row) ? '' : ' disabled'}><i class="fa-solid fa-box-archive"></i></button>
            <button class="btn-icon btn-sm row-bank-btn" data-action="import-row" data-row-id="${row.id}" title="Import a row from the bank"><i class="fa-solid fa-file-import"></i></button>
            <div class="pdl-dot ${pdlStatus}" title="PDL status" style="flex-shrink:0;"></div>
          </div>
          <div class="row-tiles">${tilesHtml}</div>
        </div>
        <div class="row-drag-handle" title="Drag to reorder">${GRIP_SVG}</div>
      </div>
    </div>`;
  }).join('');
}

// ── Relink Section ──
const CHIP_GRIP_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/></svg>`;
const CHIP_X_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
const PLUS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
const LINK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"></path><path d="M15 7h2a5 5 0 1 1 0 10h-2"></path><line x1="8" x2="16" y1="12" y2="12"></line></svg>`;
const UNLINK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"></path><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"></path><line x1="8" x2="8" y1="2" y2="5"></line><line x1="2" x2="5" y1="8" y2="8"></line><line x1="16" x2="16" y1="19" y2="22"></line><line x1="19" x2="22" y1="16" y2="16"></line></svg>`;

function renderRelinkSection(state) {
  const puzzle = state.puzzle;
  const sel = state.selection;
  const section = $('relink-section');
  section.className = 'relink-section' + (sel.type === 'relink' ? ' selected' : '');

  const connIdStatus = getImpostorColumnPDLStatus(puzzle.impostorColumn.pdl);
  const ansConstStatus = getAnswerConstPDLStatus(puzzle.relink.pdl.answerConstruction);
  $('relink-pdl-indicator').innerHTML = `<div class="pdl-dot ${connIdStatus}"></div><div class="pdl-dot ${ansConstStatus}"></div>`;

  // Build row-id-to-index lookup for coloring chips by source row
  const rowIdToIndex = {};
  for (let ri = 0; ri < puzzle.rows.length; ri++) {
    rowIdToIndex[puzzle.rows[ri].id] = ri;
  }

  const tilesContainer = $('relink-tiles');

  // Skip rebuilding chips if a fodder input is focused (preserve cursor)
  const activeFodder = document.activeElement?.classList.contains('fodder-chip-input');
  if (!activeFodder) {
    const tiles = puzzle.relink.tiles;
    // Background colour of a chip (grid tiles take their source-row colour; fodder is plain)
    const chipBg = t => {
      if (t.source !== 'grid') return '';
      const rowIdx = rowIdToIndex[t.sourceRowId] ?? -1;
      const colour = rowIdx >= 0 ? (ROW_COLOURS[rowIdx] || ROW_COLOURS[0]) : null;
      return colour ? colour.bg : '';
    };

    const parts = [];
    tiles.forEach((t, i) => {
      const bgColor = chipBg(t);
      const joinedR = t.joinNext ? ' joined-r' : '';
      const joinedL = (i > 0 && tiles[i - 1].joinNext) ? ' joined-l' : '';
      const cls = `relink-chip${t.source === 'fodder' ? ' fodder' : ''}${joinedR}${joinedL}`;
      if (t.source === 'fodder') {
        const inputSize = Math.max(5, t.text.length) || 5;
        parts.push(`<span class="${cls}" data-relink-idx="${i}">
          ${CHIP_GRIP_SVG}
          <input class="fodder-chip-input" type="text" value="${esc(t.text)}" data-fodder-idx="${i}" size="${inputSize}">
          <button class="chip-remove" data-relink-idx="${i}">${CHIP_X_SVG}</button>
        </span>`);
      } else {
        const style = bgColor ? ` style="background:${bgColor}"` : '';
        parts.push(`<span class="${cls}"${style} data-relink-idx="${i}">
          ${CHIP_GRIP_SVG}
          ${esc(t.text)}
          <button class="chip-remove" data-relink-idx="${i}">${CHIP_X_SVG}</button>
        </span>`);
      }
      // Link/unlink toggle in the gap before the next chip
      if (i < tiles.length - 1) {
        const linked = !!t.joinNext;
        const leftBg = bgColor || 'var(--muted-foreground)';
        const rightBg = chipBg(tiles[i + 1]) || 'var(--muted-foreground)';
        const label = linked ? 'Unlink words' : 'Link adjacent words';
        parts.push(`<button class="relink-join-toggle${linked ? ' linked' : ''}" data-join-idx="${i}" style="--jl:${leftBg};--jr:${rightBg}" title="${label}" aria-label="${label}">${linked ? UNLINK_SVG : LINK_SVG}</button>`);
      }
    });

    tilesContainer.innerHTML = parts.join('') +
      `<button class="relink-add-btn" id="btn-add-fodder" title="Add fodder tile">${PLUS_SVG}</button>`;
  }

}

// ── Decoy type classification ──
function computeDecoyType(decoy, puzzle) {
  const tileCount = decoy.tileIds.length;
  if (tileCount === 0) return { type: null, isInvalid: false, invalidReason: null };

  // Build tile lookup maps
  const tileRowMap = new Map();
  const tileImpostorMap = new Map();
  for (const row of puzzle.rows) {
    const ri = row.position;
    for (const t of row.tiles) {
      tileRowMap.set(t.id, ri);
      tileImpostorMap.set(t.id, !!t.isImpostor);
    }
  }

  const hasImpostor = decoy.tileIds.some(id => tileImpostorMap.get(id));
  const spannedRows = new Set(decoy.tileIds.map(id => tileRowMap.get(id)).filter(i => i !== undefined));
  const rowsSpanned = spannedRows.size;

  // Invalid: lone impostor
  if (tileCount === 1 && hasImpostor) {
    return { type: null, isInvalid: true, invalidReason: 'Lone impostor \u2014 consider selecting all 4 tiles in the row' };
  }

  // Horizontal (single row)
  if (rowsSpanned === 1) {
    if (tileCount === 1 && !hasImpostor) return { type: 'Inclusive', isInvalid: false, invalidReason: null };
    if (tileCount === 3 && hasImpostor) return { type: 'Exclusive', isInvalid: false, invalidReason: null };
    return { type: 'Confusion', isInvalid: false, invalidReason: null };
  }

  // Cross-row
  const tilesPerRow = new Map();
  decoy.tileIds.forEach(id => { const ri = tileRowMap.get(id); if (ri !== undefined) tilesPerRow.set(ri, (tilesPerRow.get(ri) || 0) + 1); });
  const maxInAnyRow = Math.max(...tilesPerRow.values());
  const pureVertical = maxInAnyRow === 1;

  if (pureVertical || hasImpostor) return { type: 'Inclusive', isInvalid: false, invalidReason: null };
  return { type: 'Confusion', isInvalid: false, invalidReason: null };
}

// ── Decoys ──
function renderDecoys(state) {
  const puzzle = state.puzzle;
  const sel = state.selection;
  const container = $('decoy-cards');
  const createFromSelBtn = $('btn-create-decoy-from-sel');

  // Show "Create from Selection" if 2+ tiles selected
  if (sel.type === 'tiles' && sel.tileIds && sel.tileIds.length >= 2) {
    createFromSelBtn.style.display = '';
    createFromSelBtn.textContent = `Create Decoy from ${sel.tileIds.length} tiles`;
  } else {
    createFromSelBtn.style.display = 'none';
  }

  if (puzzle.decoys.length === 0) {
    container.innerHTML = '<div class="decoy-empty">No decoys defined. Click "+ Add Decoy" to create one.</div>';
    return;
  }

  // Build tile lookup
  const tileMap = {};
  for (const row of puzzle.rows) {
    for (const t of row.tiles) tileMap[t.id] = t;
  }

  container.innerHTML = puzzle.decoys.map((decoy, di) => {
    const isSelected = sel.type === 'decoy' && sel.decoyId === decoy.id;
    const tiles = decoy.tileIds.map(id => tileMap[id]).filter(Boolean);
    const decoyCol = DECOY_COLOURS[di % DECOY_COLOURS.length];
    const dtype = computeDecoyType(decoy, puzzle);
    const typeBadge = dtype.isInvalid
      ? `<span class="decoy-type-badge warning" title="${esc(dtype.invalidReason)}"><i class="fa-solid fa-triangle-exclamation"></i> Invalid</span>`
      : dtype.type
        ? `<span class="decoy-type-badge">${esc(dtype.type)}</span>`
        : '';
    return `<div class="decoy-card${isSelected ? ' selected' : ''}" data-decoy-id="${decoy.id}" style="border-color:${isSelected ? decoyCol : 'var(--border)'};">
      <div class="decoy-color-bar" style="background:${decoyCol};"></div>
      <div class="decoy-card-inner">
        <div class="decoy-card-header">
          <span class="decoy-label" style="color:${decoyCol};">Decoy ${di + 1}</span>${typeBadge}
          <button class="btn-icon btn-sm" data-action="remove-decoy" data-decoy-id="${decoy.id}"><i class="fa-solid fa-trash"></i></button>
        </div>
        <div class="decoy-card-body">
          ${decoy.pdl.description ? `<div class="decoy-desc">${esc(decoy.pdl.description)}</div>` : ''}
          <div class="decoy-tiles-display">
            ${tiles.map(t => `<span class="decoy-tile-chip" style="background:${decoyCol}22;color:${decoyCol};border:1px solid ${decoyCol}44;">${esc(t.text)}</span>`).join('')}
            ${tiles.length === 0 ? '<em style="color:var(--muted-foreground);font-size:12px;">No tiles assigned</em>' : ''}
          </div>
          <div class="decoy-meta">
            ${decoy.pdl.completeness ? `<span>${esc(decoy.pdl.completeness)}</span>` : ''}
            ${decoy.pdl.groupsSpanned ? `<span>Groups: ${esc(decoy.pdl.groupsSpanned)}</span>` : ''}
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── PDL Sidebar ──
function renderPDLSidebar(state) {
  const content = $('pdl-content');
  const label = $('pdl-context-label');
  const sel = state.selection;
  const puzzle = state.puzzle;

  if (!puzzle) {
    label.textContent = '';
    content.innerHTML = '<div class="pdl-sidebar-empty">Open a puzzle to start tagging.</div>';
    return;
  }

  // If a text input/textarea inside the PDL sidebar is focused, skip innerHTML
  // rebuild to avoid destroying focus (same pattern as renderRows).
  const activeEl = document.activeElement;
  const activeInPDL = activeEl && content.contains(activeEl) &&
    (activeEl.tagName === 'TEXTAREA' || (activeEl.tagName === 'INPUT' && activeEl.type === 'text'));
  if (activeInPDL) return;

  if (sel.type === 'row') {
    const row = puzzle.rows.find(r => r.id === sel.rowId);
    if (!row) { renderPDLEmpty(content, label); return; }
    label.textContent = `— Row ${row.position + 1}: ${row.category || 'Untitled'}`;
    content.innerHTML = renderGroupPDLForm(row) + renderBoardPDLForm(puzzle);
  } else if (sel.type === 'relink') {
    label.textContent = '— Relink Connection';
    content.innerHTML = renderImpostorColumnPDLForm(puzzle) + renderAnswerConstPDLForm(puzzle) + renderBoardPDLForm(puzzle);
  } else if (sel.type === 'decoy') {
    const decoy = puzzle.decoys.find(d => d.id === sel.decoyId);
    if (!decoy) { renderPDLEmpty(content, label); return; }
    const di = puzzle.decoys.indexOf(decoy);
    const decoyCol = DECOY_COLOURS[di % DECOY_COLOURS.length];
    label.innerHTML = `— <span style="color:${decoyCol};font-weight:600;">Decoy ${di + 1}</span>`;
    content.innerHTML = renderDecoyPDLForm(decoy, puzzle) + renderBoardPDLForm(puzzle);
  } else if (sel.type === 'tiles') {
    label.textContent = `— ${sel.tileIds?.length || 0} tile(s) selected`;
    content.innerHTML = '<div class="pdl-sidebar-empty">Select a row, the relink section, or a decoy to edit PDL tags.<br><br>Or click "Create Decoy from Selection" to group these tiles.</div>'
      + renderBoardPDLForm(puzzle);
  } else {
    label.textContent = '';
    content.innerHTML = '<div class="pdl-sidebar-empty">Click a <strong>row</strong> to tag its group PDL.<br>Click the <strong>relink section</strong> to tag the meta-connection.<br>Click a <strong>decoy</strong> to tag it.<br><br>Use <strong>Cmd+click</strong> on tiles to multi-select for decoy creation.</div>'
      + renderBoardPDLForm(puzzle);
  }
}

function renderPDLEmpty(content, label) {
  label.textContent = '';
  content.innerHTML = '<div class="pdl-sidebar-empty">Selection target not found.</div>';
}

function pdlMultiSelect(label, value, options, dataAttr) {
  // value is array | null; display as multi-select checkbox dropdown
  const selected = Array.isArray(value) ? value : [];
  const displayText = selected.length ? selected.join(', ') : '— Select —';
  const filledClass = selected.length ? ' filled' : '';
  const checkboxes = options.map(o => {
    const checked = selected.includes(o) ? ' checked' : '';
    return `<label class="pdl-ms-option"><input type="checkbox" value="${esc(o)}"${checked} ${dataAttr}><span>${esc(o)}</span></label>`;
  }).join('');
  return `<div class="pdl-multi-select">
    <label>${esc(label)}</label>
    <button class="pdl-ms-trigger${filledClass}" ${dataAttr} type="button">${esc(displayText)}</button>
    <div class="pdl-ms-dropdown" style="display:none;">${checkboxes}</div>
  </div>`;
}

// Render the single-select modifier dropdowns (position / whole) that apply to
// the currently-selected manipulation value(s). Returns '' when none apply, so
// the controls only surface where the schema says they're relevant.
function pdlModifierSelects(manipValue, modifiers, dataAttr) {
  const spec = getManipulationModifiers();
  const manipSet = Array.isArray(manipValue) ? manipValue : (manipValue ? [manipValue] : []);
  const mods = modifiers || {};
  let fields = '';
  for (const key of Object.keys(spec)) {
    const entry = spec[key] || {};
    const applies = (entry.appliesTo || []).some(m => manipSet.includes(m));
    if (!applies) continue;
    const cur = mods[key] || '';
    const opts = ['<option value="">— Select —</option>']
      .concat((entry.values || []).map(v =>
        `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`))
      .join('');
    const labelText = key.charAt(0).toUpperCase() + key.slice(1);
    const missingClass = cur ? '' : ' missing';
    fields += `<div class="pdl-modifier-field${missingClass}">
      <label>${esc(labelText)} <span class="pdl-modifier-tag">modifier</span></label>
      <select class="pdl-modifier-select" ${dataAttr} data-modifier="${esc(key)}">${opts}</select>
    </div>`;
  }
  return fields ? `<div class="pdl-modifier-group">${fields}</div>` : '';
}

// Drop any modifier whose manipulation no longer applies (e.g. after the
// manipulation changes). Returns the pruned object, or undefined when empty so
// JSON.stringify omits the key entirely (matching the save-data convention).
function pruneModifiers(manipValue, modifiers) {
  if (!modifiers) return undefined;
  const spec = getManipulationModifiers();
  const manipSet = Array.isArray(manipValue) ? manipValue : (manipValue ? [manipValue] : []);
  const next = {};
  for (const key of Object.keys(spec)) {
    const applies = (spec[key]?.appliesTo || []).some(m => manipSet.includes(m));
    if (applies && modifiers[key]) next[key] = modifiers[key];
  }
  return Object.keys(next).length ? next : undefined;
}

function renderGroupPDLForm(row) {
  const g = row.pdl.group;
  const status = getGroupPDLStatus(g);
  return `<div class="pdl-form-section">
    <h4><div class="pdl-dot ${status}"></div> Group PDL</h4>
    <div class="pdl-form">
      ${pdlMultiSelect('Knowledge Level', g.knowledge, getKnowledgeLevels(), `data-pdl="group-knowledge" data-row-id="${row.id}"`)}
      ${pdlMultiSelect('Niche Knowledge', g.nicheKnowledge, getNicheKnowledgeLevels(), `data-pdl="group-niche-knowledge" data-row-id="${row.id}"`)}
      ${pdlMultiSelect('Manipulation', g.manipulation, getManipulationTypes(), `data-pdl="group-manipulation" data-row-id="${row.id}"`)}
      ${pdlModifierSelects(g.manipulation, g.manipulationModifiers, `data-pdl="group-modifier" data-row-id="${row.id}"`)}
      ${pdlMultiSelect('Abstraction', g.abstraction, getAbstractionLevels(), `data-pdl="group-abstraction" data-row-id="${row.id}"`)}
      ${pdlMultiSelect('Knowledge Domain', g.knowledgeDomain, getKnowledgeDomains(), `data-pdl="group-domain" data-row-id="${row.id}"`)}
    </div>
  </div>`;
}

function renderImpostorColumnPDLForm(puzzle) {
  const ic = puzzle.impostorColumn.pdl;
  const status = getImpostorColumnPDLStatus(ic);
  return `<div class="pdl-form-section">
    <h4><div class="pdl-dot ${status}"></div> Impostor Column PDL</h4>
    <div class="pdl-form">
      ${pdlMultiSelect('Manipulation', ic.manipulation, getImpostorColumnManipulationTypes(), 'data-pdl="imp-col-manipulation"')}
      ${pdlModifierSelects(ic.manipulation, ic.manipulationModifiers, 'data-pdl="imp-col-modifier"')}
      ${pdlMultiSelect('Knowledge Level', ic.knowledge, getKnowledgeLevels(), 'data-pdl="imp-col-knowledge"')}
      ${pdlMultiSelect('Niche Knowledge', ic.nicheKnowledge, getNicheKnowledgeLevels(), 'data-pdl="imp-col-niche-knowledge"')}
      ${pdlMultiSelect('Abstraction', ic.abstraction, getAbstractionLevels(), 'data-pdl="imp-col-abstraction"')}
      ${pdlMultiSelect('Knowledge Domain', ic.knowledgeDomain, getKnowledgeDomains(), 'data-pdl="imp-col-domain"')}
    </div>
  </div>`;
}

function renderAnswerConstPDLForm(puzzle) {
  const ac = puzzle.relink.pdl.answerConstruction;
  const status = getAnswerConstPDLStatus(ac);
  return `<div class="pdl-form-section">
    <h4><div class="pdl-dot ${status}"></div> Answer Construction PDL</h4>
    <div class="pdl-form">
      ${pdlMultiSelect('Manipulation', ac.manipulation, getAnswerConstructionManipulationTypes(), 'data-pdl="answr-manipulation"')}
      ${pdlMultiSelect('Knowledge Level', ac.knowledge, getKnowledgeLevels(), 'data-pdl="answr-knowledge"')}
    </div>
  </div>`;
}

function renderDecoyPDLForm(decoy, puzzle) {
  const d = decoy.pdl;
  // Build 4×4 checkbox grid colored by row
  const tileCheckboxes = puzzle.rows.map((row, ri) => {
    const colour = ROW_COLOURS[ri] || ROW_COLOURS[0];
    return row.tiles.map(t => {
      const isChecked = decoy.tileIds.includes(t.id);
      const bg = isChecked ? colour.bg : `${colour.bg}30`;
      return `<div class="decoy-grid-cell${isChecked ? ' selected' : ''}" style="background:${bg};"
                   data-decoy-tile="${t.id}" data-decoy-id="${decoy.id}" title="${esc(t.text || '(empty)')}">
        ${isChecked ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 7.5L5.5 10.5L11.5 3.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>' : ''}
      </div>`;
    }).join('');
  }).join('');

  // Auto-compute groupsSpanned and completeness from tile selections
  const tileRowMap = new Map();
  puzzle.rows.forEach((row, ri) => row.tiles.forEach(t => tileRowMap.set(t.id, ri)));
  const spannedRows = [...new Set(decoy.tileIds.map(id => tileRowMap.get(id)).filter(i => i !== undefined))].sort();
  const computedGroups = spannedRows.join(',');
  const tileCount = decoy.tileIds.length;
  // Count tiles per spanned row
  const tilesPerRow = new Map();
  decoy.tileIds.forEach(id => { const ri = tileRowMap.get(id); if (ri !== undefined) tilesPerRow.set(ri, (tilesPerRow.get(ri) || 0) + 1); });
  let computedCompleteness = '';
  if (tileCount > 0) {
    const rowCount = spannedRows.length;
    const maxInAnyRow = Math.max(...tilesPerRow.values());
    const onePerRow = maxInAnyRow === 1 && rowCount > 1;

    if (rowCount === 1 && tileCount === 4) {
      computedCompleteness = 'Full horizontal';
    } else if (rowCount === 1 && tileCount < 4) {
      computedCompleteness = `Partial horizontal (${tileCount} tile${tileCount > 1 ? 's' : ''})`;
    } else if (onePerRow && rowCount === 4) {
      computedCompleteness = 'Full vertical';
    } else if (onePerRow && rowCount < 4) {
      computedCompleteness = `Partial vertical (${rowCount} group${rowCount > 1 ? 's' : ''})`;
    } else if (tileCount > rowCount) {
      computedCompleteness = `Over-full (${tileCount} tiles across ${rowCount} group${rowCount > 1 ? 's' : ''})`;
    } else {
      computedCompleteness = `${tileCount} tile${tileCount > 1 ? 's' : ''} across ${rowCount} group${rowCount > 1 ? 's' : ''}`;
    }
  }

  return `<div class="pdl-form-section">
    <h4>Decoy PDL</h4>
    <div class="pdl-form">
      ${pdlMultiSelect('Knowledge Level', d.knowledge, getKnowledgeLevels(), `data-pdl="decoy-knowledge" data-decoy-id="${decoy.id}"`)}
      ${pdlMultiSelect('Manipulation', d.manipulation, getManipulationTypes(), `data-pdl="decoy-manipulation" data-decoy-id="${decoy.id}"`)}
      ${pdlMultiSelect('Abstraction', d.abstraction, getAbstractionLevels(), `data-pdl="decoy-abstraction" data-decoy-id="${decoy.id}"`)}
      <div class="pdl-computed-field">
        <label>Completeness</label>
        <span class="pdl-computed-value">${computedCompleteness || '\u2014'}</span>
      </div>
      <div class="pdl-computed-field">
        <label>Groups Spanned</label>
        <span class="pdl-computed-value">${computedGroups || '\u2014'}</span>
      </div>
      ${(() => {
        const dtype = computeDecoyType(decoy, puzzle);
        if (dtype.isInvalid) return `<div class="pdl-computed-field"><label>Type</label><span class="pdl-computed-value warning"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(dtype.invalidReason)}</span></div>`;
        if (dtype.type) return `<div class="pdl-computed-field"><label>Type</label><span class="pdl-computed-value">${esc(dtype.type)}</span></div>`;
        return `<div class="pdl-computed-field"><label>Type</label><span class="pdl-computed-value">\u2014</span></div>`;
      })()}
      <div class="pdl-text-field">
        <label>Description</label>
        <textarea data-pdl="decoy-description" data-decoy-id="${decoy.id}"
                  placeholder="Describe the decoy...">${esc(d.description)}</textarea>
      </div>
      <div class="pdl-text-field">
        <label>Tiles</label>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;">
          ${tileCheckboxes}
        </div>
      </div>
    </div>
  </div>`;
}

function renderBoardPDLForm(puzzle) {
  const b = puzzle.board;
  const stats = computeBoardStats(puzzle);
  return `<div class="pdl-form-section" style="margin-top:12px;">
    <h4>Board PDL</h4>
    <div class="pdl-form">
      <div class="pdl-computed-field">
        <label>Specialist Group Count</label>
        <span class="pdl-computed-value">${stats.specialistGroupCount}</span>
      </div>
      <div class="pdl-computed-field">
        <label>Decoy Count</label>
        <span class="pdl-computed-value">${stats.decoyCount}</span>
      </div>
      <div class="pdl-computed-field">
        <label>Phase 2 Tile Count</label>
        <span class="pdl-computed-value">${stats.phase2TileCount}</span>
      </div>
      <div class="pdl-checkbox">
        <input type="checkbox" ${b.isThemed ? 'checked' : ''} data-pdl="board-themed">
        <span>Is Themed</span>
      </div>
      ${b.isThemed ? pdlMultiSelect('Theme Domain', b.themeDomain, getKnowledgeDomains(), 'data-pdl="board-theme-domain"') : ''}
    </div>
  </div>`;
}


// ══════════════════════════════════════════
//  EVENT HANDLERS (delegated)
// ══════════════════════════════════════════

document.addEventListener('click', e => {
  const t = e.target;

  // Header buttons
  if (t.id === 'btn-new' || t.id === 'btn-new-empty') return handleNew();
  if (t.id === 'btn-undo' || t.closest('#btn-undo')) return doUndo();
  if (t.id === 'btn-redo' || t.closest('#btn-redo')) return doRedo();
  if (t.id === 'btn-save' || t.closest('#btn-save')) return handleSave();
  if (t.id === 'btn-send' || t.closest('#btn-send')) return handleSend();
  if (t.id === 'btn-signout' || t.closest('#btn-signout')) return handleSignOut();
  if (t.id === 'btn-connect') return handleConnect();
  if (t.id === 'btn-import') return showModal('import-modal');
  if (t.id === 'btn-export') return showModal('export-modal');
  if (t.id === 'btn-schema' || t.closest('#btn-schema')) { renderSchemaModal(); return showModal('schema-modal'); }
  if (t.id === 'btn-refresh-index') return refreshIndex();
  if (t.id === 'export-close') return hideModal('export-modal');
  if (t.id === 'import-close') return hideModal('import-modal');
  if (t.id === 'schema-save') return handleSchemaSave();
  if (t.id === 'schema-reset') return handleSchemaReset();

  // Toggle sidebars
  if (t.closest('#btn-toggle-list')) return toggleSidebar('left');

  // Export actions
  if (t.closest('#export-current-json')) return handleExportCurrentJSON();
  if (t.closest('#export-all-json')) return handleExportAllJSON();
  if (t.closest('#export-pdl-summary')) return handleExportPDLSummary();

  // Import actions
  if (t.closest('#import-file')) return handleImportFile();

  // ── Row Bank ──
  if (t.id === 'btn-row-bank' || t.closest('#btn-row-bank')) { openRowBankModal('manage'); return; }
  if (t.id === 'row-bank-close' || t.closest('#row-bank-close')) return hideModal('row-bank-modal');
  if (t.id === 'row-bank-add' || t.closest('#row-bank-add')) {
    dispatch({ type: 'ADD_BANK_ROW' });
    persistRowBank();
    renderRowBankModal();
    requestAnimationFrame(() => {
      const first = document.querySelector('#row-bank-list .bank-row-category');
      if (first) first.focus();
    });
    return;
  }
  const useBankBtn = t.closest('[data-action="use-bank-row"]');
  if (useBankBtn) { handleUseBankRow(useBankBtn.dataset.bankRowId); return; }
  const delBankBtn = t.closest('[data-action="delete-bank-row"]');
  if (delBankBtn) {
    if (confirm('Delete this row from the bank?')) {
      dispatch({ type: 'DELETE_BANK_ROW', bankRowId: delBankBtn.dataset.bankRowId });
      persistRowBank();
      renderRowBankModal();
    }
    return;
  }
  const bankImpToggle = t.closest('[data-bank-toggle="impostor"]');
  if (bankImpToggle) {
    e.stopPropagation();
    dispatch({ type: 'TOGGLE_BANK_ROW_IMPOSTOR', bankRowId: bankImpToggle.dataset.bankRowId, tileId: bankImpToggle.dataset.tileId });
    persistRowBank();
    renderRowBankModal();
    return;
  }
  // Displaced-content prompt (shown when importing onto a row that already has content)
  if (t.id === 'displace-cancel' || t.closest('#displace-cancel')) { hideModal('row-bank-displace-modal'); _pendingImport = null; return; }
  if (t.id === 'displace-bank' || t.closest('#displace-bank')) { resolveDisplace('bank'); return; }
  if (t.id === 'displace-delete' || t.closest('#displace-delete')) { resolveDisplace('delete'); return; }

  // Bank / import buttons on a puzzle row
  const bankRowBtn = t.closest('[data-action="bank-row"]');
  if (bankRowBtn) { e.stopPropagation(); handleBankRow(bankRowBtn.dataset.rowId); return; }
  const importRowBtn = t.closest('[data-action="import-row"]');
  if (importRowBtn) { e.stopPropagation(); openRowBankModal('pick', importRowBtn.dataset.rowId); return; }

  // Puzzle list item
  const listItem = t.closest('.puzzle-list-item');
  if (listItem && !t.closest('[data-action]')) {
    return handleOpenPuzzle(listItem.dataset.id);
  }
  // Puzzle list actions (button may have an <i> icon child, so use closest)
  const actionBtn = t.closest('[data-action]');
  if (actionBtn) {
    if (actionBtn.dataset.action === 'delete') return handleDeletePuzzle(actionBtn.dataset.id);
    if (actionBtn.dataset.action === 'duplicate') return handleDuplicatePuzzle(actionBtn.dataset.id);
  }

  // Tile toggles
  if (t.dataset.toggle === 'relink') {
    e.stopPropagation();
    dispatch({ type: 'TOGGLE_RELINK', rowId: t.dataset.rowId, tileId: t.dataset.tileId });
    return;
  }
  if (t.dataset.toggle === 'impostor') {
    e.stopPropagation();
    dispatch({ type: 'TOGGLE_IMPOSTOR', rowId: t.dataset.rowId, tileId: t.dataset.tileId });
    return;
  }

  // Relink chip remove — target may be the SVG/path inside the button
  const chipRemoveBtn = t.closest('.chip-remove');
  if (chipRemoveBtn) {
    e.stopPropagation();
    dispatch({ type: 'REMOVE_RELINK_TILE', index: parseInt(chipRemoveBtn.dataset.relinkIdx) });
    return;
  }

  // Relink join toggle — smoosh adjacent tiles into a compound word
  const joinToggleBtn = t.closest('.relink-join-toggle');
  if (joinToggleBtn) {
    e.stopPropagation();
    dispatch({ type: 'TOGGLE_RELINK_JOIN', index: parseInt(joinToggleBtn.dataset.joinIdx) });
    return;
  }

  // Add fodder — + button creates a blank fodder chip
  if (t.id === 'btn-add-fodder' || t.closest('#btn-add-fodder')) {
    e.stopPropagation();
    dispatch({ type: 'ADD_FODDER_TILE', text: '' });
    // After render, focus the new fodder input
    requestAnimationFrame(() => {
      const inputs = document.querySelectorAll('.fodder-chip-input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    return;
  }

  // Add decoy
  if (t.id === 'btn-add-decoy') { dispatch({ type: 'ADD_DECOY' }); return; }
  if (t.id === 'btn-create-decoy-from-sel') {
    const sel = getState().selection;
    if (sel.type === 'tiles' && sel.tileIds?.length) {
      dispatch({ type: 'ADD_DECOY_FROM_TILES', tileIds: sel.tileIds });
    }
    return;
  }

  // Remove decoy
  if (t.dataset.action === 'remove-decoy') {
    e.stopPropagation();
    dispatch({ type: 'REMOVE_DECOY', decoyId: t.dataset.decoyId });
    return;
  }

  // Decoy tile grid cell click
  const gridCell = t.closest('.decoy-grid-cell');
  if (gridCell) {
    const tileId = gridCell.dataset.decoyTile;
    const decoyId = gridCell.dataset.decoyId;
    const decoy = getState().puzzle?.decoys.find(d => d.id === decoyId);
    if (decoy) {
      const isSelected = decoy.tileIds.includes(tileId);
      const tileIds = isSelected
        ? decoy.tileIds.filter(id => id !== tileId)
        : [...decoy.tileIds, tileId];
      dispatch({ type: 'UPDATE_DECOY_TILES', decoyId, tileIds });
    }
    return;
  }

  // Select decoy
  const decoyCard = t.closest('.decoy-card');
  if (decoyCard && !t.closest('[data-action]')) {
    dispatch({ type: 'SET_SELECTION', selection: { type: 'decoy', decoyId: decoyCard.dataset.decoyId } });
    return;
  }

  // Select relink section
  if (t.closest('#relink-section') && !t.closest('input') && !t.closest('button')) {
    dispatch({ type: 'SET_SELECTION', selection: { type: 'relink' } });
    return;
  }

  // Cmd+click on tile input = multi-select
  const tileInput = t.closest('.tile-input');
  if (tileInput && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    dispatch({ type: 'TOGGLE_TILE_SELECTION', tileId: tileInput.dataset.tileId });
    return;
  }

  // Click row (not on input/button)
  const rowEl = t.closest('.puzzle-row');
  if (rowEl && !t.closest('input') && !t.closest('button') && !t.closest('.tile-input')) {
    dispatch({ type: 'SET_SELECTION', selection: { type: 'row', rowId: rowEl.dataset.rowId } });
    return;
  }

  // Click on background of main area = clear selection
  if (t.id === 'main-area' || t.id === 'puzzle-editor') {
    dispatch({ type: 'CLEAR_SELECTION' });
  }

  // PDL multi-select trigger toggle
  const msTrigger = t.closest('.pdl-ms-trigger');
  if (msTrigger) {
    e.stopPropagation();
    const dd = msTrigger.nextElementSibling;
    const isOpen = dd.style.display !== 'none';
    // Close all open dropdowns first
    document.querySelectorAll('.pdl-ms-dropdown').forEach(d => d.style.display = 'none');
    if (!isOpen) dd.style.display = '';
    return;
  }

  // Close PDL dropdowns when clicking outside them
  if (!t.closest('.pdl-multi-select')) {
    document.querySelectorAll('.pdl-ms-dropdown').forEach(d => d.style.display = 'none');
  }
});

// Input/change events
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'search-input') return; // handled by dedicated listener

  // Row bank inline edits (work even with no puzzle loaded; modal is not part of render())
  if (t.dataset.bankField === 'category') {
    dispatch({ type: 'UPDATE_BANK_ROW_CATEGORY', bankRowId: t.dataset.bankRowId, category: t.value });
    persistRowBank();
    return;
  }
  if (t.dataset.bankField === 'tile') {
    dispatch({ type: 'UPDATE_BANK_ROW_TILE_TEXT', bankRowId: t.dataset.bankRowId, tileId: t.dataset.tileId, text: t.value });
    persistRowBank();
    return;
  }

  if (!getState().puzzle) return;
  if (isReadOnly()) return; // in-review/published puzzles are locked for writers

  // Puzzle header fields
  if (t.id === 'puzzle-date') { dispatch({ type: 'SET_DATE', date: t.value }); return; }

  // Fodder chip inline text
  if (t.dataset.fodderIdx !== undefined) {
    dispatch({ type: 'UPDATE_FODDER_TEXT', index: parseInt(t.dataset.fodderIdx), text: t.value });
    t.size = Math.max(5, t.value.length) || 5;
    return;
  }
  if (t.id === 'puzzle-name') { dispatch({ type: 'SET_NAME', name: t.value }); return; }

  // Canonical ID input with validation
  if (t.id === 'puzzle-canonical-id') {
    const val = t.value.trim();
    if (!val) {
      t.classList.remove('input-invalid');
      dispatch({ type: 'SET_CANONICAL_ID', canonicalId: null });
    } else if (CANONICAL_ID_RE.test(val)) {
      t.classList.remove('input-invalid');
      dispatch({ type: 'SET_CANONICAL_ID', canonicalId: val });
    } else {
      t.classList.add('input-invalid');
    }
    return;
  }

  // Category input
  if (t.dataset.field === 'category') {
    dispatch({ type: 'UPDATE_CATEGORY', rowId: t.dataset.rowId, category: t.value });
    return;
  }

  // Tile text
  if (t.dataset.field === 'tile') {
    dispatch({ type: 'UPDATE_TILE_TEXT', rowId: t.dataset.rowId, tileId: t.dataset.tileId, text: t.value });
    return;
  }

  // PDL selects and inputs
  handlePDLInput(t);
});

document.addEventListener('change', e => {
  const t = e.target;
  if (!getState().puzzle) return;
  handlePDLInput(t);
});

function handlePDLInput(t) {
  const pdlType = t.dataset.pdl;
  if (!pdlType) return;

  // Board themed checkbox (not a multi-select)
  if (pdlType === 'board-themed') {
    dispatch({ type: 'UPDATE_BOARD_PDL', pdl: { isThemed: t.checked } });
    return;
  }

  // Manipulation modifier single-selects (position / whole). These are <select>
  // elements (single value), not multi-select checkboxes. Merge the one changed
  // key into the existing modifiers object; drop it when cleared.
  if (pdlType === 'group-modifier' || pdlType === 'imp-col-modifier') {
    const modKey = t.dataset.modifier;
    if (pdlType === 'group-modifier') {
      const row = getState().puzzle?.rows.find(r => r.id === t.dataset.rowId);
      const next = { ...(row?.pdl?.group?.manipulationModifiers || {}) };
      if (t.value) next[modKey] = t.value; else delete next[modKey];
      dispatch({ type: 'UPDATE_GROUP_PDL', rowId: t.dataset.rowId,
                 pdl: { manipulationModifiers: Object.keys(next).length ? next : undefined } });
    } else {
      const ic = getState().puzzle?.impostorColumn?.pdl;
      const next = { ...(ic?.manipulationModifiers || {}) };
      if (t.value) next[modKey] = t.value; else delete next[modKey];
      dispatch({ type: 'UPDATE_IMPOSTOR_COLUMN_PDL',
                 pdl: { manipulationModifiers: Object.keys(next).length ? next : undefined } });
    }
    return;
  }

  // Multi-select checkbox toggle — collect all checked values in this dropdown
  if (t.type === 'checkbox' && t.closest('.pdl-ms-dropdown')) {
    const dropdown = t.closest('.pdl-ms-dropdown');
    const checked = [...dropdown.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
    const val = checked.length ? checked : null;

    if (pdlType === 'group-knowledge') dispatch({ type: 'UPDATE_GROUP_PDL', rowId: t.dataset.rowId, pdl: { knowledge: val } });
    if (pdlType === 'group-niche-knowledge') dispatch({ type: 'UPDATE_GROUP_PDL', rowId: t.dataset.rowId, pdl: { nicheKnowledge: val } });
    if (pdlType === 'group-manipulation') {
      // Changing manipulation may invalidate existing modifiers — prune them.
      const row = getState().puzzle?.rows.find(r => r.id === t.dataset.rowId);
      const modifiers = pruneModifiers(val, row?.pdl?.group?.manipulationModifiers);
      dispatch({ type: 'UPDATE_GROUP_PDL', rowId: t.dataset.rowId, pdl: { manipulation: val, manipulationModifiers: modifiers } });
    }
    if (pdlType === 'group-abstraction') dispatch({ type: 'UPDATE_GROUP_PDL', rowId: t.dataset.rowId, pdl: { abstraction: val } });
    if (pdlType === 'group-domain') dispatch({ type: 'UPDATE_GROUP_PDL', rowId: t.dataset.rowId, pdl: { knowledgeDomain: val } });

    if (pdlType === 'imp-col-knowledge') dispatch({ type: 'UPDATE_IMPOSTOR_COLUMN_PDL', pdl: { knowledge: val } });
    if (pdlType === 'imp-col-niche-knowledge') dispatch({ type: 'UPDATE_IMPOSTOR_COLUMN_PDL', pdl: { nicheKnowledge: val } });
    if (pdlType === 'imp-col-manipulation') {
      const ic = getState().puzzle?.impostorColumn?.pdl;
      const modifiers = pruneModifiers(val, ic?.manipulationModifiers);
      dispatch({ type: 'UPDATE_IMPOSTOR_COLUMN_PDL', pdl: { manipulation: val, manipulationModifiers: modifiers } });
    }
    if (pdlType === 'imp-col-abstraction') dispatch({ type: 'UPDATE_IMPOSTOR_COLUMN_PDL', pdl: { abstraction: val } });
    if (pdlType === 'imp-col-domain') dispatch({ type: 'UPDATE_IMPOSTOR_COLUMN_PDL', pdl: { knowledgeDomain: val } });

    if (pdlType === 'answr-manipulation') dispatch({ type: 'UPDATE_ANSWER_CONST_PDL', pdl: { manipulation: val } });
    if (pdlType === 'answr-knowledge') dispatch({ type: 'UPDATE_ANSWER_CONST_PDL', pdl: { knowledge: val } });

    if (pdlType === 'decoy-knowledge') dispatch({ type: 'UPDATE_DECOY_PDL', decoyId: t.dataset.decoyId, pdl: { knowledge: val } });
    if (pdlType === 'decoy-manipulation') dispatch({ type: 'UPDATE_DECOY_PDL', decoyId: t.dataset.decoyId, pdl: { manipulation: val } });
    if (pdlType === 'decoy-abstraction') dispatch({ type: 'UPDATE_DECOY_PDL', decoyId: t.dataset.decoyId, pdl: { abstraction: val } });

    if (pdlType === 'board-theme-domain') dispatch({ type: 'UPDATE_BOARD_PDL', pdl: { themeDomain: val } });
    return;
  }

  // Decoy description textarea
  if (pdlType === 'decoy-description') dispatch({ type: 'UPDATE_DECOY_PDL', decoyId: t.dataset.decoyId, pdl: { description: t.value } });
}

// ══════════════════════════════════════════
//  RESIZABLE SIDEBARS
// ══════════════════════════════════════════
function initResizableSidebars() {
  const left = document.getElementById('sidebar-left');
  const handleLeft = document.getElementById('resize-left');
  const right = document.getElementById('sidebar-right');
  const handleRight = document.getElementById('resize-right');

  function startResize(handle, sidebar, side) {
    if (!handle || !sidebar) return;
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('active');
      sidebar.style.transition = 'none';
      const startX = e.clientX;
      const startW = sidebar.getBoundingClientRect().width;

      function onMove(ev) {
        const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
        const newW = Math.max(200, Math.min(500, startW + delta));
        sidebar.style.width = newW + 'px';
      }
      function onUp() {
        handle.classList.remove('active');
        sidebar.style.transition = '';
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
      }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }

  startResize(handleLeft, left, 'left');
  startResize(handleRight, right, 'right');
}
initResizableSidebars();

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    handleSave();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    doUndo();
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault();
    doRedo();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
    e.preventDefault();
    handleNew();
  }
  if (e.key === 'Escape') {
    // Clear search if focused
    const searchEl = $('search-input');
    if (searchEl && document.activeElement === searchEl && searchEl.value) {
      searchEl.value = '';
      render();
      return;
    }
    // Close search field picker if open
    const sfd = $('search-fields-dropdown');
    if (sfd) sfd.style.display = 'none';
    dispatch({ type: 'CLEAR_SELECTION' });
    hideModal('export-modal');
    hideModal('import-modal');
    hideModal('schema-modal');
  }
});

// ── Smooth row reorder: FLIP-animated DOM swaps ──
let _drag = null;

document.addEventListener('pointerdown', e => {
  if (_chipDrag) return;
  const handle = e.target.closest('.row-drag-handle');
  if (!handle) return;
  const rowEl = handle.closest('.puzzle-row');
  if (!rowEl) return;
  e.preventDefault();

  const container = $('row-list');
  const rows = [...container.querySelectorAll('.puzzle-row')];
  const fromIdx = rows.indexOf(rowEl);

  rowEl.style.position = 'relative';
  rowEl.style.zIndex = '100';
  rowEl.style.boxShadow = '0 8px 24px rgba(0,0,0,0.15)';

  _drag = { rowEl, container, startY: e.clientY, fromIdx, currentIdx: fromIdx };
  document.body.style.cursor = 'grabbing';
  document.body.style.userSelect = 'none';
});

document.addEventListener('pointermove', e => {
  if (!_drag) return;
  e.preventDefault();
  const { rowEl, container } = _drag;
  rowEl.style.transform = `translateY(${e.clientY - _drag.startY}px)`;

  const rows = [...container.querySelectorAll('.puzzle-row')];
  const dragIdx = rows.indexOf(rowEl);
  const dragRect = rowEl.getBoundingClientRect();
  const dragMidY = dragRect.top + dragRect.height / 2;

  // Swap down
  if (dragIdx < rows.length - 1) {
    const next = rows[dragIdx + 1];
    const nextRect = next.getBoundingClientRect();
    if (dragMidY > nextRect.top + nextRect.height / 2) {
      const firstTop = nextRect.top;
      const rowBefore = rowEl.getBoundingClientRect();
      container.insertBefore(next, rowEl);
      const lastTop = next.getBoundingClientRect().top;
      next.style.transform = `translateY(${firstTop - lastTop}px)`;
      next.style.transition = '';
      next.offsetHeight;
      next.style.transition = 'transform 0.2s ease';
      next.style.transform = '';
      next.addEventListener('transitionend', () => { next.style.transition = ''; }, { once: true });
      const rowAfter = rowEl.getBoundingClientRect();
      _drag.startY += rowAfter.top - rowBefore.top;
      rowEl.style.transform = `translateY(${e.clientY - _drag.startY}px)`;
      _drag.currentIdx++;
    }
  }

  // Swap up (re-query after potential swap)
  const rows2 = [...container.querySelectorAll('.puzzle-row')];
  const dragIdx2 = rows2.indexOf(rowEl);
  if (dragIdx2 > 0) {
    const prev = rows2[dragIdx2 - 1];
    const prevRect = prev.getBoundingClientRect();
    const dragRect2 = rowEl.getBoundingClientRect();
    if (dragRect2.top + dragRect2.height / 2 < prevRect.top + prevRect.height / 2) {
      const firstTop = prevRect.top;
      const rowBefore = rowEl.getBoundingClientRect();
      container.insertBefore(rowEl, prev);
      const lastTop = prev.getBoundingClientRect().top;
      prev.style.transform = `translateY(${firstTop - lastTop}px)`;
      prev.style.transition = '';
      prev.offsetHeight;
      prev.style.transition = 'transform 0.2s ease';
      prev.style.transform = '';
      prev.addEventListener('transitionend', () => { prev.style.transition = ''; }, { once: true });
      const rowAfter = rowEl.getBoundingClientRect();
      _drag.startY += rowAfter.top - rowBefore.top;
      rowEl.style.transform = `translateY(${e.clientY - _drag.startY}px)`;
      _drag.currentIdx--;
    }
  }
});

document.addEventListener('pointerup', e => {
  if (!_drag) return;
  const { rowEl, fromIdx, currentIdx } = _drag;

  rowEl.style.transition = 'transform 0.2s ease, box-shadow 0.2s ease';
  rowEl.style.transform = '';
  rowEl.style.boxShadow = '';

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rowEl.style.position = '';
    rowEl.style.zIndex = '';
    rowEl.style.transition = '';
    rowEl.style.transform = '';
    rowEl.style.boxShadow = '';
    if (fromIdx !== currentIdx) {
      dispatch({ type: 'REORDER_ROWS', fromIndex: fromIdx, toIndex: currentIdx });
    }
  };
  rowEl.addEventListener('transitionend', cleanup, { once: true });
  setTimeout(cleanup, 300);

  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  _drag = null;
});

// ── Smooth relink chip reorder: FLIP-animated DOM swaps ──
let _chipDrag = null;

document.addEventListener('pointerdown', e => {
  if (_drag) return;
  const chip = e.target.closest('.relink-chip');
  if (!chip) return;
  if (e.target.closest('.chip-remove') || e.target.closest('.fodder-chip-input')) return;
  const container = chip.parentElement;
  if (!container || !container.classList.contains('relink-tiles')) return;
  e.preventDefault();

  const idx = parseInt(chip.dataset.relinkIdx);
  if (isNaN(idx)) return;

  chip.style.position = 'relative';
  chip.style.zIndex = '100';
  chip.style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)';

  _chipDrag = {
    chip, container,
    startX: e.clientX, startY: e.clientY,
    fromIdx: idx, currentIdx: idx,
  };
  document.body.style.cursor = 'grabbing';
  document.body.style.userSelect = 'none';
});

document.addEventListener('pointermove', e => {
  if (!_chipDrag) return;
  e.preventDefault();
  const { chip, container } = _chipDrag;
  chip.style.transform = `translate(${e.clientX - _chipDrag.startX}px, ${e.clientY - _chipDrag.startY}px)`;

  const chips = [...container.querySelectorAll('.relink-chip')];
  const dragIdx = chips.indexOf(chip);
  const dragRect = chip.getBoundingClientRect();
  const cx = dragRect.left + dragRect.width / 2;
  const cy = dragRect.top + dragRect.height / 2;

  // Swap forward
  if (dragIdx < chips.length - 1) {
    const next = chips[dragIdx + 1];
    const nr = next.getBoundingClientRect();
    const nCX = nr.left + nr.width / 2;
    const nCY = nr.top + nr.height / 2;
    const sameRow = cy >= nr.top && cy <= nr.bottom;
    const shouldSwap = sameRow ? cx > nCX : cy > nCY;
    if (shouldSwap) {
      const firstRect = { left: nr.left, top: nr.top };
      const chipBefore = chip.getBoundingClientRect();
      // Insert next before chip (moves chip after next)
      container.insertBefore(next, chip);
      const lastRect = next.getBoundingClientRect();
      next.style.transform = `translate(${firstRect.left - lastRect.left}px, ${firstRect.top - lastRect.top}px)`;
      next.style.transition = '';
      next.offsetHeight;
      next.style.transition = 'transform 0.2s ease';
      next.style.transform = '';
      next.addEventListener('transitionend', () => { next.style.transition = ''; }, { once: true });
      const chipAfter = chip.getBoundingClientRect();
      _chipDrag.startX += chipAfter.left - chipBefore.left;
      _chipDrag.startY += chipAfter.top - chipBefore.top;
      chip.style.transform = `translate(${e.clientX - _chipDrag.startX}px, ${e.clientY - _chipDrag.startY}px)`;
      _chipDrag.currentIdx++;
    }
  }

  // Swap backward (re-query after potential swap)
  const chips2 = [...container.querySelectorAll('.relink-chip')];
  const dragIdx2 = chips2.indexOf(chip);
  if (dragIdx2 > 0) {
    const prev = chips2[dragIdx2 - 1];
    const pr = prev.getBoundingClientRect();
    const pCX = pr.left + pr.width / 2;
    const pCY = pr.top + pr.height / 2;
    const dragRect2 = chip.getBoundingClientRect();
    const cx2 = dragRect2.left + dragRect2.width / 2;
    const cy2 = dragRect2.top + dragRect2.height / 2;
    const sameRow = cy2 >= pr.top && cy2 <= pr.bottom;
    const shouldSwap = sameRow ? cx2 < pCX : cy2 < pCY;
    if (shouldSwap) {
      const firstRect = { left: pr.left, top: pr.top };
      const chipBefore = chip.getBoundingClientRect();
      container.insertBefore(chip, prev);
      const lastRect = prev.getBoundingClientRect();
      prev.style.transform = `translate(${firstRect.left - lastRect.left}px, ${firstRect.top - lastRect.top}px)`;
      prev.style.transition = '';
      prev.offsetHeight;
      prev.style.transition = 'transform 0.2s ease';
      prev.style.transform = '';
      prev.addEventListener('transitionend', () => { prev.style.transition = ''; }, { once: true });
      const chipAfter = chip.getBoundingClientRect();
      _chipDrag.startX += chipAfter.left - chipBefore.left;
      _chipDrag.startY += chipAfter.top - chipBefore.top;
      chip.style.transform = `translate(${e.clientX - _chipDrag.startX}px, ${e.clientY - _chipDrag.startY}px)`;
      _chipDrag.currentIdx--;
    }
  }
});

document.addEventListener('pointerup', e => {
  if (!_chipDrag) return;
  const { chip, fromIdx, currentIdx } = _chipDrag;

  chip.style.transition = 'transform 0.2s ease, box-shadow 0.2s ease';
  chip.style.transform = '';
  chip.style.boxShadow = '';

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    chip.style.position = '';
    chip.style.zIndex = '';
    chip.style.transition = '';
    chip.style.transform = '';
    chip.style.boxShadow = '';
    if (fromIdx !== currentIdx) {
      dispatch({ type: 'REORDER_RELINK_TILES', fromIndex: fromIdx, toIndex: currentIdx });
    }
  };
  chip.addEventListener('transitionend', cleanup, { once: true });
  setTimeout(cleanup, 300);

  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  _chipDrag = null;
});

// Modal overlay click to close
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.style.display = 'none';
  }
});

// beforeunload warning
window.addEventListener('beforeunload', e => {
  if (getState().isDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Filter changes
$('filter-from')?.addEventListener('change', render);
$('filter-to')?.addEventListener('change', render);

// Search input — instant filter-as-you-type
$('search-input')?.addEventListener('input', render);
$('btn-search-clear')?.addEventListener('click', () => {
  const el = $('search-input');
  if (el) { el.value = ''; render(); }
});

// Search field picker toggle & persistence
(function initSearchFields() {
  const btn = $('btn-search-fields');
  const dropdown = $('search-fields-dropdown');
  if (!btn || !dropdown) return;

  // Restore saved selections
  const saved = getSearchFields();
  if (saved) {
    dropdown.querySelectorAll('input[data-search-field]').forEach(cb => {
      cb.checked = saved.includes(cb.dataset.searchField);
    });
  }

  btn.addEventListener('click', e => {
    e.stopPropagation();
    dropdown.style.display = dropdown.style.display === 'none' ? '' : 'none';
  });
  dropdown.addEventListener('click', e => e.stopPropagation());
  dropdown.addEventListener('change', () => {
    const checked = [...dropdown.querySelectorAll('input:checked')].map(cb => cb.dataset.searchField);
    localStorage.setItem('search-fields', JSON.stringify(checked));
    render();
  });
  document.addEventListener('click', () => { dropdown.style.display = 'none'; });
})();

// Sort control
(function initSort() {
  const btn = $('btn-sort');
  const dropdown = $('sort-dropdown');
  const label = $('sort-label');
  if (!btn || !dropdown) return;

  function applySortUI() {
    const pref = getSortPref();
    if (label) label.textContent = pref.field.charAt(0).toUpperCase() + pref.field.slice(1);
    dropdown.querySelectorAll('.sort-option').forEach(b => b.classList.toggle('active', b.dataset.sort === pref.field));
    dropdown.querySelectorAll('.sort-dir').forEach(b => b.classList.toggle('active', b.dataset.dir === pref.dir));
  }
  applySortUI();

  btn.addEventListener('click', e => {
    e.stopPropagation();
    dropdown.style.display = dropdown.style.display === 'none' ? '' : 'none';
  });
  dropdown.addEventListener('click', e => {
    e.stopPropagation();
    const optBtn = e.target.closest('.sort-option');
    const dirBtn = e.target.closest('.sort-dir');
    if (!optBtn && !dirBtn) return;
    const pref = getSortPref();
    if (optBtn) pref.field = optBtn.dataset.sort;
    if (dirBtn) pref.dir = dirBtn.dataset.dir;
    localStorage.setItem('sort-pref', JSON.stringify(pref));
    applySortUI();
    render();
  });
  document.addEventListener('click', () => { dropdown.style.display = 'none'; });
})();

// Completeness filter dropdown
(function initCompletenessFilter() {
  const btn = $('btn-completeness-filter');
  const dropdown = $('completeness-dropdown');
  if (!btn || !dropdown) return;

  // Restore saved state
  const saved = getCompletenessFilters();
  dropdown.querySelectorAll('.filter-toggle').forEach(row => {
    const key = row.dataset.filter;
    const val = saved[key] || 'off';
    row.querySelectorAll('.toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.val === val));
  });

  btn.addEventListener('click', e => {
    e.stopPropagation();
    dropdown.style.display = dropdown.style.display === 'none' ? '' : 'none';
  });
  dropdown.addEventListener('click', e => {
    e.stopPropagation();
    const togBtn = e.target.closest('.toggle-btn');
    if (!togBtn) return;
    const group = togBtn.closest('.toggle-group');
    group.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    togBtn.classList.add('active');
    // Persist
    const filters = {};
    dropdown.querySelectorAll('.filter-toggle').forEach(row => {
      const key = row.dataset.filter;
      const active = row.querySelector('.toggle-btn.active');
      filters[key] = active ? active.dataset.val : 'off';
    });
    localStorage.setItem('completeness-filters', JSON.stringify(filters));
    render();
  });
  document.addEventListener('click', () => { dropdown.style.display = 'none'; });
})();

// Init flatpickr on date filters
const fpOpts = { dateFormat: 'Y-m-d', altInput: true, altFormat: 'j M Y', allowInput: false, onChange: () => render() };
if (typeof flatpickr !== 'undefined') {
  flatpickr('#filter-from', { ...fpOpts, placeholder: 'From' });
  flatpickr('#filter-to', { ...fpOpts, placeholder: 'To' });
}

// ══════════════════════════════════════════
//  ACTION HANDLERS
// ══════════════════════════════════════════

function handleNew() {
  const state = getState();
  if (state.isDirty && !confirm('You have unsaved changes. Create a new puzzle anyway?')) return;
  const puzzle = createNewPuzzle();
  puzzle.state = 'draft'; // a fresh, editable draft (persisted on first Save)
  dispatch({ type: 'SET_PUZZLE', puzzle });
}

async function handleSave() {
  const { puzzle } = getState();
  if (!puzzle) return;
  try { await savePuzzle(puzzle); }
  catch (err) { alert('Save failed: ' + err.message); }
}

async function handleSaveAs() {
  const { puzzle } = getState();
  if (!puzzle) return;
  const copy = JSON.parse(JSON.stringify(puzzle));
  copy.id = generatePuzzleId();
  dispatch({ type: 'SET_PUZZLE', puzzle: copy });
  try { await savePuzzle(copy); }
  catch (err) { alert('Save As failed: ' + err.message); }
}

// Save the latest edits, then move the puzzle into review. The DB trigger
// validates the transition; on success we reload it so the editor reflects its
// now read-only state.
async function handleSend() {
  const { puzzle } = getState();
  if (!puzzle || isReadOnly()) return;
  if (!confirm('Send this puzzle to the editor for review?\n\nYou will not be able to edit it while it is in review.')) return;
  try {
    await savePuzzle(puzzle);
    const id = getState().puzzle.serverId || getState().puzzle.id;
    await submitPuzzle(id);
    const updated = await openPuzzle(id);
    if (updated) dispatch({ type: 'SET_PUZZLE', puzzle: updated });
  } catch (err) {
    alert('Could not send to editor: ' + err.message);
  }
}

async function handleSignOut() {
  try { await signOut(); }
  finally { location.replace('platform.html'); }
}

async function handleConnect() {
  try { await connectDirectory(); }
  catch (err) {
    if (err.name !== 'AbortError') alert('Failed to connect: ' + err.message);
  }
}

async function handleOpenPuzzle(id) {
  const state = getState();
  if (state.isDirty && !confirm('You have unsaved changes. Open a different puzzle?')) return;
  try {
    const puzzle = await openPuzzle(id);
    if (puzzle) {
      dispatch({ type: 'SET_PUZZLE', puzzle });
      loadFeedback(puzzle); // fetch any editor bounce-back feedback in the background
    }
    else alert('Could not open puzzle: ' + id);
  } catch (err) { alert('Error opening puzzle: ' + err.message); }
}

async function handleDeletePuzzle(id) {
  if (!confirm(`Delete this puzzle? This cannot be undone.`)) return;
  try { await deletePuzzle(id); }
  catch (err) { alert('Delete failed: ' + err.message); }
}

async function handleDuplicatePuzzle(id) {
  try {
    const puzzle = await openPuzzle(id);
    if (!puzzle) return;
    const copy = JSON.parse(JSON.stringify(puzzle));
    copy.id = generatePuzzleId();
    copy.name = puzzle.name + ' (copy)';
    dispatch({ type: 'SET_PUZZLE', puzzle: copy });
  } catch (err) { alert('Duplicate failed: ' + err.message); }
}

function handleAddFodder() {
  dispatch({ type: 'ADD_FODDER_TILE', text: '' });
  requestAnimationFrame(() => {
    const inputs = document.querySelectorAll('.fodder-chip-input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
}

function showModal(id) { $(id).style.display = ''; }
function hideModal(id) { $(id).style.display = 'none'; }

// ══════════════════════════════════════════
//  ROW BANK
// ══════════════════════════════════════════
let _rowBankMode = 'manage';        // 'manage' | 'pick'
let _rowBankTargetRowId = null;     // puzzle row to import into (pick mode)
let _pendingImport = null;          // { targetRowId, bankRowId } awaiting displace choice

function openRowBankModal(mode, targetRowId = null) {
  _rowBankMode = mode;
  _rowBankTargetRowId = targetRowId;
  renderRowBankModal();
  showModal('row-bank-modal');
}

function rowBankMetaText(r) {
  const date = (r.bankedAt || '').slice(0, 10);
  if (r.bankedFrom && (r.bankedFrom.name || r.bankedFrom.puzzleId)) {
    const from = r.bankedFrom.name || r.bankedFrom.puzzleId;
    return `From ${esc(from)}${date ? ' · ' + date : ''}`;
  }
  return date ? `Saved ${date}` : 'Saved';
}

function renderRowBankModal() {
  const rows = getState().rowBank?.rows || [];
  const isPick = _rowBankMode === 'pick';
  $('row-bank-title').textContent = isPick ? 'Import a row from the bank' : 'Row Bank';
  $('row-bank-desc').textContent = isPick
    ? 'Choose a saved row to drop into this slot.'
    : 'Saved rows you can drop into any puzzle. Edit them here, or add a new one.';
  $('row-bank-add').style.display = isPick ? 'none' : '';

  const list = $('row-bank-list');
  if (!rows.length) {
    list.innerHTML = `<div class="row-bank-empty">No rows in the bank yet.${isPick ? '' : ' Use “New row”, or the bank button on a puzzle row.'}</div>`;
    return;
  }

  list.innerHTML = rows.map(r => {
    const meta = rowBankMetaText(r);
    if (isPick) {
      const tiles = r.tiles.map(t =>
        `<span class="bank-tile-chip${t.isImpostor ? ' impostor' : ''}">${esc(t.text) || '—'}</span>`).join('');
      return `<div class="bank-row-card pick" data-bank-row-id="${r.id}">
        <div class="bank-row-main">
          <div class="bank-row-cat-label">${esc(r.category) || '<em>(no category)</em>'}</div>
          <div class="bank-row-tiles-preview">${tiles}</div>
          <div class="bank-row-meta">${meta}</div>
        </div>
        <div class="bank-row-actions">
          <button class="btn-primary btn-sm" data-action="use-bank-row" data-bank-row-id="${r.id}">Use</button>
        </div>
      </div>`;
    }
    const tiles = r.tiles.map(t => `
        <div class="bank-tile-slot">
          <button class="tile-toggle impostor${t.isImpostor ? ' active' : ''}" data-bank-toggle="impostor" data-bank-row-id="${r.id}" data-tile-id="${t.id}">impostor</button>
          <input class="tile-input${t.isImpostor ? ' is-impostor' : ''}" type="text" value="${esc(t.text)}" placeholder="${t.isImpostor ? 'Impostor' : 'Tile'}" data-bank-field="tile" data-bank-row-id="${r.id}" data-tile-id="${t.id}">
        </div>`).join('');
    return `<div class="bank-row-card" data-bank-row-id="${r.id}">
      <div class="bank-row-main">
        <div class="bank-row-top">
          <input class="bank-row-category" type="text" value="${esc(r.category)}" placeholder="Category…" data-bank-field="category" data-bank-row-id="${r.id}">
          <button class="btn-icon btn-sm" data-action="delete-bank-row" data-bank-row-id="${r.id}" title="Delete from bank"><i class="fa-solid fa-trash"></i></button>
        </div>
        <div class="bank-row-tiles">${tiles}</div>
        <div class="bank-row-meta">${meta}</div>
      </div>
    </div>`;
  }).join('');
}

function handleBankRow(rowId) {
  const { puzzle } = getState();
  const row = puzzle?.rows.find(r => r.id === rowId);
  if (!row || !rowHasContent(row)) return; // never bank an empty row
  dispatch({ type: 'BANK_ROW', rowId });
  persistRowBank();
}

function handleUseBankRow(bankRowId) {
  const { puzzle } = getState();
  const targetRowId = _rowBankTargetRowId;
  const target = puzzle?.rows.find(r => r.id === targetRowId);
  if (!puzzle || !target) { hideModal('row-bank-modal'); return; }
  if (rowHasContent(target)) {
    // Target slot has content — ask what to do with it before overwriting
    _pendingImport = { targetRowId, bankRowId };
    hideModal('row-bank-modal');
    showModal('row-bank-displace-modal');
    return;
  }
  dispatch({ type: 'IMPORT_ROW', targetRowId, bankRowId });
  persistRowBank();
  hideModal('row-bank-modal');
}

function resolveDisplace(displaced) {
  hideModal('row-bank-displace-modal');
  if (!_pendingImport) return;
  dispatch({ type: 'IMPORT_ROW', targetRowId: _pendingImport.targetRowId, bankRowId: _pendingImport.bankRowId, displaced });
  persistRowBank();
  _pendingImport = null;
}

function toggleSidebar(side) {
  if (side === 'left') {
    const el = $('sidebar-left');
    el.classList.toggle('collapsed');
    $('resize-left').style.display = el.classList.contains('collapsed') ? 'none' : '';
  } else {
    const el = $('sidebar-right');
    el.classList.toggle('collapsed');
    $('resize-right').style.display = el.classList.contains('collapsed') ? 'none' : '';
  }
}

// Export handlers
async function getAllPuzzles() {
  const state = getState();
  if (!state.dirHandle) return state.puzzle ? [state.puzzle] : [];
  const puzzles = [];
  for (const entry of state.puzzleIndex.puzzles) {
    const p = await readPuzzleFile(state.dirHandle, entry.id);
    if (p) puzzles.push(p);
  }
  return puzzles;
}

function handleExportCurrentJSON() {
  const { puzzle } = getState();
  if (puzzle) { doExportCurrentJSON(puzzle); hideModal('export-modal'); }
}
async function handleExportAllJSON() {
  const all = await getAllPuzzles();
  doExportAllJSON(all); hideModal('export-modal');
}
async function handleExportPDLSummary() {
  const all = await getAllPuzzles();
  doExportPDLSummary(all); hideModal('export-modal');
}

// Import handlers
async function handleImportFile() {
  const result = $('import-result');
  try {
    const data = await uploadJSON();
    const puzzles = Array.isArray(data) ? data : [data];
    const count = await importPuzzles(puzzles);
    result.className = 'modal-import-result success';
    result.textContent = `Imported ${count} puzzle(s) successfully.`;
    result.style.display = '';
    setTimeout(() => hideModal('import-modal'), 800);
  } catch (err) {
    result.className = 'modal-import-result error';
    result.textContent = 'Import failed: ' + err.message;
    result.style.display = '';
  }
}



// ══════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════

subscribe(render);
onSchemaChange(() => render());

(async function init() {
  // The composer is the signed-in writer's portal. Require a session; the real
  // security boundary is RLS, but gate the UI too rather than flashing an empty
  // editor at a signed-out visitor.
  const session = await getSession();
  if (!session) { location.replace('platform.html'); return; }
  const emailEl = $('writer-email');
  if (emailEl) emailEl.textContent = session.user?.email || '';

  // Embedded editing (phase 6): open the one requested puzzle and hand control to
  // the host editing view. Skip the writer chrome / drafts loading entirely.
  if (IS_EMBED_EDIT) {
    document.getElementById('app')?.classList.add('embed-edit');
    try {
      const puzzle = await openPuzzle(EMBED_EDIT_ID);
      if (puzzle) dispatch({ type: 'SET_PUZZLE', puzzle });
    } catch (err) {
      console.error('Could not load the puzzle for editing:', err);
    }
    render();
    initEmbedBridge();
    return;
  }

  try { await restoreDirectory(); } // loads the writer's drafts from the database
  catch (err) { console.error('Could not load drafts:', err); }
  render();
})();

// Bridge between the embedded composer and the host editing view (same-origin
// postMessage). The host asks us to save; we report readiness, dirty state and
// save results. Saving uses the SAME db path as the writer (savePuzzle -> saveDraft)
// — RLS permits it for an editor/admin on any puzzle, with no state change.
function initEmbedBridge() {
  const post = (msg) => window.parent && window.parent.postMessage(msg, window.location.origin);

  post({ type: 'relink:ready' });

  // Mirror dirty state to the host so its Save button can enable/disable.
  let lastDirty = null;
  const notifyDirty = () => {
    const d = !!getState().isDirty;
    if (d !== lastDirty) { lastDirty = d; post({ type: 'relink:dirty', dirty: d }); }
  };
  subscribe(notifyDirty);
  notifyDirty();

  window.addEventListener('message', async (e) => {
    if (e.origin !== window.location.origin) return;
    if (!e.data || e.data.type !== 'relink:save') return;
    try {
      const { puzzle } = getState();
      if (!puzzle) { post({ type: 'relink:saved' }); return; }
      // Editor save: persist the editor-only layers (PDL, decoys, canonical id)
      // too — the writer's own Save never sets this flag.
      await savePuzzle(puzzle, { editorMeta: true });
      post({ type: 'relink:saved' });
    } catch (err) {
      post({ type: 'relink:save-error', message: err.message });
    }
  });
}

// ══════════════════════════════════════════
//  SCHEMA EDITOR
// ══════════════════════════════════════════

function renderSchemaModal() {
  const container = $('schema-fields');
  const schema = getSchemaForExport();
  container.innerHTML = SCHEMA_FIELDS.map(f => {
    const values = schema[f.key] || [];
    const tags = values.map(v =>
      `<span class="schema-tag">${esc(v)}<button class="schema-tag-remove" data-schema-key="${f.key}" data-schema-val="${esc(v)}" type="button">&times;</button></span>`
    ).join('');
    return `<div class="schema-field" data-schema-field="${f.key}">
      <div class="schema-field-label">${esc(f.label)} <span class="field-count">(${values.length})</span></div>
      <div class="schema-tags">${tags}<input class="schema-tag-input" data-schema-key="${f.key}" placeholder="Add…" type="text"></div>
    </div>`;
  }).join('');
}

// Delegated events for schema tag removal
document.addEventListener('click', e => {
  const removeBtn = e.target.closest('.schema-tag-remove');
  if (!removeBtn) return;
  const key = removeBtn.dataset.schemaKey;
  const val = removeBtn.dataset.schemaVal;
  const schema = getSchemaForExport();
  const values = (schema[key] || []).filter(v => v !== val);
  updateSchemaField(key, values);
  renderSchemaModal();
});

// Delegated keydown for adding new schema tags on Enter
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest('.schema-tag-input');
  if (!input) return;
  e.preventDefault();
  const key = input.dataset.schemaKey;
  const val = input.value.trim();
  if (!val) return;
  const schema = getSchemaForExport();
  const values = schema[key] || [];
  if (values.includes(val)) { input.value = ''; return; } // no duplicates
  updateSchemaField(key, [...values, val]);
  renderSchemaModal();
  // Re-focus the input for the same field
  const newInput = $('schema-fields').querySelector(`input[data-schema-key="${key}"]`);
  if (newInput) newInput.focus();
});

async function handleSchemaSave() {
  // Commit any uncommitted text sitting in tag inputs before saving
  for (const input of document.querySelectorAll('.schema-tag-input')) {
    const val = input.value.trim();
    if (!val) continue;
    const key = input.dataset.schemaKey;
    const schema = getSchemaForExport();
    const values = schema[key] || [];
    if (!values.includes(val)) updateSchemaField(key, [...values, val]);
  }
  const { dirHandle } = getState();
  if (dirHandle) await saveSchema(dirHandle);
  hideModal('schema-modal');
  render();
}

function handleSchemaReset() {
  resetSchemaToDefaults();
  renderSchemaModal();
}
