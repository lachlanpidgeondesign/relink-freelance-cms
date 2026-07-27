#!/usr/bin/env python3
"""Rebuild puzzles-index.json from all puzzle files."""
import json
import glob
import os

PDL_SKIP_KEYS = {'completeness', 'groupsSpanned', 'description'}


def pdl_field_count(obj):
    count = 0
    for k, v in obj.items():
        if k in PDL_SKIP_KEYS:
            continue
        if v is None or v == '' or v == []:
            continue
        if isinstance(v, list) and len(v) == 0:
            continue
        count += 1
    return count


def pdl_field_total(obj):
    return sum(1 for k in obj if not k.endswith('Other') and k not in PDL_SKIP_KEYS)


def is_pdl_complete(obj):
    return pdl_field_count(obj) >= pdl_field_total(obj)


def is_puzzle_pdl_complete(p):
    rows = p.get('rows', [])
    # Check row group PDL
    for row in rows:
        group_pdl = row.get('pdl', {}).get('group', {})
        if not group_pdl or not is_pdl_complete(group_pdl):
            return False
    # Check impostor column PDL
    ic_pdl = p.get('impostorColumn', {}).get('pdl', {})
    if not ic_pdl or not is_pdl_complete(ic_pdl):
        return False
    # Check answer construction PDL
    ac_pdl = p.get('relink', {}).get('pdl', {}).get('answerConstruction', {})
    if not ac_pdl or not is_pdl_complete(ac_pdl):
        return False
    # Check decoys
    for d in p.get('decoys', []):
        dp = d.get('pdl', {})
        if pdl_field_count(dp) < pdl_field_total(dp):
            return False
        # Lone-impostor decoy check
        tile_ids = d.get('tileIds', [])
        if len(tile_ids) == 1:
            all_tiles = [t for r in rows for t in r.get('tiles', [])]
            tile = next((t for t in all_tiles if t.get('id') == tile_ids[0]), None)
            if tile and tile.get('isImpostor'):
                return False
    return True


index = {'puzzles': []}
for f in sorted(glob.glob('save-data/l*.json'), key=lambda x: int(x.split('/l')[1].split('.')[0])):
    p = json.load(open(f))
    pid = p.get('id', os.path.basename(f).replace('.json', ''))
    rows = p.get('rows', [])
    relink = p.get('relink', {})
    tiles = relink.get('tiles', [])
    phase2 = sum(1 for t in tiles if t.get('source') == 'grid')

    # Check writing complete (mirrors js/state.js isPuzzleWritingComplete)
    writing_ok = bool(p.get('name', '').strip()) and len(rows) == 4
    if writing_ok:
        for row in rows:
            rtiles = row.get('tiles', [])
            if (not row.get('category', '').strip()
                    or len(rtiles) != 4
                    or not all(t.get('text', '').strip() for t in rtiles)
                    or sum(1 for t in rtiles if t.get('isImpostor')) != 1):
                writing_ok = False
                break
    # At least one relink tile across the whole puzzle (not per-row).
    if writing_ok and not any(t.get('isRelink') for r in rows for t in r.get('tiles', [])):
        writing_ok = False
    # An answer string OR at least one assembled relink tile with text.
    if writing_ok:
        has_answer = bool(relink.get('answer', '').strip())
        has_tiles = any(t.get('text', '').strip() for t in tiles)
        if not (has_answer or has_tiles):
            writing_ok = False

    entry = {
        'id': pid,
        'date': p.get('date', ''),
        'name': p.get('name', ''),
    }
    # canonicalId sits right after `name`, matching the CMS buildIndexEntry order.
    if p.get('canonicalId'):
        entry['canonicalId'] = p['canonicalId']
    entry['phase2TileCount'] = phase2
    entry['writingComplete'] = writing_ok
    entry['pdlComplete'] = is_puzzle_pdl_complete(p)
    entry['searchFields'] = {
        'tiles': ' '.join(t.get('text', '') for r in rows for t in r.get('tiles', [])),
        'categories': ' '.join(r.get('category', '') for r in rows),
        'answer': relink.get('answer', ''),
        'decoyDescriptions': ' '.join(d.get('pdl', {}).get('description', '') for d in p.get('decoys', [])),
    }
    index['puzzles'].append(entry)

# Preserve the existing index ordering as a stable base, then stable-sort by date
# descending — matching the CMS updateIndex (which stable-sorts the current order).
# This keeps undated puzzles in place so a rebuild is a minimal diff rather than a
# reshuffle into glob order. New puzzles (absent from the old index) append, by id.
try:
    with open('save-data/puzzles-index.json') as f:
        prev_order = {p.get('id'): i for i, p in enumerate(json.load(f).get('puzzles', []))}
except (OSError, json.JSONDecodeError):
    prev_order = {}


def _id_num(pid):
    try:
        return int(str(pid)[1:])
    except (ValueError, TypeError):
        return 1 << 30


index['puzzles'].sort(key=lambda x: (prev_order.get(x['id'], 1 << 30), _id_num(x['id'])))
index['puzzles'].sort(key=lambda x: x.get('date', ''), reverse=True)

# ensure_ascii=False keeps em-dashes/accents literal, matching the CMS JS writer
# (JSON.stringify) so a rebuild doesn't churn every non-ASCII character.
with open('save-data/puzzles-index.json', 'w') as f:
    json.dump(index, f, indent=2, ensure_ascii=False)

complete_count = sum(1 for p in index['puzzles'] if p['pdlComplete'])
print(f"Rebuilt index with {len(index['puzzles'])} puzzles ({complete_count} PDL complete)")
