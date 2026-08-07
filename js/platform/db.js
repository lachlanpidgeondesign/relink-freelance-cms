// ============================================================================
//  DATA-ACCESS LAYER  (the ONLY module allowed to call supabase.from(...))
// ============================================================================
// Every other file talks to the database through the named functions exported
// here — never with its own supabase.from(...) call. This is a deliberate
// architecture choice: a future database swap (or a move to Edge Function RPCs)
// should touch THIS FILE ONLY, leaving the views and auth untouched.
//
// Table/column names follow relink_platform_schema.sql. Row-Level Security is
// the real access boundary — these functions are the convenient app-side shape,
// not the security model. Errors are thrown (never swallowed) so callers can
// surface them.
// ============================================================================
import { supabase } from './client.js';

// Writer-editable states (a writer's actionable working set) and the reviewer/
// editor queue states, per the schema's state machine and RLS policies.
export const WRITER_OPEN_STATES = ['draft', 'changes_requested'];
const QUEUE_STATES = ['submitted', 'in_review', 'changes_requested', 'ready'];

// A puzzle in one of these states is still the writer's to edit; anything else
// is read-only for them (RLS enforces this — the UI just mirrors it).
export function isEditableState(state) {
  return WRITER_OPEN_STATES.includes(state);
}

async function requireUserId() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  return user.id;
}

// ── Editor ↔ schema mapping ─────────────────────────────────────────────────
// The composer (js/app.js + js/state.js) works in one internal puzzle shape; the
// database stores the normalised tables from relink_platform_schema.sql. ALL of
// that translation lives here, so the composer never learns the table layout.
//
//   editor rows            <-> puzzle_rows   (position, category_text)
//   editor tiles           <-> row_members   (position, word, is_imposter, is_relink)
//   editor relink assembly <-> relink_tiles  (position, source, member_id, text, join_next)
//   editor name / date     <-> puzzles.title / puzzles.publish_date
// PDL and decoys are intentionally NOT mapped here (editor-only later phase).
//
// Row convention: puzzle_rows.position is 1..4 (per the schema), the editor uses
// 0..3; row_members.position is 0..3 in both. We convert on the boundary.
let _uidCounter = 0;
function uid(prefix) { return `${prefix}-${Date.now()}-${++_uidCounter}`; }

function emptyGroupPDL() {
  return { knowledge: null, manipulation: null, abstraction: null, knowledgeDomain: null, nicheKnowledge: null };
}
function emptyAnswerConstructionPDL() {
  return { manipulation: null, knowledge: null };
}
function emptyBoardPDL() {
  return { specialistGroupCount: 0, decoyCount: 0, phase2TileCount: 0, isThemed: false, themeDomain: null };
}
function emptyDecoyPDL() {
  return { knowledge: null, manipulation: null, abstraction: null, completeness: null, groupsSpanned: '', description: '' };
}
// PostgREST returns a to-one embedded relation as an object, but older/edge
// cases can hand back a single-element array — normalise both to one object.
function one(rel) {
  if (Array.isArray(rel)) return rel[0] || null;
  return rel || null;
}

function emptyEditorRow(position) {
  return {
    id: uid('row'),
    position,
    category: '',
    tiles: [0, 1, 2, 3].map(() => ({ id: uid('tile'), text: '', isImpostor: false, isRelink: false })),
    pdl: { group: emptyGroupPDL() },
  };
}

// Build the editor's internal puzzle object from the puzzles row plus (optionally)
// its nested puzzle_rows / row_members / relink_tiles. A brand-new draft with no
// rows yet gets four empty rows so the composer opens ready to author.
function tablesToEditor(p) {
  const dbRows = (p.puzzle_rows || []).slice().sort((a, b) => a.position - b.position);
  const membersById = {};

  let rows;
  if (dbRows.length) {
    rows = dbRows.map((dbRow) => {
      const members = (dbRow.row_members || []).slice().sort((a, b) => a.position - b.position);
      const tiles = members.map((m) => {
        membersById[m.id] = { word: m.word, rowId: dbRow.id };
        return { id: m.id, text: m.word || '', isImpostor: !!m.is_imposter, isRelink: !!m.is_relink };
      });
      while (tiles.length < 4) tiles.push({ id: uid('tile'), text: '', isImpostor: false, isRelink: false });
      // Group PDL is editor-only (staff read via RLS); a writer's load returns
      // no row_pdl row, so it falls back to an empty shape.
      const rowPdl = one(dbRow.row_pdl);
      return {
        id: dbRow.id,
        position: (dbRow.position ?? 1) - 1, // schema is 1..4, editor is 0..3
        category: dbRow.category_text || '',
        tiles,
        pdl: { group: { ...emptyGroupPDL(), ...(rowPdl?.group_pdl || {}) } },
      };
    });
  } else {
    rows = [0, 1, 2, 3].map(emptyEditorRow);
  }

  const relinkTiles = (p.relink_tiles || []).slice().sort((a, b) => a.position - b.position).map((rt) => {
    if (rt.source === 'grid') {
      const m = membersById[rt.member_id];
      const tile = { text: m ? m.word : (rt.text || ''), source: 'grid', sourceTileId: rt.member_id };
      if (m) tile.sourceRowId = m.rowId;
      if (rt.join_next) tile.joinNext = true;
      return tile;
    }
    const tile = { text: rt.text || '', source: 'fodder' };
    if (rt.join_next) tile.joinNext = true;
    return tile;
  });

  // Puzzle-level PDL and decoys are editor-only (RLS: staff read). For a writer's
  // load these embeds come back empty, so everything falls back to empty shapes.
  const puzzlePdl = one(p.puzzle_pdl);
  const decoys = (p.decoys || []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((d) => ({
    id: d.id,
    tileIds: Array.isArray(d.tile_member_ids) ? d.tile_member_ids.slice() : [],
    pdl: { ...emptyDecoyPDL(), ...(d.pdl || {}) },
  }));

  return {
    schemaVersion: 5,
    id: p.id,
    serverId: p.id,
    state: p.state,
    date: p.publish_date || '',
    name: p.title || '',
    canonicalId: p.puzzlr_level_id || null,
    rows,
    // relink.answer is left blank; state.js derives it from the tiles on load.
    relink: {
      tiles: relinkTiles,
      answer: '',
      pdl: { answerConstruction: { ...emptyAnswerConstructionPDL(), ...(puzzlePdl?.answer_construction || {}) } },
    },
    impostorColumn: { pdl: { ...emptyGroupPDL(), ...(puzzlePdl?.impostor_column || {}) } },
    decoys,
    board: { ...emptyBoardPDL(), ...(puzzlePdl?.board || {}) },
  };
}

// ── Writer: drafts ──────────────────────────────────────────────────────────
// Every puzzle the signed-in writer owns (any state), newest first. RLS already
// restricts this to author_id = auth.uid(); non-editable ones open read-only.
export async function getMyDrafts() {
  const authorId = await requireUserId();
  const { data, error } = await supabase
    .from('puzzles')
    .select('id, title, state, publish_date, updated_at')
    .eq('author_id', authorId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data;
}

// Load one puzzle with its rows, members and relink tiles, mapped to the editor
// shape the composer (and the play-the-puzzle component) consume. Shared by the
// writer's getDraft() and the reviewer's getPuzzleForReview(); RLS decides which
// puzzles each caller may actually read.
async function loadPuzzleFull(puzzleId) {
  const { data, error } = await supabase
    .from('puzzles')
    .select(`id, title, state, publish_date, puzzlr_level_id,
             puzzle_rows ( id, position, category_text,
                           row_members ( id, position, word, is_imposter, is_relink ),
                           row_pdl ( group_pdl ) ),
             relink_tiles ( id, position, source, member_id, text, join_next ),
             puzzle_pdl ( impostor_column, answer_construction, board ),
             decoys ( id, position, tile_member_ids, pdl )`)
    .eq('id', puzzleId)
    .single();
  if (error) throw error;
  return tablesToEditor(data);
}

// Writer: load one of the writer's own puzzles for editing.
export async function getDraft(puzzleId) {
  return loadPuzzleFull(puzzleId);
}

// Reviewer / editor / admin: load a queued puzzle so it can be played in the
// "play the puzzle" review view. Same mapped shape as getDraft; RLS scopes it to
// the puzzles the signed-in staff member is allowed to see.
export async function getPuzzleForReview(puzzleId) {
  return loadPuzzleFull(puzzleId);
}

// Create a new empty draft owned by the signed-in writer (state defaults to
// 'draft'). Returns it already mapped to the editor shape, ready to author.
export async function createDraft() {
  const authorId = await requireUserId();
  const { data, error } = await supabase
    .from('puzzles')
    .insert({ author_id: authorId })
    .select('id, title, state, publish_date')
    .single();
  if (error) throw error;
  return tablesToEditor(data);
}

// Persist the editor's current puzzle into the normalised tables, leaving state
// unchanged (a Save keeps a draft a draft). Rewrites rows/members/relink wholesale
// — simplest correct approach for the POC; RLS only permits it while editable.
//
// `opts.editorMeta` (set by the platform editing view, never by the writer)
// additionally persists the EDITOR-ONLY layers — row/puzzle PDL, decoys, and the
// Puzzlr canonical id. Writers never pass it, so their save never touches those
// tables (which RLS would refuse anyway).
export async function saveDraft(puzzleId, data, opts = {}) {
  const { editorMeta = false } = opts;

  // 1. Header fields. The canonical (Puzzlr) id is an editor-only field.
  const header = { title: data.name || null, publish_date: data.date || null };
  if (editorMeta) header.puzzlr_level_id = data.canonicalId || null;
  const { error: upErr } = await supabase
    .from('puzzles')
    .update(header)
    .eq('id', puzzleId);
  if (upErr) throw upErr;

  // 2. Clear the existing content (relink first — it references members; then
  //    rows, which cascade-delete their members AND their row_pdl).
  const { error: delRelinkErr } = await supabase.from('relink_tiles').delete().eq('puzzle_id', puzzleId);
  if (delRelinkErr) throw delRelinkErr;
  const { error: delRowsErr } = await supabase.from('puzzle_rows').delete().eq('puzzle_id', puzzleId);
  if (delRowsErr) throw delRowsErr;

  const rows = (data.rows || []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (!rows.length) return { id: puzzleId };

  // 3. Insert rows, keyed back to their editor position (schema is 1..4).
  const rowPayload = rows.map((r, i) => ({
    puzzle_id: puzzleId,
    position: (r.position ?? i) + 1,
    category_text: r.category || '',
  }));
  const { data: insertedRows, error: rowErr } = await supabase
    .from('puzzle_rows').insert(rowPayload).select('id, position');
  if (rowErr) throw rowErr;
  const rowIdByPos = {};
  for (const ir of insertedRows) rowIdByPos[ir.position - 1] = ir.id;

  // 4. Insert members; remember which editor tile id landed at (row_id, position)
  //    so the relink tiles can point at the new member ids.
  const memberPayload = [];
  const editorTileAt = {}; // `${row_id}:${position}` -> editor tile id
  rows.forEach((r, i) => {
    const rowId = rowIdByPos[r.position ?? i];
    (r.tiles || []).forEach((t, idx) => {
      memberPayload.push({
        row_id: rowId,
        position: idx,
        word: t.text || '',
        is_imposter: !!t.isImpostor,
        is_relink: !!t.isRelink,
      });
      editorTileAt[`${rowId}:${idx}`] = t.id;
    });
  });
  const memberIdByEditorTile = {};
  if (memberPayload.length) {
    const { data: insertedMembers, error: memErr } = await supabase
      .from('row_members').insert(memberPayload).select('id, row_id, position');
    if (memErr) throw memErr;
    for (const m of insertedMembers) {
      const editorId = editorTileAt[`${m.row_id}:${m.position}`];
      if (editorId) memberIdByEditorTile[editorId] = m.id;
    }
  }

  // 5. Insert the relink assembly. Grid tiles resolve to a new member id; fodder
  //    carries literal text. A grid tile we can't resolve is skipped rather than
  //    violating the schema's grid_has_member constraint.
  const relinkPayload = [];
  (data.relink?.tiles || []).forEach((t, i) => {
    if (t.source === 'grid') {
      const memberId = memberIdByEditorTile[t.sourceTileId];
      if (!memberId) return;
      relinkPayload.push({ puzzle_id: puzzleId, position: i, source: 'grid', member_id: memberId, join_next: !!t.joinNext });
    } else {
      relinkPayload.push({ puzzle_id: puzzleId, position: i, source: 'fodder', text: t.text || '', join_next: !!t.joinNext });
    }
  });
  if (relinkPayload.length) {
    const { error: relErr } = await supabase.from('relink_tiles').insert(relinkPayload);
    if (relErr) throw relErr;
  }

  // 6. Editor-only layers: PDL (row + puzzle) and decoys. Skipped entirely for
  //    writer saves (RLS forbids these tables to writers anyway).
  if (editorMeta) {
    await saveEditorMeta(puzzleId, data, rows, rowIdByPos, memberIdByEditorTile);
  }

  return { id: puzzleId };
}

// Persist the editor-only layers: per-row group PDL, puzzle-level PDL
// (impostor-column / answer-construction / board), and decoys. Called only from
// the platform editing view (never a writer save). Old row_pdl rows are dropped
// by the puzzle_rows cascade in saveDraft; decoys and puzzle_pdl outlive it, so
// they are cleared/upserted here.
async function saveEditorMeta(puzzleId, data, rows, rowIdByPos, memberIdByEditorTile) {
  // 6a. Row group PDL — insert a row_pdl per row that carries any tags.
  const rowPdlPayload = [];
  rows.forEach((r, i) => {
    const rowId = rowIdByPos[r.position ?? i];
    const group = r.pdl?.group;
    if (rowId && group && Object.values(group).some((v) => Array.isArray(v) ? v.length : v)) {
      rowPdlPayload.push({ row_id: rowId, group_pdl: group });
    }
  });
  if (rowPdlPayload.length) {
    const { error } = await supabase.from('row_pdl').insert(rowPdlPayload);
    if (error) throw error;
  }

  // 6b. Puzzle-level PDL — one row per puzzle; upsert so it survives re-saves.
  const { error: ppErr } = await supabase.from('puzzle_pdl').upsert({
    puzzle_id: puzzleId,
    impostor_column: data.impostorColumn?.pdl || null,
    answer_construction: data.relink?.pdl?.answerConstruction || null,
    board: data.board || null,
  }, { onConflict: 'puzzle_id' });
  if (ppErr) throw ppErr;

  // 6c. Decoys — clear then re-insert, remapping the editor tile ids to the
  //     freshly-inserted member ids (unresolved tiles are dropped).
  const { error: delDecoyErr } = await supabase.from('decoys').delete().eq('puzzle_id', puzzleId);
  if (delDecoyErr) throw delDecoyErr;
  const decoyPayload = (data.decoys || []).map((d, i) => ({
    puzzle_id: puzzleId,
    position: i,
    tile_member_ids: (d.tileIds || []).map((tid) => memberIdByEditorTile[tid]).filter(Boolean),
    pdl: d.pdl || null,
  }));
  if (decoyPayload.length) {
    const { error } = await supabase.from('decoys').insert(decoyPayload);
    if (error) throw error;
  }
}

// Delete one of the writer's own drafts (RLS permits this only while editable).
// PostgREST reports a policy-blocked delete as a success with zero rows, not an
// error, so we re-read the row afterwards to tell the two apart: if it's gone
// (or was already gone) the delete stuck; if it's still there, RLS refused it
// and we surface why (its current state).
export async function deleteDraft(puzzleId) {
  const { error } = await supabase.from('puzzles').delete().eq('id', puzzleId);
  if (error) throw error;

  const { data: still, error: checkErr } = await supabase
    .from('puzzles')
    .select('id, state')
    .eq('id', puzzleId)
    .maybeSingle();
  if (checkErr) throw checkErr;
  if (still) {
    throw new Error(
      `This puzzle can't be deleted while it's "${still.state}". ` +
      `Only drafts and change-requested puzzles can be removed.`
    );
  }
}

// ── Role (cached) ───────────────────────────────────────────────────────────
// getCurrentUserRole() reads the signed-in user's row from `profiles` and
// returns their role ('writer' | 'reviewer' | 'editor' | 'admin'). The result is
// cached per user id so repeated calls (e.g. on every route decision) don't
// refetch. Call clearRoleCache() on sign-out.
let _roleCache = { userId: null, role: null };

export async function getCurrentUserRole() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  if (_roleCache.userId === user.id && _roleCache.role) return _roleCache.role;

  const { data, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (error) throw error;

  _roleCache = { userId: user.id, role: data.role };
  return data.role;
}

export function clearRoleCache() {
  _roleCache = { userId: null, role: null };
}

// ── Admin: user & role management ────────────────────────────────────────────
// The set of assignable roles, in ascending privilege order. Shared with the
// admin UI so the dropdowns and the schema's user_role enum stay in lockstep.
export const USER_ROLES = ['writer', 'reviewer', 'editor', 'admin', 'guess_who_writer'];

// supabase.functions.invoke() surfaces a non-2xx as a FunctionsHttpError whose
// real JSON body ({ error }) hangs off error.context — dig out the message so
// callers see the true reason, not a generic "non-2xx status code".
async function unwrapFunctionError(error) {
  let detail = error.message;
  try {
    const body = await error.context?.json?.();
    if (body?.error) detail = body.error;
  } catch { /* keep the generic message */ }
  return new Error(detail);
}

// List every user (email, role, join date). Admin-only: emails live in
// auth.users, so this goes through the admin-gated `admin-list-users` Edge
// Function (service-role) rather than a direct table read.
export async function listUsers() {
  const { data, error } = await supabase.functions.invoke('admin-list-users');
  if (error) throw await unwrapFunctionError(error);
  if (data?.error) throw new Error(data.error);
  return data.users; // [{ id, email, role, created_at }]
}

// Invite a new person by email with an initial role. Admin-only: the service-role
// key the Admin API needs stays inside the Edge Function, never in the browser.
// `redirectTo` is where the invite email's link returns — this same platform page,
// which routes the invitee to the set-password screen. It must be on the project's
// Auth "Redirect URLs" allowlist.
export async function inviteUser(email, role) {
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { data, error } = await supabase.functions.invoke('admin-invite-user', {
    body: { email, role, redirectTo },
  });
  if (error) throw await unwrapFunctionError(error);
  if (data?.error) throw new Error(data.error);
  return data; // { ok, email }
}

// Create a new user with a temporary password. Admin-only. The temp password is
// returned so the admin can relay it via a second channel (Teams/Slack). The user
// is forced to change their password on first sign-in.
export async function createUser(email, role) {
  const { data, error } = await supabase.functions.invoke('admin-create-user', {
    body: { email, role },
  });
  if (error) throw await unwrapFunctionError(error);
  if (data?.error) throw new Error(data.error);
  return data; // { ok, email, tempPassword }
}

// Change a user's role. The `profiles_admin_write` RLS policy is the real gate
// (admins only); a DB trigger additionally refuses to demote the last admin. A
// blocked update surfaces as a thrown error for the UI to display.
export async function updateUserRole(userId, role) {
  if (!USER_ROLES.includes(role)) throw new Error('Invalid role.');
  const { data, error } = await supabase
    .from('profiles')
    .update({ role })
    .eq('id', userId)
    .select('id, role');
  if (error) throw new Error(error.message); // e.g. the last-admin guard
  // RLS returns SUCCESS with zero rows when the caller isn't an admin.
  if (!data || data.length === 0) throw new Error('Only admins can change roles.');
  return data[0];
}


// ── Writer: drafts ──────────────────────────────────────────────────────────
// (getMyDrafts / getDraft / createDraft / saveDraft / deleteDraft are defined
//  above, alongside the editor↔schema mapping they depend on.)

// Move a puzzle into review (draft/changes_requested -> submitted). The DB
// trigger validates the transition and writes the audit history; an illegal
// move (or one the caller isn't allowed) surfaces as a thrown error.
export async function submitPuzzle(puzzleId) {
  const { data, error } = await supabase
    .from('puzzles')
    .update({ state: 'submitted' })
    .eq('id', puzzleId)
    .select('id, state, updated_at')
    .single();
  if (error) throw error;
  return data;
}

// ── Reviewer / editor / admin: queue ────────────────────────────────────────
// The review pipeline. RLS decides exactly which rows each staff role sees
// (reviewers see the active pipeline; editors/admin see everything); this
// returns the in-flight states in oldest-first order so the queue drains fairly.
// The claimer's display name is embedded so the queue can show who is on each
// in-review puzzle.
export async function getQueue() {
  const { data, error } = await supabase
    .from('puzzles')
    .select(`id, title, state, publish_date, author_id, claimed_by, updated_at,
             author:profiles!author_id ( display_name ),
             claimer:profiles!claimed_by ( display_name )`)
    .in('state', QUEUE_STATES)
    .order('updated_at', { ascending: true });
  if (error) throw error;
  return data;
}

// ── Reviewer / editor / admin: review actions ───────────────────────────────
// Each of these fires a state transition. The DB trigger validate_puzzle_transition
// is the real gate: an illegal move (wrong state, wrong role) is raised as an
// error, which we let propagate so the view can show it verbatim.

// Claim a submitted puzzle: submitted -> in_review, and record who is on it.
export async function claimPuzzle(puzzleId) {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from('puzzles')
    .update({ state: 'in_review', claimed_by: userId })
    .eq('id', puzzleId)
    .select('id, state, claimed_by, updated_at')
    .single();
  if (error) throw error;
  return data;
}

// Approve a claimed puzzle: in_review -> ready.
export async function markReady(puzzleId) {
  const { data, error } = await supabase
    .from('puzzles')
    .update({ state: 'ready' })
    .eq('id', puzzleId)
    .select('id, state, updated_at')
    .single();
  if (error) throw error;
  return data;
}

// Publish a `ready` puzzle to the live Puzzlr CMS (ready -> published).
//
// The push does NOT happen from the browser: this calls the `publish-puzzle`
// Edge Function, which holds the Puzzlr API key (a server-side secret, never
// shipped to the client) and does the POST on our behalf. The function re-checks
// the caller is editor/admin and the puzzle is `ready`, enforces the live-date
// guard, transforms the puzzle to the Puzzlr payload (stripping PDL), writes back
// puzzlr_level_id and flips the state — all under the caller's own RLS context.
//
// `allowLive` is the admin-only force-over-live escape hatch (ignored by the
// function for non-admins). Resolves to { levelId, state } on success; a refusal
// or a Puzzlr error is thrown with the function's message so the UI can show it.
export async function publishPuzzle(puzzleId, { allowLive = false } = {}) {
  const { data, error } = await supabase.functions.invoke('publish-puzzle', {
    body: { puzzleId, allowLive },
  });

  // A non-2xx from the function arrives as a FunctionsHttpError whose real body
  // (our { error, ... } JSON) is on error.context — dig it out so the caller
  // sees the actual reason, not a generic "non-2xx status code".
  if (error) {
    let detail = error.message;
    let liveGuard = false;
    let isAdmin = false;
    try {
      const body = await error.context?.json?.();
      if (body?.error) detail = body.error;
      liveGuard = !!body?.liveGuard;
      isAdmin = !!body?.isAdmin;
    } catch { /* keep the generic message */ }
    const e = new Error(detail);
    e.liveGuard = liveGuard;
    e.isAdmin = isAdmin;
    throw e;
  }
  if (data?.error) {
    const e = new Error(data.error);
    e.liveGuard = !!data.liveGuard;
    e.isAdmin = !!data.isAdmin;
    throw e;
  }
  return data; // { ok, levelId, state }
}

// Admin fast-track: take a puzzle the admin AUTHORED all the way from draft to
// live in one go, by walking the ordinary transitions in order
// (draft/changes_requested -> submitted -> in_review -> ready -> published). It
// is not a new transition and grants no new power — each step is the same
// RLS/trigger-gated move the review pipeline uses, just run back-to-back so an
// admin authoring their own level need not shepherd it through the queue by hand.
//
// Because the steps are separate updates, a failure part-way leaves the puzzle in
// whatever state it reached (resumable from the Queue). We surface which step
// failed so the UI can say so; the final publish keeps publishPuzzle's liveGuard/
// isAdmin flags intact for the force-over-live retry.
export async function fastTrackPublish(puzzleId, { allowLive = false } = {}) {
  // Where are we starting from? Only the two author states are valid entry points.
  const { data: cur, error: readErr } = await supabase
    .from('puzzles')
    .select('state')
    .eq('id', puzzleId)
    .single();
  if (readErr) throw readErr;

  const startedFrom = cur.state;
  if (!['draft', 'changes_requested'].includes(startedFrom)) {
    throw new Error(`Fast-track can only start from a draft (this puzzle is "${startedFrom}").`);
  }

  const step = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      err.message = `${label} failed: ${err.message}`;
      throw err;
    }
  };

  await step('Submitting', () => submitPuzzle(puzzleId));
  await step('Claiming', () => claimPuzzle(puzzleId));
  await step('Marking ready', () => markReady(puzzleId));
  // publishPuzzle already throws with liveGuard/isAdmin set; let it propagate as-is
  // so the caller can offer the admin force-over-live retry.
  return publishPuzzle(puzzleId, { allowLive });
}

// Admin: delete any puzzle outright (an escape hatch for spam/mistakes, in any
// state). RLS gates this to admins via the `puzzles_admin_delete` policy; the
// cascade drops the puzzle's rows, tiles, comments and history. We re-read the
// row afterwards so a policy-blocked delete (PostgREST reports it as a success
// with zero rows, not an error) surfaces as a real error instead of a silent
// no-op — same guard as the writer's deleteDraft.
export async function adminDeletePuzzle(puzzleId) {
  const { error } = await supabase.from('puzzles').delete().eq('id', puzzleId);
  if (error) throw error;

  const { data: still, error: checkErr } = await supabase
    .from('puzzles')
    .select('id')
    .eq('id', puzzleId)
    .maybeSingle();
  if (checkErr) throw checkErr;
  if (still) throw new Error('The database refused the delete (admins only).');
}

// ── Comments (internal reviewer/editor/admin notes) ─────────────────────────
// Comments are INTERNAL only for now (writers never see them — RLS enforces
// that, hence the hard-coded 'internal' visibility and no UI toggle). A comment
// with row_id set is pinned to a specific row; row_id null is a whole-puzzle note.
export async function getComments(puzzleId) {
  const { data, error } = await supabase
    .from('comments')
    .select('id, body, row_id, created_at, author_id, author:profiles!author_id ( display_name )')
    .eq('puzzle_id', puzzleId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function addComment(puzzleId, body, rowId = null) {
  const authorId = await requireUserId();
  const text = (body || '').trim();
  if (!text) throw new Error('A comment cannot be empty.');
  const { data, error } = await supabase
    .from('comments')
    .insert({
      puzzle_id: puzzleId,
      author_id: authorId,
      body: text,
      row_id: rowId || null,
      visibility: 'internal',
    })
    .select('id, body, row_id, created_at, author_id, author:profiles!author_id ( display_name )')
    .single();
  if (error) throw error;
  return data;
}

// ── Bounce-backs (writer-facing feedback + send-back) ───────────────────────
// A bounce-back is a formal, writer-facing decision: it records the feedback and
// moves the puzzle back to the writer. bounce_backs is a HISTORY (a puzzle can be
// sent back more than once), so getBounceBacks returns every entry in order.
export async function getBounceBacks(puzzleId) {
  const { data, error } = await supabase
    .from('bounce_backs')
    .select('id, feedback, created_at, author_id, author:profiles!author_id ( display_name )')
    .eq('puzzle_id', puzzleId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

// Send a puzzle back to its author with required feedback. Fires the
// in_review -> changes_requested transition FIRST (the DB trigger validates it;
// this is the step most likely to fail, e.g. the puzzle isn't in_review), then
// records the feedback. Leading with the transition means a rejected bounce-back
// never leaves an orphan feedback row behind.
export async function bounceBack(puzzleId, feedback) {
  const authorId = await requireUserId();
  const text = (feedback || '').trim();
  if (!text) throw new Error('Bounce-back feedback is required.');

  // 1. Fire the state transition (trigger validates it).
  const { data, error } = await supabase
    .from('puzzles')
    .update({ state: 'changes_requested' })
    .eq('id', puzzleId)
    .select('id, state, updated_at')
    .single();
  if (error) throw error;

  // 2. Record the feedback.
  const { data: bb, error: bbErr } = await supabase
    .from('bounce_backs')
    .insert({ puzzle_id: puzzleId, author_id: authorId, feedback: text })
    .select('id, feedback, created_at, author_id')
    .single();
  if (bbErr) throw bbErr;

  return { bounceBack: bb, puzzle: data };
}

