# Relink Writers' Guide - working draft

> **Status:** research scaffold for the writers' guide. Sections 1–3 are drafted from the
> live corpus (93 puzzles, 372 rows) and the analytics pipeline. **Section 4 is a stub for
> the author to write.** Style: dense reference, not prose. Plain-English in the body;
> [Appendix A](#appendix-a---pdl-cross-reference) maps every term to the PDL schema.
>
> **Evidence note.** '×' figures are *empirical difficulty multipliers* from the analytics
> model ([type-effects.json](../analytics/outputs/data/type-effects.json), `ratio_vs_ref`):
> the relative wrong-guess rate versus a baseline row, measured across 244 dated rows /
> 30,005 player-row observations. `1.0×` = baseline; `2.0×` = twice as many wrong guesses.

---

## 1. The rules of the game

**The board**
- 16 tiles: **4 rows × 4 tiles**. Each row = **3 members of a category + 1 imposter**.
- The **4 imposters** (one per row) share a **hidden link** - a fifth, invisible group.
- The link is **hidden during play**: players see only tiles; the category text is revealed
  only once a row is solved. *(Design consequence: the puzzle must work from the tiles
  alone - never rely on the player reading the category.)*

**The two phases** (one shared pool of **4 lives**)

| Phase | Player does | Wins by |
|---|---|---|
| **1 - Imposters** | In each row, pick the one tile that does **not** belong | Correctly removing all 4 imposters |
| **2 - Relink** | The 4 imposters form a new mini-connection; pick 1–4 tiles that spell the answer | Identifying the connection + building the answer |

- **Lives:** 4, shared across both phases. A wrong guess costs a life and eliminates that
  tile (the row then offers 3 options, then 2). Run out → game over.
- **One attempt per puzzle per day. No retries.** Every completion is a unique player.
- **Solve order is the player's choice** - any row, any order, then Phase 2.

**Two ways players reason** (design for both)
- **Channel A - within a row:** 'which of these 4 doesn't belong?'
- **Channel B - across rows:** 'these odd tiles in different rows share a theme - they're
  the imposters.' Channel B lets a strong solver crack Phase 2 *before* reaching it, and
  short-cuts Phase 1. How exposed Channel B is depends on how transparent the imposter
  link is (see [§2.6](#26-the-relink---the-hidden-connection)).

**The colour tiers = the difficulty ramp**
Rows are assigned a colour by position, easiest → hardest ([`ROW_COLOURS`](../js/constants.js)):

| Position | Colour | Intended difficulty | Empirical wrong-rate\* |
|---|---|---|---|
| Row 0 | 🟣 **Purple** | Easiest | 28% |
| Row 1 | 🔵 **Blue** | Easy–medium | 41% |
| Row 2 | 🟢 **Green** | Medium–hard | 54% |
| Row 3 | 🟠 **Orange** | Hardest | 67% |

\*Share of players who pick the wrong tile, by solve position
([vertical.json](../analytics/outputs/data/vertical.json)). The ramp is real and steep -
orange rows trip up ~2.4× as many players as purple. **Which row gets which colour is a
writing decision** (see [§2.5](#25-what-goes-where---the-colour-ramp)).

**The relink answer**
- Built from the imposter tiles (+ optional free-text 'fodder'), read in order.
- **Smoosh (compound answer):** adjacent tiles can fuse into one word (`Clean` + `Ing` →
  'Cleaning'). Visual only - the stored answer stays space-joined.

---

## 2. Puzzle-writing rules - what works, and the boundaries

### 2.1 The three difficulty levers

Every row's difficulty comes from three independent dials. A writer sets each one
deliberately; the colour of the row should match their combined weight.

| Lever | Plain-English question | PDL field |
|---|---|---|
| **WORDPLAY** | *What do you do to the tile?* (nothing, or some wordplay) | `manipulation` |
| **LOGIC** | *How do the tiles relate to the category?* | `abstraction` |
| **KNOWLEDGE** | *What must you know, and how obscure is it?* | `knowledge` + `nicheKnowledge` |

**WORDPLAY is the strongest lever, LOGIC the weakest, KNOWLEDGE a moderate multiplier.**

### 2.2 WORDPLAY types - the main difficulty dial

68% of all rows have **no wordplay** (a 'plain' link - the tile is used as-is and the work
is all in the meaning). The rest use one of these. Ordered easy → hard by measured impact:

| Wordplay type | What the player does | Difficulty | Corpus n | Example category |
|---|---|---|---|---|
| **Plain** (none) | Use the tile as-is | **1.0×** (baseline) | 232 | 'Chess pieces' |
| **Partial** | Complete the tile to a bigger whole (differs per tile) | **1.2×** | 13 | 'First syllable of UK PMs' surnames' |
| **Hidden word** | Find a word buried inside, discard the rest | **1.75×** | 33 | 'Beginning with evergreen trees' |
| **Homophone** | Say it aloud → a different word | **~1.9×** | 6 | 'Homophones of numbers' |
| **Letter change** | Add / drop / swap a letter or affix | **~1.9×** | 8 | 'Types of boat plus a letter' |
| **Rhyme** | Say it aloud → rhymes with the target | **~1.9×** | 1 | 'Rhyming with months' |
| **Abbreviation** | Expand / contract initials | **~1.9×** | 3 | 'Initials used by fantasy authors' |
| **Compound** | Add the **same** word to every tile (`___ X`) | **2.3×** | 42 | '___ Line' |
| **Word split** | Redraw the internal spaces, nothing discarded | **2.3×** | 1 | 'Split words ending 'king'' |
| **Anagram / Reversal / Cipher** | Rearrange / reverse / decode | *~1.5× (unused so far)* | 0 | - available, untried |

**Reading this:** *compound and word-split rows generate roughly twice the wrong guesses of
a plain row; hidden-word and sound-based rows land in between.* Compound is common **and**
hard - a workhorse for orange rows. Partial is the gentlest wordplay.

### 2.3 LOGIC types (how tiles relate) - a gentler dial

The spread here is ~4× smaller than WORDPLAY, so logic tunes difficulty rather than driving it.

| Logic type | Definition | Difficulty | Corpus n | Example |
|---|---|---|---|---|
| **Synonyms** | Tiles all *mean* the category | **0.95×** (slightly easy) | 42 | 'Cry' |
| **Direct membership** | Tiles literally *are* members of a named set | **1.0×** (baseline) | 213 | 'Prime numbers' |
| **Lexical rewrite** | Tile is a reworded known term to recover | **1.2×** | 0\* | 'Nude pistol' → *Naked Gun* |
| **Shared property** | Every tile satisfies one predicate | **1.4×** | 51 | 'They come in pairs' |
| **Association** | Tiles relate by convention/emblem, not literally | **1.55×** | 17 | 'Associated with Cupid' |
| **Multi-sense** | Link rides on a *second* meaning of the word | **2.4×** (hardest) | 17 | 'What 'rock' can mean' |

\*Lexical rewrite appears in older/undated puzzles; carries a modelled estimate.

**Takeaway:** *multi-sense is the sleeper difficulty spike* - no wordplay at all, yet the
hardest logic type, because the player must reject the obvious reading. Synonyms and direct
membership are the safe, easy backbone.

### 2.4 KNOWLEDGE types - breadth and obscurity

Knowledge is two dials. **Breadth** (`knowledge`) = what *kind* of knowledge a tile needs;
**obscurity** (`nicheKnowledge`) = how deep-cut the *specific tiles* are within that band.
Always judge the actual tiles, not the topic label. Knowledge is a **moderate** lever - it
nudges difficulty, well behind WORDPLAY.

**A. Breadth** - what kind of knowledge (dated rows, player data)

| Breadth band | What it needs | Difficulty | First-try | n | Example |
|---|---|---|---|---|---|
| **Common cultural** | Facts most UK adults have (brands, songs, places) | **0.75×** (easiest) | 62% | 145 | 'Silicon Valley firms' |
| **General vocabulary** | The language itself (meanings, spelling, sound) | **1.0×** (baseline) | 61% | 90 | 'Cry' |
| **Specialist cultural** | Niche facts most adults lack | **1.45×** (hardest) | 44% | 9 | 'Jordan Peele directorial filmography' |
| **None** | Pure structure - no knowledge at all | ~1.0× | - | 0 | letter / length patterns |

*Counter-intuitive but real: `Common cultural` plays **easier** than `General vocabulary` -
a recognisable fact beats a vocabulary / wordplay row.*

**B. Obscurity** - how deep-cut the tiles are (dated rows, player data)

| Obscurity | What it means | Avg wrong | First-try | n |
|---|---|---|---|---|
| **Ubiquitous** | Everyone knows them cold (days of the week, primary colours) | 0.59 | 65% | 27 |
| **Mainstream** | Most adults, no special interest (capitals, common foods) | 0.62 | 61% | 176 |
| **Niche** | Needs a hobby / fandom / generation, even if the topic is famous | 0.68 | 57% | 41 |

*Obscurity isn't a separate multiplier in the difficulty model - these are raw player rates.
It moves the right way but gently (~8 points of first-try across the range).*

**Where rows actually sit** (all 340 tagged rows - a heat-map of the two dials):

| breadth ↓ / obscurity → | Ubiquitous | Mainstream | Niche |
|---|---|---|---|
| **General vocabulary** | 41 | 86 | - |
| **Common cultural** | 4 | 157 | 39 |
| **Specialist cultural** | - | - | 13 |

- **The two dials correlate - rows hug a diagonal.** Vocabulary is never niche (words
  everyone knows); specialist tiles are always niche. The off-diagonal corners are empty, so
  a per-cell *difficulty* heat-map isn't meaningful - read the two tables above instead.
- **Niche is the lever to harden a `Common cultural` row without going `Specialist`** - swap
  famous tiles for deep cuts (chart singles → album tracks). 39 Common-and-Niche rows do this.

**Takeaway:** knowledge fine-tunes, it doesn't drive. Keep `Specialist` rare (≤1 per board -
just 13 of 340 rows), and reach for **obscurity**, not breadth, to add bite.

### 2.5 What goes where - the colour ramp

Each table reads **across a row**: of all rows of a given type, the share that sits in each
colour tier (a row sums to ~100%; **n** = how many such rows exist in the corpus). So
'Hidden word 91% orange' means 91% of all hidden-word rows are the orange (hardest) row.

**Where each wordplay type lives**

| Wordplay type | 🟣 Purple | 🔵 Blue | 🟢 Green | 🟠 Orange | n |
|---|---|---|---|---|---|
| Plain (no wordplay) | 33% | 31% | 25% | 10% | 232 |
| Partial | 15% | 23% | 38% | 23% | 13 |
| Compound | 10% | 19% | 29% | **43%** | 42 |
| Letter change | 12% | 0% | 25% | **62%** | 8 |
| Homophone | 0% | 0% | 33% | **67%** | 6 |
| Hidden word | 3% | 3% | 3% | **91%** | 33 |

*(Abbreviation, word split, rhyme and plural each have ≤3 corpus rows - too few to place reliably.)*

**Where each logic type lives**

| Logic type | 🟣 Purple | 🔵 Blue | 🟢 Green | 🟠 Orange | n |
|---|---|---|---|---|---|
| Synonyms | **57%** | 26% | 2% | 14% | 42 |
| Direct membership | 23% | 26% | 24% | 27% | 213 |
| Association | 12% | 29% | 29% | 29% | 17 |
| Shared property | 18% | 20% | **39%** | 24% | 51 |
| Multi-sense | 6% | 18% | **47%** | 29% | 17 |

**Rules of thumb**
- **Purple & blue = mostly plain rows** with easy, familiar logic (synonyms, direct
  membership). Wordplay here is the exception.
- **Green = the transition** - the first wordplay (compounds, the odd homophone) and the
  harder logic (shared property and multi-sense both peak here).
- **Orange = the wordplay slot** - it soaks up the compound, letter-change and homophone
  rows, and almost every hidden-word row. Put your one cryptic row here.
- **One hard row per puzzle, usually orange.** Don't stack two hidden-word rows; don't make
  purple cryptic.

**Knowledge across the ramp** (the difficulty of each band is in [§2.4](#24-knowledge-types---breadth-and-obscurity)):
- Keep `Specialist cultural` and `Niche` tiles **out of purple** - they belong in green/orange.
- **Balance the knowledge load** - spread domains so a player weak in one area still has a
  route in, and use **≤1 specialist row per board**.

### 2.6 The relink - the hidden connection

The 4 imposters form the puzzle's spine. Two independent tags describe it:

**A. The connection** (how the 4 imposters relate to each other)

| | Most common | Sometimes | Rare |
|---|---|---|---|
| **Wordplay** | Plain, no wordplay (85%) | Compound (12%) | Hidden word (4%) |
| **Logic** | Direct membership (76%) | Association / shared property (20%) | - |

- **Keep the connection mostly plain.** The row-level wordplay is where difficulty belongs;
  the imposter link is usually a clean, satisfying 'oh, they're all X.'
- **Transparent link = Channel B is open** (strong solvers spot it early). **Cryptic link
  (compound/hidden-word) = the later rows get harder**, because players can't lean on the
  cross-row shortcut. Use a cryptic connection deliberately when you want a tougher puzzle.

**B. The answer construction** (how the tiles spell the Phase-2 answer)

| Type | Share | Meaning | Example |
|---|---|---|---|
| **None** | 62% | Tiles read in order as a plain label | 'Aeroplane' + 'Parts' |
| **Phrase** | 19% | Tiles form a known fixed expression | *royal flush* |
| **Compound** | 9% | Tiles fuse into one word | Play + Station → *PlayStation* |
| **Word split** | 9% | Answer's word-breaks differ from the tiles' | re-split the letters |

### 2.7 Decoys - engineered red herrings

**71 of 93 puzzles use at least one decoy.** A decoy is a designed false theme that pulls a
player toward the wrong tile. Two geometries:
- **Horizontal** - within one row (frame a *non*-imposter as the odd one out).
- **Vertical** - tiles from **2+ rows** that share a convincing false theme, so a tile looks
  like it 'belongs' elsewhere (e.g. 'Tesla' pulled toward *Car* in another row, away from
  its real 'Silicon Valley firms' row).

Three functional types (auto-classified by the CMS - see
[docs/domain.md](../docs/domain.md#decoy-type-classification)):

| Type | What it does |
|---|---|
| **Exclusive** | 3 tiles from one row *including* the imposter → frames the innocent 4th tile as the imposter |
| **Inclusive** | A single false suspect, or cross-row tiles forming a fake answer set |
| **Confusion** | Tiles share a secondary link that muddies the row's real category |

**Design intent:** a good imposter is *tempting* - it should plausibly belong to a decoy
theme, so removing the *right* tile takes nerve.

### 2.8 Validity boundaries - a puzzle must satisfy these

Hard constraints (break these and the puzzle is broken, not just hard). Softer craft
judgements are left to [§4](#4-quality--writing-tips).

- **The relink is what makes the imposter unique.** A row may contain more than one tile
  that could pass as the imposter (each would leave a plausible link between the other
  three) - what rules the wrong one out is that its tile doesn't fit the relink. Only the
  intended imposter completes the hidden connection shared by all four, so the solution
  stays unique.
- **The imposter must not be a genuine member of its row's category.** It only *looks* like
  it could be.
- **The 4 imposters must form exactly one clean hidden link** - no second competing
  connection across them.
- **Each of the 3 real members must clearly belong** to the category (after any wordplay is
  applied).
- **The Phase-2 answer must be buildable** from the imposter tiles (+ fodder) as tagged.
- **Wordplay must be consistent within a row** - if the wordplay is 'hidden word at the start,'
  it holds for all 3 members the same way.
- **Balance the knowledge load** - don't require specialist knowledge in multiple rows; a
  player short on one domain should still have a route in.

---

## 3. Style guide - how links are written

How the **category text** is phrased (the line revealed when a row resolves). Patterns are
mined from the corpus; where usage is mixed, the options are listed rather than a single
rule.

### 3.1 Compound links (`___ X` / `X ___`)

| Form | When | Examples |
|---|---|---|
| **`___ Word`** (blank first) | Tile sits **first** in the compound | `___ Line`, `___ Ratio`, `___ Look`, `___ Ground`, `___ Foam`, `___ Pole`, `___ Ray`, `___ Time`, `___ Head`, `___ Hand` |
| **`Word ___`** (blank last) | Tile sits **second** | `Spring ___`, `French ___`, `Back ___`, `Court ___`, `School ___`, `Love ___`, `Pro ___`, `Peace ___`, `Going ___` |
| **Embedded blank** | Prefix fused to a word | `New___ cities` |
| **Descriptive** (names the set, no blank) | When it reads better than `___`, or the `___` completion isn't perfectly clean | `Kinds of artist`, `Types of agent`, `Bridges of London`, `Fictional Johnnys`, `Groups of five` |

- The blank is always three underscores `___` with a space between it and the shared word
  (`___ Word` or `Word ___`). Use descriptive phrasing when it reads better than `___`, or
  when the `___` completion isn't perfectly clean.
- **Capitalise the shared word** in `___ X` forms (`___ Line`, not `___ line`) - corpus
  convention, treats it as the compound's headword.

### 3.2 Hidden-word links

The category **names the hidden set** and states **where** it hides:

| Position | Preferred forms | Examples |
|---|---|---|
| **Start** | `Beginning with X` · `Words beginning with X` | 'Beginning with drinks', 'Beginning with evergreen trees', 'Beginning with soups', 'Words beginning with bread' |
| **End** | `Ending in X` · `Ending with X` · `End in X` | 'Ending in body parts', 'Ending in kitchen fixtures', 'Ending with innuendos for the toilet', 'End in zodiac signs' |
| **Anywhere** | `Containing X` · `Words containing X` · `Hidden X` | 'Containing Greek gods', 'Words containing watersport verbs', 'Hidden slang for seeing friends' |

- **`X` is a plain-English description of the buried set**, not the words themselves
  ('drinks', 'trigonometric functions', 'words for pause') - never list the hidden words.
- `Beginning with` / `Ending in` dominate; use `Containing` when the hidden word floats
  mid-tile or its position varies.

### 3.3 Sound-based links (homophone / rhyme)

| Link | Form | Examples |
|---|---|---|
| **Homophone** | `Homophones of X` (preferred) · `Homophones for X` | 'Homophones of numbers', 'Homophones of Olympic gold medalists', 'Homophones for Valentine's gifts' |
| **Rhyme** | `Rhyming with X` | 'Rhyming with months' |
| **Loose / 'sounds like'** | `Sound a bit like X` | 'Sound a bit like golf clubs' |

- Prefer **`of`** over `for`. `X` names the *target* set (what the tiles sound like).

### 3.4 Letter-change links

No single convention - the corpus spells out the exact operation. Pick the clearest:

| Operation | Forms seen |
|---|---|
| **Add a letter** | 'X plus a letter', 'X with an added letter' (Currency nicknames plus a letter; Animals with an added letter) |
| **Change a letter** | 'X with a letter changed', 'X with first letter changed to 's'' (Wild cats with a letter changed; Potatoes with first letter changed to 's') |
| **Remove a letter** | 'X minus 'B'' (Confident minus 'B') |
| **Add an affix** | 'Add 'in' to get its antonym' |

- Name the letter/affix in **single quotes** (`'s'`, `'B'`, `'in'`).

### 3.5 Partial links (complete to a bigger whole)

Mixed practice - either spell out the fragment or describe the whole:

- **Spell the mechanic:** 'First syllable of UK PMs' surnames', 'Second words of PL football
  teams', 'First words of Christmas films'.
- **Describe the whole:** 'Subjects of Harry Potter book titles', 'James Cameron sequels',
  '80s frontmen', 'Goes with 'dozen''.

### 3.6 Plain-link phrasings (no wordplay - the LOGIC shows in the wording)

| Logic | Category shape | Examples |
|---|---|---|
| **Synonyms** | Bare verb / adjective / short phrase | 'Cry', 'Break up', 'Perceptive', 'Cowardly', 'Charisma', 'To blame', 'Undying' |
| **Direct membership** | Plain noun-phrase naming the set | 'Prime numbers', 'IKEA furniture names', 'Chess pieces', 'Dance styles' |
| **Shared property** | `They X` · `Things that/you X` · `X have them` · `Made of X` | 'They bite', 'They come in pairs', 'Things that rise', 'Things you wax', 'Wings have them', 'Made of wood' |
| **Multi-sense** | `What 'X' can refer to / mean` · `What a X might be` | 'What 'rock' can mean', 'What a seal might be', 'What Mississippi can refer to' |
| **Association** | `Associated with X` · `Relating to X` | 'Associated with Cupid', 'Associated with eight', 'Relating to tongue-based idioms' |

### 3.7 Punctuation & typography conventions

- **Single quotes** around a literal token the player operates on or a quoted phrase:
  `'dozen'`, `'king'`, `'z' sound`, `'You say'`, `'Big Three'`, `'None of your business!'`.
- **Superscript ordinals:** `21ˢᵗ Century Popes`.
- **Real notation where apt:** `E = mc²`.
- **Sentence case** for descriptive categories; **Title Case** for the shared word in
  `___ X` compounds and for named sets/proper nouns.
- Keep categories **short** - a phrase, not a sentence (it's a reveal, not a clue).

### 3.8 The relink answer (Phase-2 display)

- Answer reads left-to-right from the imposter tiles + fodder.
- Use **smoosh** to fuse tiles into one word when the answer is a single word
  (`Play`+`Station` → *PlayStation*); leave separate for phrases (*royal flush*).
- A blank fodder tile marks a **template slot** ('Daily ___', '___ Flag') - the answer is a
  fill-in, not wordplay.

---

## 4. Quality & writing tips

> **To be written by the author.** This section covers craft and judgement - not the
> mechanical rules above - e.g. what makes a link *satisfying* vs merely valid, freshness /
> avoiding repeats, tone and wit, misdirection that feels fair, balancing a board so it
> 'flows', and when to break a convention on purpose.

---

## Appendix A - PDL cross-reference

Body terms → PDL schema. Full binding definitions: [docs/pdl-glossary.md](../docs/pdl-glossary.md).

| Guide term | PDL field | PDL values |
|---|---|---|
| WORDPLAY | `manipulation` (row group) | None, Compound, Partial, Abbreviation, Hidden word, Word split, Homophone, Rhyme, Anagram, Reversal, Cipher, Letter add-delete, Plural add-delete |
| Where the wordplay sits | `manipulationModifiers.position` | start · middle · end · mixed |
| LOGIC type | `abstraction` | Direct membership, Shared property, Synonyms, Multi-sense, Lexical rewrite, Association, Loose thematic |
| KNOWLEDGE breadth | `knowledge` | None, General vocabulary, Common cultural, Specialist cultural |
| Obscurity of the tiles | `nicheKnowledge` | Ubiquitous, Mainstream, Niche |
| Subject area | `knowledgeDomain` | Science, Nature, Technology, History, Music, Film-TV, Sport, Food, Geography, Society, Vocabulary, Language, … (20 total) |
| The hidden connection | `impostorColumn.pdl` | same lists (link subset: None, Hidden word, Compound, Partial, Letter add-delete, Homophone) |
| Building the answer | `relink.pdl.answerConstruction` | None, Compound, Word split, Hidden word, Phrase |
| Red herrings | `decoys[].pdl` (+ auto `type`) | Exclusive, Inclusive, Confusion |
| Colour ↔ position | [`ROW_COLOURS`](../js/constants.js) | purple(0), blue(1), green(2), orange(3) |

## Appendix B - sources

| Claim type | Source |
|---|---|
| Difficulty multipliers (×) | [analytics/outputs/data/type-effects.json](../analytics/outputs/data/type-effects.json) (`ratio_vs_ref`) |
| Position wrong-rate curve | [analytics/outputs/data/vertical.json](../analytics/outputs/data/vertical.json) (`error_curve`) |
| Type distributions, corpus counts | `save-data/l*.json` (93 puzzles, 372 rows) |
| Rules, phases, decoys | [docs/domain.md](../docs/domain.md) |
| Tagging definitions | [docs/pdl-glossary.md](../docs/pdl-glossary.md) |
| Colour system | [js/constants.js](../js/constants.js) (`ROW_COLOURS`) |
