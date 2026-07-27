# PDL Schema Review

> Stage 0 deliverable. Companion documents: **[pdl-glossary.md](pdl-glossary.md)** (the v4 rules, in full) and **[pdl-v4-validation.md](pdl-v4-validation.md)** (corpus-wide validation of those rules). Evidence below was produced by a 16-agent audit of all puzzles plus code-level review of the CMS and analytics pipeline; every cited example was hand-verified against the files. **Update: the v4 changes recommended here have since been adopted — schema, migration, validator, and corpus are now schemaVersion 4.**

## A. What PDL is for, and the game it describes

Relink: 4 rows × 4 tiles; three tiles per row share a **hidden** connection, the fourth is the impostor. Players (4 lives, shared across both phases) pick suspected impostors one at a time; a wrong pick costs a life and eliminates the tile; a correct pick resolves the row and **reveals** its connection (analytics/README.md:9-16). The four impostors then share a meta-connection spelled out in Phase 2 from grid tiles + fodder. One attempt per player per day.

Two facts anchor everything in this review:
1. **The connection is invisible during play.** Each row is an abductive task — from 4 tiles, hypothesise which 3 cohere. PDL describes the *designed connection*; difficulty is about how discoverable it is from tiles alone. Category text is designer metadata.
2. **PDL's purpose is objective description.** It should describe every facet of any *theoretical* puzzle — including mechanics no puzzle has used yet — with as little subjective judgement as possible. Tags are also the input to difficulty analytics, so tag noise is model noise.

Corpus at review time: 68 puzzles, 272 rows; 49 live (canonicalId), 35 with player data (~7k–18.6k players each, median 15.7k).

## B. What the current design gets right

- **The dimensional model is sound.** knowledge (what you must know) × manipulation (what was done to the words) × abstraction (how the link means) × domain (what it's about) are genuinely independent axes: 70% of rows have `manipulation: None` while abstraction spans all six values. The axes compose ("Beginning with [synonyms for happy]" = Hidden word × Synonyms) — this expressiveness is worth protecting.
- **Expressiveness-first vocabulary.** Values exist ahead of corpus need (Anagram, Reversal: zero uses in 272 rows) — correct for a language meant to describe any theoretical puzzle. Their only cost is on the difficulty side, which §E solves without deleting them.
- **Live-editable schema, derive-don't-ask automation.** The schema is user-editable in the CMS and persisted per directory; decoy type/completeness/groupsSpanned and board stats are computed, not hand-entered — the right instinct, and the model §D extends.
- **The analytics joint works.** canonicalId→level_id matching, rich row-level outcomes (per-row first-try %, wrong distributions, solve-order distributions — `analytics/scripts/lib/data.py:617-630`), and a difficulty composite that correlates ρ=−0.728 with actual solve rate; the lives-based 1–5 rating validates at ρ=0.535 predicted-vs-actual.

## C. Flaws, with verified evidence

### C1. Values exist without definitions — the central flaw
`Partial` and `Synonym substitution` are in the schema but defined **nowhere** (the pdl-tagger SKILL.md manipulation table covers only 9 of 11 values). `Loose thematic` has no operational definition; `Association` is defined only negatively ("none of the above"); `Compound` only by example. Proven consequence — identical inputs, different tags:

| Pair | Same input | Divergent tags |
|---|---|---|
| l13 r2 vs l48 r3 | **byte-identical category** `___ Line`, same mechanic | abstraction `Direct membership` vs `Shared property` |
| l61 r3 vs l66 r3 | "Beginning with [hidden X]" | abstraction `Shared property` vs `Direct membership` |
| l37 r2 vs l65 r3 | "first syllable of X" | manipulation `Hidden word` vs `Partial` |

No tagger carelessness explains byte-identical divergence; the rules underdetermined the answer. The audit found ~30 rows on the Shared-property/Direct-membership boundary alone, because *any category can be rephrased as a property* — without a precedence rule the dimension is formally undecidable for wordplay rows.

### C2. Missing master rules
Three one-sentence rules were absent, each resolving dozens of rows: (i) **evaluation order** — abstraction judged on post-manipulation concepts; (ii) **layering** — knowledge/domain describe the referent, never the encoding ("Homophones of Olympic medallists" rows split three ways across knowledge/domain/abstraction in l3/l9/l26); (iii) **None-exclusivity/cardinality** — l55 r2 shipped `['None','Plural add-delete']`; multi-tags are otherwise so rare (2 rows in the corpus, both contradictory) that analytics reads only `[0]` of every array (`data.py:107-109,184-187`) and silently discards the rest.

### C3. Convention drift without backfill
Synonym rows tag `Direct membership` almost uniformly up to ~l49, then `Synonyms` uniformly from ~l57 — the calibration note was written mid-run and earlier puzzles were never re-tagged. Hidden-word rows show a similar flip (~l44) and then flip back (l72). Result: tags are not comparable across the corpus, which silently poisons per-type difficulty estimates. **Process fix:** when a rule changes, re-audit existing tags; the upgraded validator is the gate.

### C4. Validation checked nullness only
`tools/check_pdl.py` (pre-Stage-0) verified fields were non-empty — nothing else. What shipped as a result: an invalid enum value (l57 decoy `Phrase`, not in manipulationTypes), the l55 contradiction, mixed knowledge levels (l45, l50) which SKILL.md explicitly forbids, bare-string fields (l69 decoys), and a mislabeled mechanic (l33 r3: BREAK/RECESS/BEAT hidden-word row stored as Letter add-delete). **All fixed in Stage 0**, and the validator now enforces schema membership, cardinality, None-exclusivity, array shape, and live-puzzle completeness (exit 1 on error).

### C5. Docs/code drift
`docs/domain.md` documented a per-row impostor field `realIdentityDomain` that has never existed in the CMS (legacy v1 import only). Removed in Stage 0. The hardcoded schema defaults in `js/constants.js` have also drifted behind the live `pdl-schema.json` (missing Partial, Plural add-delete, Synonym substitution, Vocabulary) — Stage 2 resyncs them.

### C6. The domain taxonomy is flat, undefined, and duplicated
18 domains with no definitions produced proven splits: anatomy tagged `Science` (l54, l61) vs `Vocabulary` (l39); fish→`Food` but butterflies→`Nature`; `Language` applied to rows with no linguistic mechanism (8+ rows). Meanwhile `Vocabulary`-vs-`Language` is a near-pure *function* of the manipulation field (per SKILL.md's own rule-of-thumb) yet manually entered — a derived field left manual will always drift. And the analytics pipeline maintains its own **second, private grouping** (`pdl_buckets.DOMAIN_BUCKET`: STEM/Humanities/Entertainment/Everyday/Language) which doesn't even include `Vocabulary` — 42 rows leak through unbucketed.

### C7. Difficulty consumption: counts, silent defaults, and two hidden disagreeing orderings
- `manipulationComplexity` / `abstractionComplexity` are binary counts of rows ≠ None / ≠ Direct membership (`data.py:101-114`). Predictive power is near-zero: puzzle-level R² = 0.069; manipComplexity r = −0.17.
- Missing PDL silently defaults to the *easiest* values ('None', 'Direct membership', 'General vocabulary') (`data.py:107-110`) — untagged puzzles bias the models toward "easy".
- An ordinality **already exists but is hidden**: `_MANIP_SCORE`/`_ABSTR_SCORE`/`_RELINK_CON_SCORE` (`metrics.py:1480-1502`), hand-coded, incomplete (Loose thematic, Multi-sense, Synonyms, Phrase silently score 0.0), stale (comment claims Homophone 72% first-try; current crosstabs say 35.6%), and in disagreement with the *second* hidden scale (`pdl_buckets.MANIPULATION_TIER` ranks Anagram hardest; `_MANIP_SCORE` ranks Hidden word hardest).
- The row-level OLS (regression.json, n=140) shows why naïve per-type estimation fails: `Plural add-delete` +40pp and `Word split` +28pp coefficients each rest on a **single row**.

## D. The proposed system (v4) — what changes and why

The complete rules live in **[pdl-glossary.md](pdl-glossary.md)**. Summary of the design and the contested rulings:

**Master rules (new):** R1 tag the mechanic, never the category phrasing (categories are hidden in play); R2 manipulation = purely *mechanical* operations, verifiable on the string without meaning — abstraction = the *semantics* of the link; R3 abstraction evaluated after the manipulation; R4 knowledge/domain rate the referent; R5 single-value knowledge/manipulation/abstraction with `None` exclusive (composites via modifiers, not multi-tags).

**Manipulation — four-family frame** (exhaustive by construction: use as-is / complete / extract / transform), with boundary rulings: shared added *word* → Compound; non-word affix/letters → Letter add-delete; per-tile completion to a retrievable known whole → Partial (**now defined**: tile is the first part of a known phrase, name, or word — "Death"→*Death & taxes*, "Manchester"→*Manchester United*, "Thatch"→*Thatcher*); fragment visible *inside* the tile → Hidden word, tile *is* the fragment → Partial (converges l37/l65). New value `Abbreviation` (3 puzzles currently force initials into Partial/Hidden word). Plural add-delete is a *transformation*, never a state (kills the l55 contradiction class). Any future mechanic (rhyme, spoonerism, cipher) slots into a family.

**Modifiers, not value-splits** (user-approved): `position` (start/middle/end — on Compound/Partial/Hidden word) and `whole` (multi-word/single word — on Partial). Splitting values (Partial-word/Partial-phrase, Compound-prefix/-suffix) would multiply the enum and fragment already-sparse difficulty data; modifiers keep the list small and become **pooled difficulty facets** ("is end-position harder?" is estimable across three values jointly). Admission rule: a modifier must be decidable by pointing at the string, and analytically motivated.

**Abstraction — seven semantic relations**, all definitions rewritten with decision rules: Direct membership (incl. the template ruling that converges the byte-identical l13/l48 pair, and the post-extraction ruling that converges l61/l66) · Shared property (nameable verifiable predicate) · Synonyms (words that mean the same thing — with the instances-of-a-broader-class counter-rule from l69) · Multi-sense · **Lexical rewrite (new)** · Association (positive definition: citable conventional link) · Loose thematic (positive definition; deliberate, sparing).

**The Synonym-substitution ruling (argued both ways, user-decided):** the l71 row ("Parody film franchises run through a thesaurus": *Aeroplane*, *Nude pistol*, *Continue*) is an operation with a recovery target — Transform-family-shaped — but it is the **only** manipulation that cannot be executed without understanding meaning. Placing it in manipulation keeps abstraction a pure relation taxonomy; placing it in abstraction keeps manipulation *mechanically verifiable end-to-end*. The user chose the second purity (the more valuable one for an objectivity-first language: every manipulation tag becomes checkable by inspection, and all semantic judgement concentrates where the decision trees live). Hence: `Synonym substitution` retired from manipulation; new wide abstraction value **`Lexical rewrite`** = component-wise lexical rewrite of a known term (synonym-rewrite canonical; antonym/translation rewrites covered). Acknowledged cost: the theoretical "rewrite × other-relation" composition can't be tagged — no corpus instance needs it.

**Considered and rejected: `categoryCryptic`.** ~10 audit flags concern category text that is itself a puzzle ("They come in pairs") — but players never see the category while solving, so it cannot modulate solve difficulty. Re-routed as reveal-clarity editorial QA, outside difficulty PDL.

**Domains:** all 18 keep definitions + referent tie-breaks (anatomy→Science; edible-species-in-culinary-frame→Food; species-as-organisms→Nature; commercial/everyday→Society). `Vocabulary`/`Language` get binding definitions now and an open option to auto-derive or merge later. Domain **groups** move into the schema and are **derived from player data** (§E) — replacing the analytics-private grouping and fixing the unbucketed-Vocabulary leak.

**Unchanged on purpose:** impostor column tagged as a fifth group; answer-construction list (with a written Compound-vs-Phrase rule: one written word vs multiword expression); decoy tags describing the *believed* false link; board fields; all auto-computed fields.

## E. Ordinality — empirically defined, honestly uncertain

Principle (user-set): difficulty orderings are **estimated from player data, not asserted**. Assertions survive only as labelled fallbacks for values with zero data, and are replaced the moment data exists. This applies to all four axes — including knowledge **domains**.

**What the data already shows** (worked example computed from `puzzle-explorer.json`, 140 dated rows, ~15.7k players/puzzle; empirical-Bayes shrinkage toward the grand mean, w = n/(n+4); CIs from pooled between-row SD 21.3pp — row count, not player count, is the binding constraint):

| Manipulation | n rows | raw first-try | shrunk | 95% CI (raw) |
|---|---|---|---|---|
| Hidden word | 10 | 40.9% | **46.1%** | [27.7, 54.1] |
| Letter add-delete | 4 | 49.8% | 54.6% | [28.9, 70.7] |
| Homophone | 1 | 35.6% | 54.6% | [−6.1, 77.3] |
| Compound | 11 | 54.7% | 55.9% | [42.2, 67.3] |
| None | 112 | 61.6% | 61.5% | [57.6, 65.5] |
| Plural add-delete | 1 | 81.0% | 63.6% | [39.3, 122.7] |
| Word split | 1 | 82.7% | 64.0% | [41.0, 124.4] |

Read: **Hidden word is credibly the hardest manipulation** (CI clear of the grand mean) — the user's intuition confirmed with data. The n=1 types shrink to "no usable evidence" instead of the OLS's fabricated +40pp coefficients. That honesty is the design goal.

| Abstraction | n | raw | shrunk | | Knowledge | n | raw | shrunk |
|---|---|---|---|---|---|---|---|---|
| Shared property | 32 | 50.6% | **51.5%** | | Specialist cultural | 11 | 40.1% | **45.2%** |
| Loose thematic | 1 | 21.8% | 51.8% | | General vocabulary | 74 | 59.5% | 59.5% |
| Multi-sense | 7 | 53.4% | 55.5% | | Common cultural | 55 | 62.9% | 62.7% |
| Association | 12 | 58.7% | 58.8% | | | | | |
| Direct membership | 83 | 62.8% | 62.7% | | | | | |
| Synonyms | 5 | 73.9% | 67.4% | | | | | |

Two findings worth flagging: **the knowledge ladder's middle rungs do not separate** (Common cultural is not behaviourally harder than General vocabulary — only Specialist separates), and **Synonyms rows are the easiest abstraction**. Both contradict assumed orderings; both are exactly why ordinality must be estimated, not asserted.

**Domains** (the user's hypothesis, tested): Sport is the hardest domain by point estimate — raw 38.3% first-try (n=3) vs Music 64.1% (n=17); shrunk 50.3% vs 63.2%. CIs still overlap ([14.2, 62.3] vs [54.0, 74.2]) — suggestive, not yet conclusive; more Sport rows would settle it. Hypothesis grouping (STEM 55.6% < Words 58.6% < Everyday/Entertainment ≈60.2% < Humanities 63.2% shrunk) shows mild separation; the final grouping should be **clustered from the data** (merge domains whose effects are indistinguishable, semantic sanity-check, re-derive as data grows) and recorded in the schema for both the CMS and `pdl_buckets` to read.

**The layered programme (Stage 3 implements):**
1. **L0 — kill the hidden scores.** Replace `_MANIP_SCORE`/`_ABSTR_SCORE`/tier tables with a generated `type-effects.json`: every schema value covered, provenance per value {empirical (n, CI) | facet-derived | asserted-fallback}, load-time completeness check against the schema vocabulary.
2. **L1 — estimation as source of truth.** Binomial mixed model on dated rows: `first_try ~ manipulation + abstraction + knowledge + domain_group + same_domain + position + (1|puzzle)`; types with n<4 pooled; EB shrinkage toward the grand mean with published weights. Caveat the model must carry: manipulation and abstraction are near-collinear in this corpus (Hidden word co-occurs with Shared property in 19/24 rows) — only commissioning off-diagonal rows (e.g. Hidden word × Direct membership) truly separates them. The worked tables above are unadjusted; the GLMM is the adjusted version.
3. **L2 — within-subject confirmation.** Plackett-Luce on within-puzzle solve order (per-player trajectories already exist in `data.py:334-455`): the 4 rows of a puzzle share the same players, so decoys, date, and audience mix cancel **by construction**; display position covaried out. Publish L1-vs-L2 rank agreement as the robustness headline — the direct answer to "the ordering may not hold under confounders".
4. **L3 — facets for values without data.** Tagged facets (modifiers + manipulation family) and derived facets (`surface_form_visible`, `transform_steps`, `phonetic_vs_orthographic`) pool sparse values: Anagram/Reversal get *data-derived* estimates through their Transform siblings before a single such row ships. Interactions with what the player has seen (decoy-touches-row, same-domain impostor, accumulated context) are the structural answer to non-constant ordinality.
5. **Counts → loads.** Replace the binary counts with sums of estimated per-row effects in `CORR_FEATURES` and the regressions. Expected gain is modest at n=35 (R² 0.069 → ~0.1–0.18); the real win is one coherent, inspectable difficulty model instead of three disagreeing hidden ones.

## F. Adoption path

**Stage 0 (done with this review):** glossary draft; corpus-wide blind validation of it (see [pdl-v4-validation.md](pdl-v4-validation.md)); validator upgraded (membership/cardinality/exclusivity/shape/live-completeness, exit-code gating); 7 files' invalid or contradictory tags fixed (l33, l41, l45, l50, l55, l57, l69 — l72 was checked and found correct); `realIdentityDomain` doc fiction removed. **No schema, CMS, or analytics changes.**

**Stage 1 — PDL rewrite:** `pdl-schema.json` v4 (value lists, `manipulationModifiers`, domain groups), glossary adopted as canonical (SKILL.md points at it), `migratePuzzle()` v3→v4 (mechanical renames + modifier sentinels), corpus retag driven by the validation table (live puzzles first), validator v4 rules. Blast radius: schema file, SKILL.md, `js/state.js`, `tools/check_pdl.py`, all `save-data/*.json`.

**Stage 2 — CMS:** resync `js/constants.js`; register new schema keys and fix the `saveSchema` six-key clobber (`js/schema.js:107-114` must round-trip structured keys); conditional modifier dropdowns + radio-like single-select + None-exclusivity in the PDL form (`js/app.js` ~554–715, ~972); grouped domain picker; completeness counters (`js/state.js`).

**Stage 3 — analytics + dashboard:** v4 readers with no silent easy-defaults (`lib/data.py`); schema-driven domain groups (`lib/pdl_buckets.py`, delete the private map); L0–L3 estimation producing `type-effects.json` (Docker; statsmodels); delete the hidden score dicts (`lib/metrics.py:1480-1502`); counts→loads; regenerate outputs; dashboard HTML updated for per-type effects with CIs and provenance badges; deep-dive compatibility check.

Each stage gates on: validator green corpus-wide, pipeline runs end-to-end, and (Stage 3) difficulty ratings reproduce within tolerance before the counts→loads swap is switched on.
