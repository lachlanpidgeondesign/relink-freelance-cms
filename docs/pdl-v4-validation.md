# PDL v4 — Corpus Validation (dry-run of the glossary)

> **Status.** Stage 0 deliverable, now carried into Stage 1. This records the corpus-wide
> dry-run that tested the [pdl-glossary.md](pdl-glossary.md) rules against every puzzle before
> the schema was changed. The rules it validated have since been **adopted** (schema v4,
> `save-data/pdl-schema.json`) and the corpus is being retagged under the iterated glossary.
> Companion: [pdl-schema-review.md](pdl-schema-review.md) (the review that motivated v4).

## Why this exists

The whole point of the PDL system is **objectivity**: if two taggers, working only from a
puzzle's content and the written rules, independently arrive at the same tags, the rules are
unambiguous enough to trust. Stage 0 tested that property across the corpus and surfaced where
the rules were silent or under-determined, so the glossary could be tightened *before* any
schema change or retag.

## Method

- **Inputs.** Every puzzle was stripped of its existing tags, leaving only content a tagger
  legitimately sees: row categories, the four tiles per row (with impostor/relink flags),
  the Phase-2 answer, and decoy tile-sets. The impostor column was *not* given — taggers
  derived it from the four impostor tiles plus the answer.
- **Blind tagging.** All 68 puzzles were tagged from content alone against the draft glossary.
- **Inter-rater check.** 15 puzzles were independently double-tagged
  (l3, l10, l13, l22, l29, l37, l43, l48, l55, l61, l62, l65, l66, l71, l72) to measure agreement.
- **Convergence anchors.** Three pairs of puzzles that use the *same* mechanic in different
  surface dress were checked for identical tags.
- Every flagged or disagreeing element was reviewed by hand against the source file.

## Headline result

Inter-rater agreement on the 15 double-tagged puzzles (60 genuine-group rows):

| Dimension | Agreement |
|-----------|-----------|
| manipulation | 59/60 — 98.3% |
| knowledge | 58/60 — 96.7% |
| abstraction | 56/60 — 93.3% |
| modifiers (position + whole) | 59/60 — 98.3% |
| knowledgeDomain | 50/60 — 83.3% |
| **Overall (these five fields)** | **282/300 — 94.0%** |

- **Convergence anchors all passed:** l13 r2 / l48 r3 → *Compound + Direct membership*;
  l61 r3 / l66 r3 → *Hidden word + Direct membership*; l37 r2 / l65 r3 → *Partial + Direct membership*.
- **No off-schema values were invented.** The two values added in v4 were used spontaneously and
  correctly where needed (`Abbreviation` at l59 r2; `Lexical rewrite` at l71 r2), which is what
  motivated adding them.
- The lowest-agreement axis was **knowledgeDomain**, almost entirely on documented tie-break
  zones (see below) rather than genuine disagreement about the puzzle.

## What the dry-run changed (rulings now baked into the glossary)

The dry-run raised 27 GAP and 70 AMBIGUOUS flags, clustering into ~12 themes. Each was resolved
by a rule now in [pdl-glossary.md](pdl-glossary.md):

| Theme | Ruling adopted |
|-------|----------------|
| Compound vs Partial | Purely mechanical: the added/missing part is **identical** across all tiles → Compound (incl. `___ X` notation); it **differs** per tile → Partial. Judge the *set*, not the tile. |
| Position modifier under mixed per-tile placement | Added `mixed` to the `position` modifier; uniform → start/middle/end, else `mixed`. Modifiers extended to the impostor column. |
| Hidden word "unrelated meaning" clause | Dropped. Morphological relatedness is allowed (TEA inside *Teapot* is Hidden word); the direction rule (fragment-inside-tile = Hidden word; tile-is-fragment = Partial) decides. |
| Word split one-directional | Broadened to boundaries redrawn — split **or** fuse (Mock King → Mocking). |
| Letter add-delete | Broadened to add, remove, **or substitute** letters / a non-word affix. |
| Direct membership vs Shared property | Named **class** (tiles are instances) → Direct membership; **predicate** ("things that are/do X") → Shared property. Try Direct membership first. |
| Shared property vs Association | Predicate holds **literally and verifiably for all three** → Shared property; relation by convention/emblem/idiom, or only by shifting sense → Association. |
| knowledge aggregation | Lowest rung that suffices to **see the connection from the genuine set**, not the hardest obscure tile. `General vocabulary` broadened to metalinguistic knowledge (spelling, pronunciation, affixes, grammatical form). |
| Domain holes | Added **Military/War** and **Transport**. Tie-breaks: weather + minerals/gems → Nature; zodiac → Society; performing arts/dance → Art. |
| None vs Phrase (answer construction) | `Phrase` only for an established idiom/collocation that *is* the answer (royal flush, deep freeze); a transparent compositional label (Aeroplane Parts) → None. |
| Heterogeneous per-tile mechanics | Tag the operation ≥ 2 of 3 genuine tiles require (dominant); ties → the more transformative. |
| Synonym substitution (retired) | Removed from `manipulation` (it described a semantic relation, not a string edit); its cases become `manipulation: None` + abstraction **Lexical rewrite**. |

A handful of genuinely rare/editorial cases are documented as edge cases in the glossary rather
than given new schema values (distributive per-tile mapping onto a phrase → Association + a
description; template/placeholder answers like "Daily ___" → None; polysemy answer pivots → None
+ description).

## Tag distribution (blind pass, 256 genuine-group rows)

- **manipulation:** None 172 · Compound 30 · Hidden word 22 · Partial 17 · Letter add-delete 7 ·
  Homophone 3 · Abbreviation 3 · Word split 1 · Plural add-delete 1 · Anagram/Reversal 0.
- **abstraction:** Direct membership 168 · Shared property 44 · Synonyms 30 · Association 12 ·
  Multi-sense 1 · Lexical rewrite 1 · Loose thematic 0.
- **knowledge:** Common cultural 157 · General vocabulary 85 · Specialist cultural 14.
- **knowledgeDomain (occurrences):** Society 45 · Language 43 · Vocabulary 42 · Film-TV 31 ·
  Music 25 · Technology 19 · Science 14 · Nature 12 · Food 11 · Geography 9 · Sport 9 · Games 8 ·
  Literature 8 · Religion 7 · Maths 5 · History 3 · Art 2 · Politics 2.

`Anagram`, `Reversal` and `Loose thematic` are unused by the current corpus but retained
(expressiveness-first). Ordinality of these values is left to be **estimated from player data**
in Stage 3, not asserted here.

## Untaggable drafts

Four files are incomplete drafts and were excluded from tagging: **l52, l68, l70, l73**.

## Schema v4 changes this validated

- `manipulationTypes`: − `Synonym substitution`, + `Abbreviation`.
- `abstractionLevels`: + `Lexical rewrite`.
- `knowledgeDomains`: + `Military/War`, + `Transport`.
- `impostorColumnManipulationTypes`: + `Partial`.
- New structured keys: `manipulationModifiers` (`position`: start/middle/end/mixed → Compound/Partial/Hidden word; `whole`: multi-word/single word → Partial) and `knowledgeDomainGroups` (STEM / Humanities / Entertainment / Everyday / Words — provisional, re-derived from data in Stage 3).

## Status and next steps

Stage 1 schema, migration (`v3 → v4`), validator (`tools/check_pdl.py`), the `pdl-tagger` skill,
and a minimal analytics-compat patch are in place. The corpus is being retagged under the
iterated glossary; the retag is gated by the convergence anchors, `check_pdl.py` passing with
zero errors, and a human review of the `save-data` diff before commit.
