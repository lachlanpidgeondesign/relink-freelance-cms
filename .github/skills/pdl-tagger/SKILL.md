---
name: pdl-tagger
description: 'Tag Relink puzzles with PDL (Puzzle Difficulty Level) metadata. Use when: tagging a puzzle, filling PDL fields, identifying decoys, labelling decoys, completing missing PDL, or suggesting schema changes. Invoked with e.g. "tag l10" or "tag puzzle 10".'
---

# PDL Tagger

Comprehensively tag a Relink puzzle with PDL metadata — all rows, impostor column, answer construction, and decoys. Also identifies potential new decoys and proposes schema additions when needed.

> **Canonical rulebook: [`docs/pdl-glossary.md`](../../../docs/pdl-glossary.md).**
> That glossary holds the binding definitions, decision rules, decision trees,
> modifier rules, and worked edge cases for every PDL field and value. The
> tables in this skill are a quick reference; whenever they are silent or a
> call is close, the glossary wins. Read it before tagging.

## Invocation

User says something like:
- "tag l10"
- "tag puzzle 30"
- "fill PDL for l5"
- "identify decoys in l22"

## Workflow

### Step 1: Read the Live Schema (and the Glossary)

**Always** read `save-data/pdl-schema.json` first. This file defines the valid values for all PDL fields. Never hardcode schema values — the schema is user-editable and can change between invocations.

Also read **[`docs/pdl-glossary.md`](../../../docs/pdl-glossary.md)** — the binding definitions and decision rules. The schema lists *what* values exist; the glossary defines *when* each one applies (including the four-family manipulation frame, the `manipulationModifiers`, and the abstraction decision tree).

The schema contains:
- `knowledgeLevels` — ordered from easiest to hardest
- `nicheKnowledgeLevels` — obscurity/recall depth of the actual tiles (companion axis to `knowledgeLevels`)
- `manipulationTypes` — word manipulation techniques
- `abstractionLevels` — ordered from most concrete to most abstract
- `knowledgeDomains` — subject-matter categories
- `impostorColumnManipulationTypes` — manipulation types specific to the impostor column connection
- `answerConstructionManipulationTypes` — manipulation types for forming the final answer
- `manipulationModifiers` — `position` / `whole` sub-tags for `Compound` / `Partial` / `Hidden word`

### Step 2: Read the Puzzle File

Read `save-data/l{N}.json`. Note:
- 4 rows × 4 tiles each
- Each row has exactly 1 impostor (`isImpostor: true`)
- Tiles marked `isRelink: true` feed into Phase 2
- The `relink` object has the Phase 2 tiles + answer
- `decoys` array may be empty or partially filled

### Step 3: Tag All Elements

Work through each element systematically. For each, reason about the puzzle content and assign values from the schema.

---

## Tagging Rules

### A. Group PDL (per row)

Each row has `row.pdl.group` with 5 fields. Reason about the **3 genuine tiles** (non-impostor) and their **category**:

#### `knowledge` — What knowledge does a player need to identify this group?

| Value | When to use |
|-------|-------------|
| None | No external knowledge needed — the connection is purely logical/structural |
| General vocabulary | Requires understanding common English words/meanings (e.g., "Things that are red") |
| Common cultural | Requires widely-known cultural knowledge (e.g., "Beatles members", "Olympic sports") |
| Specialist cultural | Requires niche knowledge most people wouldn't have (e.g., "Nobel Prize physicists", "Baroque composers") |

#### `manipulation` — Is there word manipulation in how tiles relate to the category?

| Value | When to use |
|-------|-------------|
| None | Tiles are straightforward members of the category (e.g., "Apple, Banana, Cherry" → "Fruits") |
| Compound | The **same** word is added to every tile to form a compound/phrase (e.g., "Fire, Basket, Foot" → "___ball"). Identical added part across all tiles. |
| Partial | Each tile is **part** of a longer word/phrase, but the missing remainder **differs** per tile (e.g., "Tea, Sauce, Dutch" → first words of *Teapot/Saucepan/Dutch oven*). |
| Abbreviation | Tiles are (or expand from) abbreviations/initialisms (e.g., "Dr, St, Mt"). |
| Hidden word | A word is concealed inside the tile text (morphological relatedness is fine — TEA inside *Teapot*). |
| Word split | A tile splits into, or fuses from, multiple meaningful words (e.g., "Mocking" → "Mock + King"). |
| Homophone | Tiles sound like something else |
| Rhyme | Tiles rhyme with the target word (partial sound match, not a full homophone) |
| Anagram | Tiles are anagrams |
| Reversal | Tiles read backwards reveal something |
| Letter add-delete | Adding, removing, or substituting letters / a non-word affix reveals the connection |
| Plural add-delete | Adding/removing plural 's' is key to the connection |

**Multiple values allowed** — a row can use more than one manipulation technique.

**`manipulationModifiers` (sub-tag).** When `manipulation` is `Compound`, `Partial`, or `Hidden word`, also record where the operation sits:
- `position`: `start` | `middle` | `end` | `mixed` (use `mixed` when tiles differ tile-to-tile).
- `whole` (Partial only): `multi-word` | `single word` — is the full target a multi-word phrase or a single word?

Store them on the same object, e.g. `"manipulationModifiers": { "position": "start", "whole": "single word" }`. See the glossary for the exact rules.

#### `abstraction` — How abstract is the connection between tiles and category?

| Value | When to use |
|-------|-------------|
| Direct membership | Tiles are literal members/instances of the category (e.g., "Red, Blue, Green" → "Colours"; "Unwritten, Mercy" → "00s hits") |
| Shared property | Tiles share a concrete, demonstrable attribute every tile literally satisfies (e.g., "Fire engine, Tomato, Rose" → "Things that are red"; "Beta, Understudy, Silver" → "Comes in second") |
| Synonyms | Tiles are synonyms for the category concept (e.g., "Yellow, Chicken, Craven" → "Cowardly"; "Milk, Cheat, Fleece" → "To con") |
| Multi-sense | Tiles exploit multiple meanings of words |
| Lexical rewrite | The category is reached by substituting a synonym/equivalent term, not by membership (semantic counterpart of the retired "Synonym substitution" manipulation) |
| Association | Tiles associate with the category by convention/emblem/idiom rather than literal satisfaction (e.g., "Crown, Throne, Palace" → "Monarchy") |
| Loose thematic | Very loose/subjective thematic link |

#### `knowledgeDomain` — What subject domain does the knowledge requirement fall into?

Only meaningful when `knowledge` is NOT "None". Pick from the schema's `knowledgeDomains` list. Can be multiple values if the group spans domains.

For `General vocabulary` rows: use **Vocabulary** for plain synonym/everyday-word groups with no linguistic mechanism, and **Language** for rows that do exploit a linguistic mechanism (compound wordplay, homophones, hidden words, etc.). See the calibration note below.

#### `nicheKnowledge` — How obscure are the specific tiles? (companion to `knowledge`)

A **separate axis** from `knowledge`: that one rates *breadth* (what kind of knowledge is needed), this one rates *depth / obscurity* (how recognisable the actual tiles are). Pick from the schema's `nicheKnowledgeLevels` — ordinal, easiest to hardest:

| Value | When to use |
|-------|-------------|
| Ubiquitous | Virtually every solver knows these cold (days of the week, primary colours, school subjects) |
| Mainstream | Most adults recall without effort, no special interest needed (capital cities, common foods, front-page-news figures) |
| Niche | The specific tiles need a hobby, fandom, generation, or domain interest a typical solver may lack — **even if the umbrella topic is famous** (PlayStation buttons, album deep cuts, a full rogues' gallery) |

- **Judge the actual tiles, not the category label.** "Taylor Swift records" looks mainstream, but tiles *Clean / Lover / Fifteen* (deep cuts) are `Niche`.
- **`Niche` is the generous bucket** — when genuinely in doubt, pick it. Reserve `Mainstream` for tiles known to ~all adults with no hobby/fandom/generation.
- Tag the **same real-world concept consistently** across every puzzle it appears in.

Applies to **group rows and the impostor column** (not answer construction or decoys). See the glossary **§4b** for the binding rubric.

---

### B. Impostor Column PDL

`puzzle.impostorColumn.pdl` — same 5 fields as Group PDL (including `nicheKnowledge`), but applied to the **meta-connection between all 4 impostor tiles**.

Reasoning approach:
1. List the 4 impostor tiles (one from each row)
2. Read `relink.answer` — this is what the impostors connect to form
3. Ask: "What connects these 4 tiles?" — that's the impostor column's group
4. Tag the knowledge/manipulation/abstraction/domain of RECOGNISING that connection

---

### C. Answer Construction PDL

`puzzle.relink.pdl.answerConstruction` — 2 fields only:

#### `knowledge` — What knowledge is needed to assemble the answer from the impostor tiles?

Same scale as Group PDL knowledge, but applied to: "Once you have the 4 impostor tiles, what do you need to know to form the final answer?"

#### `manipulation` — How are tiles combined into the answer?

Uses `answerConstructionManipulationTypes` from the schema:
| Value | When to use |
|-------|-------------|
| None | The tiles directly spell out or name the answer |
| Compound | Tiles form compound words that chain together |
| Word split | The answer is tiles joined/split in a non-obvious way |
| Hidden word | The answer is hidden within the tile sequence |
| Phrase | Tiles are words in a well-known phrase/expression |

---

### D. Decoy PDL (per existing decoy)

Each `decoy.pdl` has 3 manual fields + a description:

#### `knowledge`, `manipulation`, `abstraction`
Same reasoning as Group PDL, but applied to the **false connection** — i.e., what would a player need to know, and what type of link is it, to BELIEVE these tiles belong together?

#### `description`
A brief sentence explaining the false grouping: what it makes the player think, and why it's misleading. Format: "{perceived false connection} — makes you think {why it misleads}"

---

### E. Identifying New Decoys

After tagging existing elements, analyse the puzzle for potential decoys that haven't been recorded:

#### Vertical decoys (cross-row)
Look for tiles across different rows that share a plausible connection:
- Common theme (e.g., "Tesla" in one row + "Edison" in another → "Inventors")
- Shared word property (e.g., tiles in different rows that are all animals)
- Cultural associations spanning rows

#### Horizontal decoys (within a row)
Look for 3 tiles within a row (the real group members or a mix) that could plausibly form a different group — especially when the impostor "fits" the false group better than the real one.

#### Creating decoy entries
For each new decoy:
```json
{
  "id": "decoy-{timestamp}-{counter}",
  "tileIds": ["tile-xxx", "tile-yyy", ...],
  "pdl": {
    "knowledge": [...],
    "manipulation": [...],
    "abstraction": [...],
    "description": "..."
  }
}
```

Use the current Unix timestamp (seconds) for the ID. Counter starts at 1 for each batch.

**Important:** Only add decoys that represent genuinely plausible false groupings a player might fall for. Don't add weak or forced connections.

---

## Auto-Computed Fields — DO NOT SET

The CMS computes these automatically. Never write them into the JSON:
- `decoy.pdl.completeness`
- `decoy.pdl.groupsSpanned`
- `decoy.pdl.type`
- `puzzle.board.specialistGroupCount`
- `puzzle.board.decoyCount`
- `puzzle.board.phase2TileCount`

The `board.isThemed` and `board.themeDomain` fields ARE manual — set them only if EVERY row's category is itself an expression of a single overarching theme. Examples of themed puzzles:
- "Strings section" — every row's category is a type of string instrument / something stringed
- "The four seasons" — every row's category corresponds to Spring/Summer/Autumn/Winter

A puzzle is NOT themed just because the impostor connection or Phase 2 answer points to one subject. The rows themselves must each be built around the theme. If row categories are unrelated to each other (even when impostors share a connection), `isThemed: false`.

---

## Schema Suggestions

If a puzzle element doesn't fit any existing schema value well:

1. **Tag with the closest existing value** — always produce a valid tag
2. **At the end of your response**, list proposed schema additions:

```
## Schema Suggestions

- Consider adding `Cryptic-style` to `manipulationTypes` because: puzzle l40 row 3 builds the link from a cryptic-clue device not captured by the four manipulation families.
- Consider adding `Fashion` to `knowledgeDomains` because: multiple puzzles reference fashion knowledge that doesn't fit neatly into existing domains.
```

Only suggest additions when there's a clear gap. Don't suggest values that are already subsumed by existing ones.

---

## Output Behaviour

1. Read schema and puzzle file
2. Show a brief summary of the puzzle (name, theme, row categories)
3. For each element, show your reasoning and the assigned tags
4. Edit the puzzle file directly with all PDL updates
5. List any new decoys added with explanations
6. List any schema suggestions (if applicable)
7. After editing, note that user should run `python3 tools/check_pdl.py` to verify

> **Cross-check re-tags against player data (published puzzles).** When you re-tag a
> puzzle that already has player results, the analytics leave-one-out forecast is a
> useful sanity check. The biggest over-/under-predictions in
> `analytics/outputs/data/simulator_loo.json` → `summary.worst` (and the dashboard's
> Model Validation page) often flag a mis-tag: a large **over**-prediction means the
> model thinks the puzzle is easier than players found it — revisit whether the
> difficulty is under-tagged (especially the **impostor-column link**'s `manipulation`/
> `abstraction`, which drives the simulator's cryptic-vs-transparent link mechanic),
> fix it here, then re-run `pdl_analysis.py --cache --loo`. See the **analytics-pipeline**
> skill. Tag the semantics honestly — never tweak a tag just to chase the number.

---

## Example Reasoning (Group PDL)

> **Row 0:** Category "Filed documents", tiles: Records, Clean (impostor), Log, Index
>
> - The 3 genuine tiles are: Records, Log, Index
> - These are all things that can be "filed" or types of filed documents
> - `knowledge`: "General vocabulary" — knowing that records, logs, and indexes are document types
> - `manipulation`: "None" — tiles are straightforward words, no wordplay
> - `abstraction`: "Direct membership" — these are literally types of filed documents
> - `knowledgeDomain`: "Society" — relates to administrative/office knowledge
> - `nicheKnowledge`: "Ubiquitous" — "records / log / index" are everyday office words virtually every solver knows

## Example Reasoning (Decoy Identification)

> **Potential vertical decoy:** "Romeo" (row 1) + "Juliett" (row 1) + "Lover" (row 1, impostor)
>
> - These 3 tiles all relate to romance/love stories
> - A player might think the group is "Romance" and exclude "Tango" as the impostor
> - But "Tango" is actually a NATO letter, and "Lover" is the real impostor (a Taylor Swift album)
> - `knowledge`: "Common cultural" — Shakespeare's Romeo and Juliet is widely known
> - `manipulation`: "None"
> - `abstraction`: "Association" — associated with romance rather than direct members of a category
> - `description`: "Romance/love associations — makes you think row is about love stories and Tango is the impostor"

## Calibration Notes (Common Mistakes to Avoid)

### Knowledge Level — Don't Over-Rate as "Specialist cultural"

"Specialist cultural" is for genuinely niche knowledge most adults wouldn't have. These are all **Common cultural**:
- Beatles songs (Hey Jude, The Walrus, Her Majesty) — iconic, universally known
- UK port cities (Newport, Stockport, Southport) — well-known places
- Silicon Valley companies (Google, Apple, Tesla) — world-famous brands
- Fantasy heroes (Harry Potter, Bilbo Baggins, Lucy Pevensie) — bestselling franchises
- "'You say' pronunciations" (Tomato, Neither) — widely-known cultural reference
- Disney princesses — household names

**Rule of thumb:** If most adults in the UK would recognise it, it's Common cultural. Specialist cultural is for things like "Baroque composers" or "Nobel Prize physicists".

### Knowledge Level — "General vocabulary" vs "Common cultural"

"General vocabulary" means no external knowledge beyond understanding English words. If recognising the connection requires knowing something about the real world (e.g., that Rook and Swift are bird species, or that certain trees are specifically evergreen), that's **Common cultural** — even if the words themselves are common English words.

### Knowledge Level — Never Mix Levels in the Same Array

A row has ONE knowledge level. Don't put `["General vocabulary", "Common cultural"]` — pick the one that best describes the knowledge requirement.

### Abstraction — "Synonyms" vs "Direct membership"

- **Direct membership**: Tiles literally ARE members of a named category (e.g., "Red, Blue, Green" → "Colours"; "Unwritten, Love Song, Mercy" → "00s hits")
- **Synonyms**: Tiles are synonyms for a concept or for each other (e.g., "Yellow, Chicken, Craven" → "Cowardly"; "Evergreen, Immortal, Eternal" → "Undying"; "Milk, Cheat, Stitch up, Fleece" → "To con")

If the category name IS the word the tiles are synonyms of, use Synonyms. If the tiles are instances/examples that belong to a broader category, use Direct membership.

### Abstraction — "Shared property" vs "Association"

- **Shared property**: Tiles demonstrably share a concrete attribute (e.g., "Beta, Right hand, Understudy, Silver" all share the property of being "second")
- **Association**: Tiles associate with a concept indirectly without a single shared attribute

### Manipulation — Don't Hallucinate Wordplay

Only tag manipulation when there is ACTUAL word manipulation happening. Company names (Google, Apple, Tesla) used as literal company names have manipulation = "None" — even if some of those words have other meanings. The presence of homonyms doesn't make it a "Homophone" unless the puzzle actively requires phonetic interpretation.

### Knowledge Domain — "Nature" not "Science"

Living organisms belong to the **Nature** domain:
- Butterfly species → Nature (not Science)
- Bird species (Rook, Swift, Goldfinch) → Nature (not Science)
- Evergreen trees (Spruce, Pine, Cedar) → Nature (not Science)
- Animals (squid) → Nature (not Science)

"Science" is for scientific principles, chemistry, physics, etc. — not for naming species.

### Knowledge Domain — "Vocabulary" vs "Language"

**Vocabulary** and **Language** both apply to word-based connections, but they mean different things:

- **Vocabulary** — the row is just synonyms, multi-sense words, or a shared everyday-English property. The player only needs to know what English words mean. No wordplay or linguistic mechanism. Examples:
  - "Cowardly" → Yellow, Chicken, Craven (synonyms) → Vocabulary
  - "Charisma" → Magnetism, Charm, Game (synonyms) → Vocabulary
  - "Things used as eyes" → Buttons, Coal, Colon (associations) → Vocabulary
  - "Films" → Movies, Flicks, Pictures (synonyms) → Vocabulary

- **Language** — there is a genuine linguistic mechanism the player must decode: homophones, hidden words, compound wordplay (`___ X` / `X ___`), letter add-delete, anagrams, suffixes, sound/phonetic patterns, plural add-delete, spelling variation, idiomatic phrase structures. Examples:
  - "___ Line" → Finish, Dead, Touch (compound wordplay) → Language
  - "Homophones for Valentine's gifts" → Knead, Flours (homophone) → Language
  - "Add 'in' to get its antonym" → Colossal, Finite (letter add-delete) → Language
  - "Ending in body parts" → hidden word at end → Language

**Rule of thumb:** If `manipulation == ["None"]` AND `abstraction` is `["Synonyms"]`, `["Shared property"]`, `["Multi-sense"]`, or `["Association"]`, AND `knowledge == ["General vocabulary"]`, the domain is almost certainly `["Vocabulary"]` — not `["Language"]`. If the row uses any actual word manipulation, it's `["Language"]`.

Don't default to "Language" just because the connection involves word meanings. For brand/commercial/licensing knowledge, use **Society**. For living things, use **Nature**.

### Knowledge Domain — "Society" for Everyday Life Knowledge

Things like IKEA furniture naming conventions, UK licensing requirements, or commercial brand knowledge belong in **Society** — not Language, Technology, or Film-TV.

---

## Gotchas

- **Read the schema fresh every time** — don't rely on cached/memorised values
- **Multiple values are arrays** — `"knowledge": ["Common cultural"]` not `"knowledge": "Common cultural"`
- **All PDL field values are arrays or null** — even single selections are `["value"]`
- **Don't touch auto-computed fields** — the CMS handles these
- **Decoy IDs** use format `decoy-{unix_timestamp_seconds}-{counter}`
- **Validate tile IDs exist** — when creating decoys, verify each tileId exists in the puzzle's rows
- **isThemed** — set to `true` ONLY when every row's category is itself an expression of one overarching theme (e.g. all rows are types of string instruments, or all rows are seasons). A shared impostor connection or Phase 2 answer does NOT make a puzzle themed. When `true`, set `themeDomain` from `knowledgeDomains`.
