// Canonical ID validation regex
export const CANONICAL_ID_RE = /^[a-z0-9]+-[a-z0-9]+$/;

// PDL dropdown option arrays
export const KNOWLEDGE_LEVELS = [
  'None', 'General vocabulary', 'Common cultural', 'Specialist cultural',
];

// Niche-knowledge / obscurity — how recognisable the knowledge is WITHIN a
// breadth level. Separate axis from KNOWLEDGE_LEVELS: a row can be
// 'Common cultural' in breadth yet 'Niche' in obscurity (e.g. PlayStation
// buttons, nicknames for English monarchs). Ordered easy→hard. Judge the
// actual tiles shown, not the category label in isolation.
export const NICHE_KNOWLEDGE_LEVELS = [
  'Ubiquitous', 'Mainstream', 'Niche',
];

export const MANIPULATION_TYPES = [
  'None', 'Compound', 'Partial', 'Abbreviation', 'Hidden word', 'Word split',
  'Homophone', 'Rhyme', 'Anagram', 'Reversal', 'Letter add-delete', 'Plural add-delete',
];

// Manipulation options for the Impostor Column
// (how impostors must be decoded to see the shared link)
export const IMPOSTOR_COLUMN_MANIPULATION_TYPES = [
  'None', 'Hidden word', 'Compound', 'Partial', 'Letter add-delete', 'Homophone',
];

// Manipulation options for relink Answer Construction
// (how tiles are combined to spell the answer)
export const ANSWER_CONSTRUCTION_MANIPULATION_TYPES = [
  'None', 'Compound', 'Word split', 'Hidden word', 'Phrase',
];

// Manipulation modifiers — single-valued sub-fields that qualify certain
// manipulation types. `position` says where in the tile the manipulated
// fragment sits; `whole` describes the underlying whole for a Partial.
// `appliesTo` lists the manipulation values each modifier is relevant to.
// Mirrors the manipulationModifiers block in pdl-schema.json (used as the
// fallback when no schema file is loaded).
export const MANIPULATION_MODIFIERS = {
  position: {
    values: ['start', 'middle', 'end', 'mixed'],
    appliesTo: ['Compound', 'Partial', 'Hidden word'],
  },
  whole: {
    values: ['multi-word', 'single word'],
    appliesTo: ['Partial'],
  },
};

export const ABSTRACTION_LEVELS = [
  'Direct membership', 'Shared property', 'Synonyms', 'Multi-sense', 'Lexical rewrite', 'Association', 'Loose thematic',
];

export const KNOWLEDGE_DOMAINS = [
  'Sport', 'Music', 'Language', 'Vocabulary', 'Geography', 'Science', 'Technology',
  'Food', 'History', 'Film-TV', 'Literature', 'Religion', 'Maths', 'Games', 'Nature',
  'Art', 'Society', 'Politics', 'Military/War', 'Transport',
];

export const DECOY_COMPLETENESS = ['Full (4 tiles)', 'Partial (2-3 tiles)'];

export const CONNECTION_TYPE_REFERENCE = [
  { name: 'Simple Category', knowledge: 'varies', manipulation: 'None', abstraction: 'Direct membership' },
  { name: 'Compound Word/Phrase', knowledge: 'varies', manipulation: 'Compound', abstraction: 'varies' },
  { name: 'Hidden Word', knowledge: 'varies', manipulation: 'Hidden word', abstraction: 'varies' },
  { name: 'Homophone', knowledge: 'varies', manipulation: 'Homophone', abstraction: 'varies' },
  { name: 'Rhyme', knowledge: 'varies', manipulation: 'Rhyme', abstraction: 'varies' },
  { name: 'Abbreviation', knowledge: 'varies', manipulation: 'None', abstraction: 'Association' },
  { name: 'Double Meaning', knowledge: 'General vocabulary', manipulation: 'None', abstraction: 'Multi-sense' },
  { name: 'Property/Association', knowledge: 'varies', manipulation: 'varies', abstraction: 'Shared property or Association' },
  { name: 'Anagram', knowledge: 'varies', manipulation: 'Anagram', abstraction: 'varies' },
  { name: 'Cultural Set', knowledge: 'Common or Specialist cultural', manipulation: 'varies', abstraction: 'Direct membership' },
  { name: 'Spelling/Letter Pattern', knowledge: 'varies', manipulation: 'Letter add-delete', abstraction: 'Shared property' },
  { name: 'Word Split/Charade', knowledge: 'varies', manipulation: 'Word split', abstraction: 'varies' },
  { name: 'Reversal', knowledge: 'varies', manipulation: 'Reversal', abstraction: 'varies' },
];

export const ROW_COLOURS = [
  { name: 'purple', bg: '#9B95F0', text: '#FFFFFF' },
  { name: 'blue', bg: '#94CAFF', text: '#FFFFFF' },
  { name: 'green', bg: '#66E0C4', text: '#FFFFFF' },
  { name: 'orange', bg: '#F8CD8B', text: '#FFFFFF' },
];

// Distinct colours for decoy groups (avoids row colours)
export const DECOY_COLOURS = [
  '#e74c3c', // red
  '#e67e22', // orange
  '#f1c40f', // yellow
  '#2ecc71', // green
  '#1abc9c', // teal
  '#3498db', // blue
  '#9b59b6', // purple
  '#e84393', // pink
  '#00b894', // mint
  '#6c5ce7', // indigo
  '#fd79a8', // salmon
  '#00cec9', // cyan
];
