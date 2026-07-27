// ============================================================================
//  PUZZLR PAYLOAD TRANSFORM  (TypeScript port of tools/puzzlr_api.py)
// ============================================================================
// Reference, not copy: the wire format is DECIDED by the Python tool. These
// functions reproduce `puzzle_to_api_data`, `_build_relink`, `writing_complete`
// and `is_live` exactly, operating on the same intermediate "local puzzle" shape
// the Python tool uses (rows[].tiles[], relink.tiles[]). PDL is never present in
// this shape and is never emitted — it is stripped by construction.
// ============================================================================

// Row accent colours, indexed by row position (matches the live CMS ordering).
const COLORS = ['purple', 'blue', 'green', 'yellow'];

// The intermediate shape (mirrors the local l*.json the Python tool reads).
export interface LocalTile {
  text: string;
  isImpostor?: boolean;
  isRelink?: boolean;
}
export interface LocalRow {
  position: number; // 0-based
  category: string;
  tiles: LocalTile[];
}
export interface LocalRelinkTile {
  text: string;
  source: 'grid' | 'fodder';
  joinNext?: boolean;
}
export interface LocalPuzzle {
  name: string;
  date?: string | null;
  rows: LocalRow[];
  relink: { tiles: LocalRelinkTile[]; answer?: string };
}

export interface ApiRow {
  color: string;
  connection: string;
  words: string[];
  imposter: string;
  imposterIndex: number;
}
export interface ApiRelink {
  answerWords: string[];
  connection: string;
  answerGroups?: string[][];
}
export interface ApiData {
  name: string;
  rows: ApiRow[];
  relink: ApiRelink;
}

// ── _build_relink (faithful port) ───────────────────────────────────────────
// Build the API relink blob (answerWords, connection, optional answerGroups)
// from the local ordered relink tiles, honouring joinNext compounds. One `{}`
// per GROUP (a run of grid tiles joined by joinNext); fodder renders as literal
// text; adjacent group placeholders have no space between them; fodder is
// space-separated from neighbours. answerGroups only when a real compound exists.
export function buildRelink(puzzle: LocalPuzzle): ApiRelink {
  const tiles = puzzle.relink?.tiles ?? [];
  const answerWords: string[] = [];
  const groups: string[][] = [];
  const tokens: Array<['group', null] | ['fodder', string]> = [];
  let cur: string[] = [];

  for (const t of tiles) {
    const text = t.text ?? '';
    if (t.source === 'grid') {
      answerWords.push(text);
      cur.push(text);
      if (!t.joinNext) {
        groups.push(cur);
        tokens.push(['group', null]);
        cur = [];
      }
    } else {
      // fodder
      if (cur.length) {
        groups.push(cur);
        tokens.push(['group', null]);
        cur = [];
      }
      tokens.push(['fodder', text]);
    }
  }
  if (cur.length) {
    groups.push(cur);
    tokens.push(['group', null]);
  }

  const parts: string[] = [];
  tokens.forEach(([kind, text], i) => {
    const tok = kind === 'group' ? '{}' : (text as string);
    if (i === 0) {
      parts.push(tok);
    } else {
      const bothGroups = kind === 'group' && tokens[i - 1][0] === 'group';
      parts.push((bothGroups ? '' : ' ') + tok);
    }
  });
  const connection = parts.join('');

  const relink: ApiRelink = { answerWords, connection };
  if (groups.some((g) => g.length > 1)) {
    relink.answerGroups = groups;
  }
  return relink;
}

// ── puzzle_to_api_data (faithful port) ──────────────────────────────────────
// Convert a local puzzle into the API `data` blob (rows + relink). PDL is not in
// the input shape and is never added — this is where the "PDL is stripped" rule
// is realised.
export function puzzleToApiData(puzzle: LocalPuzzle): ApiData {
  const rowsSorted = [...(puzzle.rows ?? [])].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  );
  const apiRows: ApiRow[] = rowsSorted.map((row, i) => {
    const tiles = row.tiles ?? [];
    let impIdx = tiles.findIndex((t) => t.isImpostor);
    const impostor = impIdx >= 0 ? tiles[impIdx] : null;
    const words = tiles.filter((t) => !t.isImpostor).map((t) => t.text ?? '');
    return {
      color: i < COLORS.length ? COLORS[i] : COLORS[COLORS.length - 1],
      connection: row.category ?? '',
      words,
      imposter: impostor ? impostor.text ?? '' : '',
      imposterIndex: impIdx >= 0 ? impIdx : 0,
    };
  });
  return { name: puzzle.name ?? '', rows: apiRows, relink: buildRelink(puzzle) };
}

// ── writing_complete (faithful port) ────────────────────────────────────────
// 4 full rows, 1 impostor & a relink tile per puzzle, a non-empty answer/tiles.
export function writingComplete(puzzle: LocalPuzzle): boolean {
  if (!(puzzle.name ?? '').trim()) return false;
  const rows = puzzle.rows ?? [];
  if (rows.length !== 4) return false;
  for (const row of rows) {
    if (!(row.category ?? '').trim()) return false;
    const tiles = row.tiles ?? [];
    if (tiles.length !== 4 || !tiles.every((t) => (t.text ?? '').trim())) return false;
    if (tiles.filter((t) => t.isImpostor).length !== 1) return false;
  }
  const anyRelink = rows.some((r) => (r.tiles ?? []).some((t) => t.isRelink));
  if (!anyRelink) return false;
  const relink = puzzle.relink ?? { tiles: [] };
  const hasAnswer = !!(relink.answer ?? '').trim();
  const hasTiles = (relink.tiles ?? []).some((t) => (t.text ?? '').trim());
  return hasAnswer || hasTiles;
}

// ── writing_complete diagnostics ────────────────────────────────────────────
// Same rules as writingComplete(), but returns the SPECIFIC list of reasons a
// puzzle is not yet complete (empty array = complete). Lets the publish path
// tell an editor exactly what is missing instead of a single generic message.
export function writingCompleteReasons(puzzle: LocalPuzzle): string[] {
  const reasons: string[] = [];
  if (!(puzzle.name ?? '').trim()) reasons.push('the puzzle has no name');
  const rows = puzzle.rows ?? [];
  if (rows.length !== 4) {
    reasons.push(`there are ${rows.length} rows (need exactly 4)`);
  }
  rows.forEach((row, i) => {
    const n = i + 1;
    if (!(row.category ?? '').trim()) reasons.push(`row ${n} has no category`);
    const tiles = row.tiles ?? [];
    if (tiles.length !== 4 || !tiles.every((t) => (t.text ?? '').trim())) {
      reasons.push(`row ${n} does not have 4 filled tiles`);
    }
    const impostors = tiles.filter((t) => t.isImpostor).length;
    if (impostors !== 1) {
      reasons.push(`row ${n} has ${impostors} impostors (need exactly 1)`);
    }
  });
  const anyRelink = rows.some((r) => (r.tiles ?? []).some((t) => t.isRelink));
  if (!anyRelink) reasons.push('no tile is marked as a relink (phase-2) tile');
  const relink = puzzle.relink ?? { tiles: [] };
  const hasAnswer = !!(relink.answer ?? '').trim();
  const hasTiles = (relink.tiles ?? []).some((t) => (t.text ?? '').trim());
  if (!hasAnswer && !hasTiles) reasons.push('the relink answer is empty');
  return reasons;
}

// ── is_live (faithful port) ─────────────────────────────────────────────────
// A date string is LIVE if it is set and is today or earlier (ISO strings sort
// chronologically).
export function isLive(dateStr: string | null | undefined): boolean {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return !!dateStr && dateStr <= today;
}

// ── _extract_level_id (faithful port) ───────────────────────────────────────
export function extractLevelId(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const data = (b.data && typeof b.data === 'object' ? b.data : b) as Record<string, unknown>;
    return (
      (data.levelId as string) ||
      (data.shortId as string) ||
      (data.id as string) ||
      null
    );
  }
  return null;
}
