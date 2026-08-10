// ============================================================================
//  GUESS WHO — DATA-ACCESS LAYER  (the ONLY GW module allowed to call
//  supabase.from(...))
// ============================================================================
// Mirrors js/platform/db.js: every other Guess Who module talks to the database
// through the named functions exported here, never with its own
// supabase.from(...) call, so a future database swap touches THIS FILE ONLY.
//
// The shared Supabase singleton is imported from ./client.js — we never create a
// second client (multiple clients would each hold their own auth session and
// fight over token refresh). Row-Level Security is the real access boundary;
// these functions are the convenient app-side shape, not the security model.
// Errors are thrown (never swallowed) so callers can surface them.
// ============================================================================
import { supabase } from './client.js';

// Every Guess Who game, newest first (by game_number). Each row carries a count
// of its related gw_clues via PostgREST's embedded aggregate — returned as
// `gw_clues: [{ count }]`, which we flatten to a plain `clueCount`.
export async function listGames() {
  const { data, error } = await supabase
    .from('gw_games')
    .select('id, slug, game_number, answer, status, updated_at, gw_clues(count)')
    .order('game_number', { ascending: false });
  if (error) throw error;

  return (data || []).map((g) => ({
    id: g.id,
    slug: g.slug,
    game_number: g.game_number,
    answer: g.answer,
    status: g.status,
    updated_at: g.updated_at,
    clueCount: Array.isArray(g.gw_clues) ? (g.gw_clues[0]?.count ?? 0) : 0,
  }));
}

// One game with its clues, fetched in a single round trip via a nested select.
// Clues come back ordered by position (PostgREST orders the embedded relation
// with the `gw_clues(order)` hint). RLS decides whether the caller may read it.
export async function getGame(id) {
  const { data, error } = await supabase
    .from('gw_games')
    .select(`
      id, slug, game_number, answer, accepted_answers, gender,
      reveal_image_url, reveal_credit, read_more_url,
      status, notes, created_at, updated_at,
      gw_clues ( id, position, clue_text, image_url, credit )
    `)
    .eq('id', id)
    .order('position', { foreignTable: 'gw_clues', ascending: true })
    .single();
  if (error) throw error;

  return {
    ...data,
    accepted_answers: Array.isArray(data.accepted_answers) ? data.accepted_answers : [],
    clues: (data.gw_clues || []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
  };
}

// Next free game number = max(game_number) + 1, or 1 for the very first game.
// game_number is UNIQUE, so this is only a friendly default — the insert may
// still collide with a concurrently-created game, which createGame() surfaces.
export async function nextGameNumber() {
  const { data, error } = await supabase
    .from('gw_games')
    .select('game_number')
    .order('game_number', { ascending: false })
    .limit(1);
  if (error) throw error;
  const max = data && data.length ? (data[0].game_number ?? 0) : 0;
  return max + 1;
}

// Insert one game row and return it (including the DB-generated slug). We NEVER
// write slug / created_at / updated_at — the database owns those defaults. The
// author is stamped from the current session, not trusted from the caller.
// A duplicate game_number throws with `.code === '23505'` (Postgres
// unique_violation) so the caller can offer the next free number.
export async function createGame(fields) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('gw_games')
    .insert({ ...fields, created_by: user?.id ?? null })
    .select(`
      id, slug, game_number, answer, accepted_answers, gender,
      reveal_image_url, reveal_credit, read_more_url,
      status, notes, created_at, updated_at
    `)
    .single();
  if (error) throw error;
  return data;
}

// Save an existing game: update the game row (stamping updated_at ourselves —
// there is no DB trigger), then write all three clue rows in ONE upsert keyed on
// (game_id, position). Upsert — never delete-then-insert — so a transient
// failure can't leave the game with missing clues. `clues` is an array of three
// { clue_text, image_url, credit }; array index is the position (index 0 = 1).
export async function saveGame(id, fields, clues) {
  const { error: gameErr } = await supabase
    .from('gw_games')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (gameErr) throw gameErr;

  const rows = clues.map((c, i) => ({
    game_id: id,
    position: i + 1,
    clue_text: c.clue_text,
    image_url: c.image_url,
    credit: c.credit,
  }));
  const { error: clueErr } = await supabase
    .from('gw_clues')
    .upsert(rows, { onConflict: 'game_id,position' });
  if (clueErr) throw clueErr;
}

// Move a game between draft / review / live. Status is the only content change,
// but we still stamp updated_at so the list's "last edited" stays honest.
export async function setGameStatus(id, status) {
  const { error } = await supabase
    .from('gw_games')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

