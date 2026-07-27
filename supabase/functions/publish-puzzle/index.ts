// ============================================================================
//  EDGE FUNCTION: publish-puzzle
// ============================================================================
// The GATED Puzzlr publish path (Project Brief §6). The browser calls this; it
// holds the Puzzlr API key (a secret, never shipped to the client) and calls
// Puzzlr on the caller's behalf.
//
// Everything runs under the CALLER'S session (their JWT), so Row-Level Security
// and the ready->published transition trigger are the real gate — this function
// adds the action-level checks on top:
//
//   1. Caller must be signed in (verify_jwt = true in config.toml).
//   2. Caller must be editor or admin.
//   3. The puzzle must be in `ready`.
//   4. Live-puzzle guard: refuse a today-or-earlier publish_date unless the
//      caller is admin AND explicitly passes allowLive (force-over-live is
//      admin-only, per the brief).
//
// On success it POSTs the transformed payload to Puzzlr, writes back
// puzzles.puzzlr_level_id, and transitions ready -> published (the trigger
// validates the move and records puzzle_state_history).
// ============================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import {
  extractLevelId,
  isLive,
  type LocalPuzzle,
  type LocalRelinkTile,
  type LocalRow,
  puzzleToApiData,
  writingComplete,
  writingCompleteReasons,
} from '../_shared/transform.ts';

const PUZZLR_BASE_URL = 'https://api.puzzlr.net/api/v1';
const DEFAULT_GAME_ID = '30454bd0-3a84-4ea0-8d6f-9ef560d8f31a';
// Cloudflare fronts the Puzzlr API and blocks default UAs (error 1010).
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Assemble the intermediate "local puzzle" shape (what the transform expects)
// from the normalised DB rows — the same mapping db.js does client-side.
interface DbMember {
  id: string;
  position: number;
  word: string;
  is_imposter: boolean;
  is_relink: boolean;
}
interface DbRow {
  id: string;
  position: number;
  category_text: string;
  row_members: DbMember[];
}
interface DbRelinkTile {
  position: number;
  source: 'grid' | 'fodder';
  member_id: string | null;
  text: string | null;
  join_next: boolean;
}
interface DbPuzzle {
  id: string;
  title: string | null;
  state: string;
  publish_date: string | null;
  puzzle_rows: DbRow[];
  relink_tiles: DbRelinkTile[];
}

function tablesToLocalPuzzle(p: DbPuzzle): LocalPuzzle {
  const dbRows = [...(p.puzzle_rows ?? [])].sort((a, b) => a.position - b.position);
  const memberWordById: Record<string, string> = {};

  const rows: LocalRow[] = dbRows.map((dbRow) => {
    const members = [...(dbRow.row_members ?? [])].sort((a, b) => a.position - b.position);
    const tiles = members.map((m) => {
      memberWordById[m.id] = m.word ?? '';
      return {
        text: m.word ?? '',
        isImpostor: !!m.is_imposter,
        isRelink: !!m.is_relink,
      };
    });
    return {
      position: (dbRow.position ?? 1) - 1, // schema 1..4 -> local 0..3
      category: dbRow.category_text ?? '',
      tiles,
    };
  });

  const relinkTiles: LocalRelinkTile[] = [...(p.relink_tiles ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((rt) => {
      if (rt.source === 'grid') {
        return {
          text: rt.member_id ? memberWordById[rt.member_id] ?? '' : rt.text ?? '',
          source: 'grid' as const,
          joinNext: !!rt.join_next,
        };
      }
      return { text: rt.text ?? '', source: 'fodder' as const, joinNext: !!rt.join_next };
    });

  return {
    name: p.title ?? '',
    date: p.publish_date ?? '',
    rows,
    relink: { tiles: relinkTiles, answer: '' },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return json({ error: 'Missing Authorization header.' }, 401);
  }

  // A client bound to the CALLER'S token — every DB call below runs under their
  // RLS context and their auth.uid(), so the trigger/policies are the real gate.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  let payload: { puzzleId?: string; allowLive?: boolean };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const { puzzleId, allowLive = false } = payload;
  if (!puzzleId) {
    return json({ error: 'puzzleId is required.' }, 400);
  }

  // 1. Who is calling?
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: 'Not signed in.' }, 401);
  }

  // 2. Role gate — editor or admin only.
  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .single();
  if (profErr) {
    return json({ error: `Could not read your profile: ${profErr.message}` }, 403);
  }
  const role = profile?.role;
  if (role !== 'editor' && role !== 'admin') {
    return json({ error: 'Only editors and admins can publish.' }, 403);
  }

  // 3. Load the puzzle (RLS scopes this to what the caller may read).
  const { data: puzzle, error: loadErr } = await supabase
    .from('puzzles')
    .select(
      `id, title, state, publish_date, puzzlr_level_id,
       puzzle_rows ( id, position, category_text,
                     row_members ( id, position, word, is_imposter, is_relink ) ),
       relink_tiles ( position, source, member_id, text, join_next )`,
    )
    .eq('id', puzzleId)
    .single();
  if (loadErr || !puzzle) {
    return json({ error: `Puzzle not found or not accessible.` }, 404);
  }

  if (puzzle.state !== 'ready') {
    return json(
      { error: `Puzzle must be in "ready" to publish (it is "${puzzle.state}").` },
      409,
    );
  }
  if (puzzle.puzzlr_level_id) {
    return json(
      {
        error:
          'This puzzle already has a Puzzlr level id — the API cannot update an ' +
          'existing level. Edit it in the live CMS instead.',
      },
      409,
    );
  }

  const local = tablesToLocalPuzzle(puzzle as unknown as DbPuzzle);

  // Structural guard — parity with the CLI's push refusal, but report the
  // SPECIFIC failing conditions so an editor knows exactly what to fix.
  if (!writingComplete(local)) {
    const reasons = writingCompleteReasons(local);
    return json(
      {
        error: reasons.length
          ? `Puzzle is not ready to publish: ${reasons.join('; ')}.`
          : 'Puzzle is not writing-complete.',
        reasons,
      },
      422,
    );
  }

  // 4. Live-puzzle guard. A brand-new push has no live level id, so only the
  //    local publish_date matters. Force-over-live is admin-only.
  if (isLive(puzzle.publish_date)) {
    if (role !== 'admin' || !allowLive) {
      return json(
        {
          error:
            `Refused: publish date ${puzzle.publish_date} is today or earlier ` +
            `(a LIVE slot). ${role === 'admin'
              ? 'Re-send with force to override (admin only).'
              : 'Only an admin can force-publish over a live date.'}`,
          liveGuard: true,
          isAdmin: role === 'admin',
        },
        409,
      );
    }
  }

  // 5. Build the payload and POST to Puzzlr with the SECRET key.
  const apiKey = Deno.env.get('PUZZLR_API_KEY');
  if (!apiKey) {
    return json(
      { error: 'Server is missing PUZZLR_API_KEY. Set it with `supabase secrets set`.' },
      500,
    );
  }
  const gameId = Deno.env.get('PUZZLR_GAME_ID') || DEFAULT_GAME_ID;

  const apiData = puzzleToApiData(local);
  const body: Record<string, unknown> = { gameName: gameId, data: apiData };
  if (puzzle.publish_date) body.date = puzzle.publish_date;

  let puzzlrStatus: number;
  let puzzlrBody: unknown;
  try {
    const resp = await fetch(`${PUZZLR_BASE_URL}/games/levels`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    puzzlrStatus = resp.status;
    const raw = await resp.text();
    puzzlrBody = raw ? JSON.parse(raw) : {};
  } catch (err) {
    return json({ error: `Network error reaching Puzzlr: ${String(err)}` }, 502);
  }

  const ok =
    (puzzlrStatus === 200 || puzzlrStatus === 201) &&
    (puzzlrBody as { success?: boolean })?.success !== false;
  if (!ok) {
    // A 409 from Puzzlr means the date is already taken.
    return json(
      {
        error: `Puzzlr rejected the push (HTTP ${puzzlrStatus}).`,
        puzzlrStatus,
        puzzlrBody,
      },
      502,
    );
  }

  const levelId = extractLevelId(puzzlrBody);

  // 6. Write back the level id and transition ready -> published. The trigger
  //    validates the transition (editor/admin) and records the history; RLS's
  //    editor-update policy permits the write.
  const { error: updErr } = await supabase
    .from('puzzles')
    .update({
      puzzlr_level_id: levelId,
      state: 'published',
      published_at: new Date().toISOString(),
    })
    .eq('id', puzzleId);

  if (updErr) {
    // Puzzlr has the level, but we couldn't record it locally. Surface loudly so
    // an operator can reconcile (the level exists live; the row is still `ready`).
    return json(
      {
        error:
          'Pushed to Puzzlr, but failed to record it locally: ' +
          `${updErr.message}. The level EXISTS live (id ${levelId ?? 'unknown'}); ` +
          'reconcile before re-pushing to avoid a duplicate.',
        levelId,
        pushedButNotRecorded: true,
      },
      500,
    );
  }

  return json({ ok: true, levelId, state: 'published' });
});
