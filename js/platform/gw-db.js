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
