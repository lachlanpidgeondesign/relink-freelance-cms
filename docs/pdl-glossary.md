# PDL Glossary — v4

> **Status: ADOPTED (schemaVersion 4).** This is the canonical tagging rulebook. The schema (`save-data/pdl-schema.json`), the CMS migration (`v3 → v4`), the validator (`tools/check_pdl.py`), and the corpus (`save-data/l*.json`) all implement it. See `docs/pdl-schema-review.md` for the review that motivated v4 and `docs/pdl-v4-validation.md` for the corpus-wide validation. The `pdl-tagger` skill defers to this file.

PDL describes every facet of a puzzle as **objectively** as possible. Every field and every value below has a definition and a decision rule, so that two taggers (human or AI) reach the same tag from the same input. Where a judgement call used to exist, this glossary contains a ruling.

---

## 0. Master rules (read first — they resolve most disputes)

**R1 — The connection is hidden during play.** Players see only tiles; the category text is revealed when a row resolves. Therefore: tag the **mechanic**, never the category phrasing. "Kinds of artist" and "___ artist" describe the same row and must get the same tags. No tag may presuppose the player reads the category.

**R2 — Form vs meaning.** `manipulation` records **purely mechanical operations** on the tile string — executable and verifiable without understanding meaning (attach, extract, rearrange, inflect, sound out). `abstraction` records the **semantic relation** of the link. The test: *did solving need scissors-and-glue on the string, or did it need to know what the words mean?* If an apparent "operation" requires a thesaurus or dictionary sense, it belongs in abstraction (see `Lexical rewrite`, `Multi-sense`, `Synonyms`).

**R3 — Order of evaluation.** Identify the manipulation first. Then evaluate abstraction on the **post-manipulation concepts**: "once the operation is applied, how do the surfaced concepts relate to the connection?" (Example: "Beginning with evergreen trees" — extract *Spruce*, *Holly*, *Fir* first; those ARE evergreen trees → `Direct membership`, not `Shared property`.)

**R4 — Layering: tag the referent.** `knowledge` and `knowledgeDomain` describe the **referent** — what the required knowledge is *about* — never the encoding. "Homophones of Olympic medallists" → domain `Sport`, knowledge per the medallists' fame; the homophone lives in `manipulation`. One sentence, resolves dozens of rows.

**R5 — Cardinality.** `knowledge`, `manipulation`, `abstraction`: **exactly one value**; `None` never co-occurs with another value. `knowledgeDomain`: multiple values allowed (genuinely cross-domain referent sets), no duplicates. Composite mechanics are expressed through modifiers (§2), never multi-tags.

**R6 — Mixed per-tile mechanics.** A row's `manipulation`/`abstraction` describes the **three genuine tiles** as a group. If they are not uniform, tag the operation/relation that **at least two of the three** require; if all three differ, prefer the more transformative one, and use `position: mixed` (§2) where positions differ. Genuinely mixed rows are rare and flagged for editorial review; the dominant-of-three rule keeps tagging deterministic rather than forcing an impossible single label.

---

## 1. `manipulation` — the mechanical operation (row group; same list for decoys)

Decision procedure — ask in order: **does the player (a) use the tile as-is, (b) add material, (c) take part of it, or (d) mutate it in place?** These four families are exhaustive; pick the family, then the value. Any future mechanic (rhyme, spoonerism, cipher, cross-tile initials) joins a family as a new sibling value.

### Family: USE AS-IS

**`None`** — nothing is done to the tile's form. The link runs entirely through meaning (which abstraction describes).
*Decision rule:* if you can state the connection without quoting any altered, completed, or dismembered version of the tile string, manipulation is None.
*Examples:* l10 r0 "Filed documents" (Records, Log, Index — used at face value). Company names used as companies. Synonym rows (l71 r1: Consciously uncouple / Parts / Dump). Lexical-rewrite rows (l71 r2 — the rewrite is semantic, not mechanical).
*Near-miss:* tiles that merely *are* plural ("Analogue camera components in plural") are None — plurality is a property, not an operation (see Plural add-delete).

### Family: COMPLETE — the tile is part of a larger whole; the player adds material

The Compound / Partial / Letter add-delete split inside this family is decided by **one mechanical test — is the missing (added) part identical across all three genuine tiles?**

**`Compound`** — every tile completes with the **same added word** to form compounds or set expressions.
*Decision rule (identical-part test):* the missing/added string is **identical across all tiles** and is itself a word ("Finish/Dead/Touch" + *Line*; "Tea/Neti/Crock" → "___ Pot" = Teapot/Neti pot/Crockpot). The `___ X` (or `X ___`) category notation is **always Compound** — the fixed word is the constant missing part. Record `position` (§2): where the **tile** sits in the formed compound (tile first = start, as in "___ Line"; shared word first = end, as in "Back ___" → Backboard).
*Examples:* l13 r2 / l48 r3 "___ Line"; l71 r3 "Back ___" (Board/Splash/Ache, position=end); l28 ("Johnny ___"), l45 r1 ("Summer ___"), l63 r0 ("Five ___") — one shared added word, so all Compound.
*Near-misses:* the same added part is a **non-word affix** ("B + old/rash", "add *in-* for the antonym") → `Letter add-delete`. The added part **differs per tile** (Tea→Tea*pot*, Sauce→Sauce*pan*, Dutch→Dutch *oven*) → `Partial`. A category merely *naming* the compound set semantically ("Kinds of artist" for X+artist rows) is still Compound — R1.

**`Partial`** — each tile is a fragment of a larger known whole, and the **missing part differs from tile to tile** (the other branch of the identical-part test; contrast Compound, where the missing part is identical).
*Decision rule:* the player completes each tile to a retrievable known whole and the completion is **not the same string for every tile** (Tea→Tea*pot*, Sauce→Sauce*pan*, Dutch→Dutch *oven* — first words of kitchen hardware; Thatch→Thatch*er*, Church→Church*ill*, Star→Star*mer* — PM surnames). Record modifiers: `whole` = multi-word ("Death" → *Death & taxes*; "Manchester" → *Manchester United*; "Fistful" → *A Fistful of Dollars*) or single word ("Thatch" → *Thatcher*); `position` = where the tile sits in the whole (§2). Co-fragments of the *same* whole are still Partial (e.g. "Death"/"Taxes" both from *Death & taxes*).
*Examples:* l10 r3 Dollars-trilogy amounts; l37 r2 PM surnames; l65 r3 beer vessels (Tank→Tankard, Flag→Flagon, Bot→Bottle); l45 r3 first words of Christmas films.
*Near-misses:* the missing part is **identical** across tiles → `Compound` (a word) or `Letter add-delete` (a non-word affix). The relevant smaller string is visible INSIDE the displayed tile, residue discarded → `Hidden word` (direction rule: tile-is-fragment = Partial; word-inside-tile = Hidden word). Initials → `Abbreviation`.

**`Abbreviation`** — the tile is an initialism/abbreviation the player expands (or the connection requires contracting to initials).
*Decision rule:* the operation is expansion/contraction of initials or standard abbreviations (JRR → J. R. R. Tolkien's initials; Dr → Doctor).
*Example:* l59 r2 "Initials used by fantasy authors".
*Near-miss:* a fragment that is not an initialism ("Thatch") → `Partial`.

### Family: EXTRACT — the link is inside the tile; the player takes part of it

**`Hidden word`** — a recognizable word sits embedded inside the tile text; the player finds it and discards the rest.
*Decision rule:* a word is visible inside the displayed string; keep it, discard the residue. The embedded word **may be morphologically or etymologically related** to the tile (TEA inside *Teapot*, BREAK inside *Break dancing*, HELIOS inside *Heliosphere*) — relatedness does **not** disqualify; the test is purely the extract-and-discard mechanic. Record `position` (start/middle/end of the tile). Crossing word boundaries is fine ("…ALE rt").
*Examples:* l61 r3 "Beginning with drinks" (ALErt, TEAms, GINger — position=start); l66 r3 evergreen trees (SPRUCE up, HOLLY Willoughby, FIRst — position=start); "Ending in body parts" rows (position=end).
*Near-misses:* the tile itself is the fragment to be completed → `Partial`. The whole tile decomposes with nothing discarded → `Word split`. A single letter removed/added → `Letter add-delete`.

**`Word split`** — the tile's internal word boundaries are **redrawn** — split apart or fused together — with nothing discarded.
*Decision rule:* every letter of the tile is reused; only the spacing changes ("Flagon" → "Flag on"; "Mock King" → "Mocking"). Splitting and fusing are the same operation in two directions.
*Near-miss:* if material is discarded after extraction, it's `Hidden word`.

### Family: TRANSFORM — the tile mutates in place

**`Homophone`** — the link appears when the tile is **sounded out** (phonological, not semantic).
*Decision rule:* spoken form maps to a different written word ("Flours" → *Flowers*). The presence of homonyms in tiles used at face value is NOT Homophone — the puzzle must require phonetic interpretation.
*Example:* l9 r2 "Homophones for Valentine's gifts".

**`Rhyme`** — the link appears when the tile is **sounded out** and *rhymes with* the target (phonological, a partial sound match — not a full homophone).
*Decision rule:* the tile shares the target's rhyming portion (the stressed vowel and what follows) but is a different word; the surface spelling need not match the rhyme. "Clay" rhymes with *May*; "Starch" rhymes with *March*; "Remember" rhymes with the *-ember* months. Distinct from `Homophone`, where the spoken form is the *same* as another whole word — a rhyme matches only the ending sound. The category typically names the rhyme target ("Rhyming with months"). Rhyme takes no `position` modifier (the whole tile is sounded out, as with Homophone).
*Example:* l91 r2 "Rhyming with months" (Clay, Starch, Remember).

**`Anagram`** — all letters rearranged to form the linked word. *(No corpus uses yet — defined ahead of need.)*

**`Reversal`** — the tile read backwards yields the linked word. *(No corpus uses yet.)*

**`Cipher`** — the tile is written in a **named, rule-governed code or cipher**; the player recognises the encoding (and optionally decodes it) to reach the link. The **whole** tile is transformed by a systematic scheme — symbol substitution (Morse, Braille), structured letter-movement (Pig Latin), or glyph/number substitution (Leetspeak) — not a single ad-hoc letter edit.
*Decision rule:* a known encoding maps the tile string to/from plain text by a rule you could name ("it's Morse", "it's leetspeak"). Use Cipher when the operation is *apply/undo a code*, not *add or swap a stray letter* (`Letter add-delete`), *sound it out* (`Homophone`), *rearrange every letter ad-hoc* (`Anagram`), or *read backwards* (`Reversal`). Cipher takes no `position` modifier (the whole tile is encoded).
*Example:* l96 r3 "Codes in code (Morse, Pig Latin, Leetspeak)" — `-- --- .-. ... .` → MORSE, "Igpay Atinlay" → Pig Latin, "1337" → Leet (each tile is the code's own name written in that code).
*Near-misses:* a single added/removed/substituted letter or non-word affix → `Letter add-delete`. Pure backwards reading → `Reversal`. Letters rearranged with no encoding scheme → `Anagram`. Sounded-out homophone → `Homophone`.

**`Letter add-delete`** — adding, removing, or **substituting** letters or a non-word affix is the operation, with no retrievable known whole.
*Decision rule:* the changed string is not a standalone word and the result is not a per-tile known whole (which would be Partial). Covers a **shared** operation across tiles ("B + old/rash/razen"; "add *in-* to get the antonym", Finite→Infinite; change the first letter to *s*, Chips→Ships) and one-off letter surgery. A shared non-word affix is the Letter-add-delete counterpart of Compound (which uses a shared *word*).
*Near-misses:* added string is a **word** → `Compound`. Completion to a known name/title/phrase → `Partial`. Adding/removing only plural inflection → `Plural add-delete`.

**`Plural add-delete`** — the operation is adding/removing **plural inflection** to surface the link.
*Decision rule (state vs transformation):* tag this ONLY when the player must change grammatical number to reach the connection ("Collectibles in the singular" where the recognisable collectible is the plural form). If tiles merely *are* plural, or invariant plurality is the shared trait ("identical singular and plural forms"), the manipulation is **None** and the trait is `abstraction: Shared property`.

### Retired from manipulation

**`Synonym substitution`** — retired (fails the R2 mechanical test: a synonym swap requires meaning). Rows of this shape are now `manipulation: None` + `abstraction: Lexical rewrite` (§3). The schema value is removed in v4; l71 r2 re-tags on migration.

---

## 2. `manipulationModifiers` — orthogonal, string-decidable sub-tags

Admission rule for any future modifier: decidable by pointing at the string (no semantic judgement) and analytically motivated. Modifiers exist so distinctions don't multiply the value list, and so difficulty analysis can pool across values ("is end-position harder than start?" is estimable across Compound + Partial + Hidden word jointly). They apply on the row group **and** the impostor column (§6).

| Modifier | Values | Applies to | Meaning |
|---|---|---|---|
| `position` | start · middle · end · **mixed** | Compound | where the **tile** sits in the formed compound ("Backboard": tile=Board → end) |
| | | Partial | where the tile sits in the retrieved whole ("Death [& taxes]" → start) |
| | | Hidden word | where the embedded word sits in the tile ("ALErt" → start; "marshmALLOW"-type → middle/end) |
| `whole` | multi-word · single word | Partial | the retrieved whole is a phrase/name/title vs a single word |

*Mixed-position rule:* if the relevant string sits at the **same** position in all three genuine tiles, record that position; if it sits at **different** positions across tiles (embedded word at the start of one tile but the middle of another), record `mixed`. This keeps the modifier purely string-decidable and gives difficulty analysis a real signal instead of forcing a false single value.

---

## 3. `abstraction` — the semantic relation (row group; same list for decoys)

Evaluated **after** the manipulation (R3), on the relation between the surfaced concepts and the connection. Exactly one value. Decision tree — take the first that fits:

**`Direct membership`** — the surfaced concepts are literal instances/members of the connection's set.
*Decision rule:* you can phrase the connection as a named set and each surfaced concept IS one of those things. **Template/compound ruling:** completed compounds ARE members of the template set — "___ Line" rows are Direct membership (resolves l13 r2 vs l48 r3, which are byte-identical and must tag identically). **Post-extraction ruling:** hidden-word rows whose extracted items are members of a named set (drinks, trees) are Direct membership (resolves l61 r3 vs l66 r3).
*Class-vs-predicate test (Direct membership vs Shared property):* if the connection is a **plural-noun class** and each concept simply **is one of those things** — co-hyponyms of one superordinate (*beans*, *NATO letters*, *evergreen trees*, *parts of a watch face*) — use Direct membership. If the tiles are united only by a **predicate or behaviour** that is not itself a kind of thing (*things that are green*, *things that come in sevens*), use Shared property. **Try Direct membership first.**
*Examples:* l10 r1 NATO letters (Tango, Romeo, Juliett); "Types of bean"; completed "___ Line" compounds.
*Near-miss:* if the tiles aren't *things in a set* but all satisfy one predicate, that's `Shared property`.

**`Shared property`** — the surfaced concepts all satisfy one **nameable, verifiable predicate** that is the connection.
*Decision rule:* state the predicate P; check P(tile) holds for each of the 3. "Surname means fast" (l10 r2: Usain Bolt, Taylor Swift, Geoffrey Rush). "Comes in sevens" ("There's seven of them"). "Identical singular and plural forms" (invariant plurals — with manipulation None).
*Literal-satisfaction rule (Shared property vs Association):* tag Shared property only when **every** tile *literally and verifiably* satisfies P — domain-specific senses are fine if each is literal ("is hard": a diamond is physically hard, vodka is literally hard liquor, an exam is literally hard → Shared property). If **any** tile relates to the connection only by **convention, emblem, idiom, or typicality** rather than literal satisfaction, use `Association` ("is green": literal for a frog or basil, but Envy is green only by idiom → Association).
*Near-misses:* if P is just "is a member of set S", use `Direct membership`. If you cannot state a single verifiable predicate but the tiles clearly evoke a common concept, use `Association`.

**`Synonyms`** — the tiles are **words that mean the same thing** — as the connection concept, or as each other.
*Decision rule:* if the connection IS the concept the tiles mean ("Break up": Consciously uncouple, Parts, Dump — l71 r1), tag Synonyms. If the tiles are *instances of a broader class*, that's Direct membership — "Party/Tribe/Gang" are members of "groups of people", not synonyms of it (the l69 counter-example).
*Composes with manipulation:* "Beginning with words for happy" = `Hidden word` × `Synonyms` — the extraction is mechanical, the extracted words' relation is synonymy.

**`Multi-sense`** — the link rides on a **second sense** of the word(s); no change to form.
*Decision rule:* the tile, read in a different (legitimate dictionary) sense than its surface-obvious one, carries the connection. Polysemy is the relation; manipulation stays None (or whatever mechanical operation independently applies).
*Near-miss:* if a *sound-alike different word* is needed (spelling changes), that's `Homophone` (manipulation).

**`Lexical rewrite`** — the tile is a **component-wise lexical rewrite of a known term**; the player recovers the original.
*Decision rule:* each word of a known title/name/phrase has been swapped for a synonym (canonical: l71 r2 — *Aeroplane* → **Airplane!**, *Nude pistol* → **Naked Gun**, *Continue* → **Carry On**). Defined wide: antonym-rewrites and literal-translation rewrites also belong here. Distinct from `Synonyms` because the tiles don't *mean* the connection — they encode **recoverable members** of it. Manipulation is None (the rewrite is semantic — R2).

**`Association`** — the surfaced concepts relate to the connection **indirectly**: no membership, no single verifiable predicate, but a definite conventional/cultural link.
*Decision rule (positive, not residual):* each tile has an established association with the connection concept that you could cite (Crown, Throne, Palace → Monarchy: each is a standard emblem of it). If you find yourself stating a checkable predicate, go back to `Shared property`; numeric rows split exactly here ("has eight legs" = predicate → Shared property; "vaguely evokes eight" → Association).
*Near-miss:* if even the association needs explaining or feels curated rather than conventional, consider `Loose thematic`.

**`Loose thematic`** — a deliberately diffuse thematic gesture; the weakest link type.
*Decision rule:* no membership, no predicate, no citable conventional association — the tiles share only a mood/theme a solver would describe with "…sort of thing" ("Preparing for battle"-style mood sets). Use sparingly and deliberately; if you can cite a conventional association for each tile, it's `Association`.

---

## 4. `knowledge` — how much the player must know (row group, impostor column, answer construction, decoys)

Single value. Ladder — take the **lowest rung that lets you see the connection from the genuine group as a whole** (after R4: rate the **referent**). Rate the group, not the single hardest tile: if the link is recognizable from the easier members, one obscure member does not push the whole row up a rung.

**`None`** — pure logic/structure; not even word meanings needed (letter patterns, lengths).

**`General vocabulary`** — only knowledge of the English language itself: what words mean, **plus how they are spelled, pronounced, and built** (suffixes, plurals, US/UK spelling, pronunciation). Synonym/multi-sense rows with everyday words live here, as do rows whose only requirement is recognizing a spelling pattern or a sound.
*Boundary:* the moment a real-world FACT is needed (Rook is a bird; Fir is evergreen), it is at least Common cultural — even when the words are common.

**`Common cultural`** — real-world facts most UK adults have.
*Anchors:* well-known animal/plant species; world-famous brands and franchises (Disney princesses, Beatles songs, Silicon Valley firms); UK geography (port cities); NATO alphabet. *Filmography anchor:* a person's body of work is Common only if a typical pub-quiz team could name 3+ of their works (DiCaprio films → Common; Damien Chazelle films → Specialist — note this corrects an inversion in the current corpus, l42 r1 vs l72 r1).

**`Specialist cultural`** — niche knowledge most adults don't have (Baroque composers, Nobel physicists, individual albums' track lists, niche filmographies).

---

## 4b. `nicheKnowledge` — how obscure the specific tiles are (companion to `knowledge`)

Single value, ordinal. A **separate axis** from `knowledge`: that one rates *breadth* (what kind of knowledge is needed), this one rates *depth / obscurity* (how recognisable the specific tiles are within that breadth band). Two rows can both be `Common cultural` yet differ sharply — "School subjects" vs "PlayStation buttons". Tagged on **group rows** and the **impostor column** (the hidden connection); untagged elements carry the `Unrated` sentinel in analytics.

**THE GOLDEN RULE — judge the actual tiles, not the category label.** A mainstream umbrella topic is `Niche` at the tile level when the specific instances shown are deep cuts. "Taylor Swift records" looks mainstream, but if the tiles are *Clean / Lover / Fifteen* (deep album cuts, not chart singles) the row is `Niche`. Rate what the player actually sees.

**Lens — `Niche` is the generous bucket.** When genuinely in doubt, pick the more obscure level. Reserve `Mainstream` for tiles known to ~all adults with no hobby/fandom/generation.

**`Ubiquitous`** — virtually every solver knows these cold (days of the week, primary colours, school subjects).

**`Mainstream`** — most adults recall without effort, no special interest required (capital cities, common foods, front-page-news figures — e.g. 21st-century popes Francis/Benedict/John Paul).

**`Niche`** — the specific tiles need a hobby, fandom, generation, or domain interest a typical solver may lack, **even if the umbrella topic is famous** (PlayStation buttons, Google products, individual album track-lists, a full Batman rogues' gallery). Enthusiast-/expert-only content also lands here.

*Consistency rule:* tag the same real-world concept the same way everywhere it appears (the popes connection in l34 and the popes row in l33 share one tag). *Calibration:* tag the **semantics** (are the tiles obscure?), not the behaviour number — but when player data sharply contradicts a tag, the data wins (l34 "21ˢᵗ Century Popes" played far easier than `Niche` implied → `Mainstream`).

> History: this axis began as a 4-level scale ending in `Specialist`. `Specialist` was dropped (too few tags, un-estimable, fuzzy boundary with `Niche`); it is now the three levels above.

---

## 5. `knowledgeDomain` — what the knowledge is about (multi-value allowed)

Tag the **referent** (R4), never the encoding. Multiple domains only when the referent set genuinely spans domains. Provisional groups shown are the current analytics hypothesis (STEM / Humanities / Entertainment / Everyday / Words) — final grouping is **derived from player data** in Stage 3 and recorded in the schema.

| Domain | Group (provisional) | Definition + tie-breaks |
|---|---|---|
| Science | STEM | Scientific principles, chemistry, physics, **anatomy** (body parts as biology). NOT species naming (→ Nature). |
| Maths | STEM | Numbers, geometry, mathematical objects. |
| Technology | STEM | Computing, devices, engineering, tech companies *as tech knowledge*. |
| Nature | STEM | Living things and the natural world: species, trees, animals, **plus natural materials and phenomena (minerals, gemstones, weather)**. Edible species in a culinary frame → Food. |
| History | Humanities | Historical events, periods, figures *as history*. |
| Literature | Humanities | Books, authors, characters *as literature*. |
| Religion | Humanities | Faiths, scripture, religious figures; classical mythology sits here (with History) until data says otherwise. |
| Politics | Humanities | Government, politicians, institutions *as politics* (PM surnames → Politics + History as fits). |
| Military/War | Humanities | Armed forces, warfare, military organisation and ranks, battles *as military knowledge* (army units, battle preparation). |
| Music | Entertainment | Artists, songs, instruments, theory. |
| Film-TV | Entertainment | Films, shows, actors, characters. |
| Sport | Entertainment | Sports, athletes, teams, terminology. |
| Games | Entertainment | Board/video/card games, toys, puzzles. |
| Art | Entertainment | **Visual and performing arts** — artists, movements, design, **dance, theatre, performance**. |
| Geography | Everyday | Places, place names, physical geography. |
| Food | Everyday | Cuisine, dishes, ingredients *as food knowledge* (fish as menu items → Food; fish as taxa → Nature). |
| Society | Everyday | Everyday-life, commercial, brand, institutional knowledge (IKEA naming, licensing rules, newspapers), **and popular frameworks such as the zodiac/horoscopes**. |
| Transport | Everyday | Vehicles and modes of transport — boats, cars, trains, aircraft *as transport* (types of boat). |
| Vocabulary | Words | The referent is **word meanings themselves**: plain synonym/multi-sense/shared-everyday-property rows with `manipulation: None`. |
| Language | Words | The referent is a **linguistic mechanism**: any row whose manipulation ≠ None (wordplay), plus rows about grammar/spelling/phonetics as such. |

*Vocabulary/Language note:* under these definitions the choice is a near-pure function of `manipulation` (None → Vocabulary; otherwise → Language, unless a real-world referent domain applies instead per R4). Stage 3 may auto-derive or merge them; until then the rule above is binding. (Today `pdl_buckets.py` doesn't bucket `Vocabulary` at all — 42 rows leak ungrouped; fixed when grouping moves into the schema.)

---

## 6. Impostor column PDL (`impostorColumn.pdl`)

The four impostors form a fifth, hidden group; tag it exactly like a row whose "category" is the meta-connection, using the same rules R1–R6 (modifiers included). `manipulation` draws from its subset list (None · Hidden word · Compound · Partial · Letter add-delete · Homophone — `Partial` is in the v4 list for impostor sets that complete to per-tile names, e.g. l54/l63; widen further via the schema editor if a puzzle ever needs more).
*Example (l71):* Wing / Engine / Spoiler / Nose → aeroplane parts: manipulation None, abstraction Direct membership, knowledge Common cultural, domain Technology.

## 7. Answer construction PDL (`relink.pdl.answerConstruction`)

How the Phase-2 tiles assemble into the final answer. `knowledge`: the §4 ladder applied to "what must you know to assemble/recognise the answer". `manipulation` (own list):

- **`None`** — the assembled answer is the tiles read out **in order** as a transparent descriptive label, not a pre-existing fixed expression (l71: "Aeroplane" + "Parts" = the category name).
- **`Compound`** — tiles fuse into a **single written word/name** (Play + Station → *PlayStation*).
- **`Phrase`** — the assembled answer is a **recognized fixed expression, idiom, or named entity** the player must spot as a unit (*royal flush*, *deep freeze*, *string section*, *precious metals*).
- **`Word split`** — tile boundaries do not align with the answer's word boundaries; the player must re-split the letter sequence.
- **`Hidden word`** — the answer is embedded inside the assembled tile sequence.

*None-vs-Phrase rule:* if the answer would appear as a dictionary/encyclopedia headword or set phrase, use **Phrase** even though the tiles are read in order; if it is just N words describing the meta-group, use **None**. (This field is semantically defined and a candidate for a future mechanical reframe; the headword test is the binding rule until then.)

## 8. Decoy PDL (`decoys[].pdl`)

Tag the **false connection a player would have to believe**, using the same manipulation (§1) and abstraction (§3) lists and rules — what operation/relation would make the trap group cohere? `description` format: "{perceived false connection} — makes you think {why it misleads}". `Phrase` is not a manipulation value (the one corpus decoy tagged `Phrase` is corrected in Stage 0 hygiene).
Auto-computed, never hand-set: `type` (Exclusive/Inclusive/Confusion), `completeness`, `groupsSpanned`.

## 9. Board PDL (`board`)

- `isThemed` (manual): true ONLY when every row's category is itself an expression of one overarching theme; a shared impostor connection or Phase-2 answer does NOT make a puzzle themed. `themeDomain` from §5 when true.
- Auto-computed, never hand-set: `specialistGroupCount`, `decoyCount`, `phase2TileCount`.

## 10. Edge cases & known limits

The corpus-wide validation surfaced a handful of rare structures with no dedicated value. These are documented rulings rather than new schema values — each occurs in ≤2 puzzles and adding a value would fragment difficulty data for no real gain:

- **Distributive per-tile mapping onto a phrase** (each impostor maps to one *word* of the answer via heterogeneous relations — l1: Relic=old, Fresh=new, Book=borrowed, Depression=blue → "something old, new, borrowed, blue"): tag the impostor-column `abstraction` as `Association` and carry the detail in the description; no dedicated value.
- **Template / placeholder answers** with a literal blank fodder tile ("Daily ___", "___ Flag"): answer-construction `manipulation` = `None`; the blank is a structural slot, not a mechanic.
- **Polysemy answer pivot** (the answer hinges on re-reading a tile in another sense, e.g. *Us* → *US*): `manipulation` = `None`; capture the sense-shift in the description.
- **Heterogeneous answer assembly** (some tiles fuse, others stay separate — Basket+Ball+Teams): tag the dominant assembly operation (here `Compound` for the fusing pair) per R6; a known single-value limitation.

---

**Manipulation:** as-is? → None │ adds material? — *is the added part identical across tiles?* same word=Compound · same non-word affix=Letter add-delete · differs per tile (completes to a known whole)=Partial · initials=Abbreviation │ takes part? → word embedded inside, residue discarded=Hidden word · boundaries redrawn, nothing discarded=Word split │ mutates? → sound=Homophone · rhymes with target=Rhyme · rearrange=Anagram · backwards=Reversal · named code/cipher applied=Cipher · add/remove/substitute letters or affix=Letter add-delete · plural inflection=Plural add-delete. *(Semantic "operations" are not manipulations: synonym-rewrites → abstraction Lexical rewrite; sense-shifts → Multi-sense.)*

**Abstraction (post-manipulation):** plural-noun class, tiles are members? → Direct membership │ one predicate every tile literally satisfies? → Shared property │ tiles mean the concept? → Synonyms │ second dictionary sense? → Multi-sense │ rewrite of a recoverable term? → Lexical rewrite │ a tile relates only by convention/emblem/idiom? → Association │ only a mood/theme? → Loose thematic.

**Knowledge:** structure only → None │ language itself (meanings, spelling, sound) → General vocabulary │ facts most UK adults have (pub-quiz-3+ anchor) → Common cultural │ niche → Specialist cultural. *Rate the group, not the hardest single tile.*

**Niche knowledge:** judge the TILES, not the label │ everyone-cold → Ubiquitous │ every adult, no special interest → Mainstream │ needs a hobby/fandom/generation even if the topic is famous → Niche. *When in doubt → Niche; keep the same concept consistent across puzzles.*

**Domain:** tag the referent; wordplay-about-words → Language; word-meanings-as-such → Vocabulary; otherwise the subject the knowledge is about.
