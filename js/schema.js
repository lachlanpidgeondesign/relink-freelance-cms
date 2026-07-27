// PDL Schema — user-editable option lists for PDL dropdowns
// Falls back to hardcoded defaults from constants.js.
// Persisted as pdl-schema.json in the connected directory.

import {
  KNOWLEDGE_LEVELS, MANIPULATION_TYPES, ABSTRACTION_LEVELS, KNOWLEDGE_DOMAINS,
  IMPOSTOR_COLUMN_MANIPULATION_TYPES, ANSWER_CONSTRUCTION_MANIPULATION_TYPES,
  MANIPULATION_MODIFIERS, NICHE_KNOWLEDGE_LEVELS
} from './constants.js';

// ── Schema field metadata ──
export const SCHEMA_FIELDS = [
  { key: 'knowledgeLevels',                  label: 'Knowledge Levels',                  defaultValues: KNOWLEDGE_LEVELS },
  { key: 'nicheKnowledgeLevels',             label: 'Niche-Knowledge Levels',            defaultValues: NICHE_KNOWLEDGE_LEVELS },
  { key: 'manipulationTypes',                label: 'Manipulation Types (Group/Decoy)',   defaultValues: MANIPULATION_TYPES },
  { key: 'abstractionLevels',                label: 'Abstraction Levels',                 defaultValues: ABSTRACTION_LEVELS },
  { key: 'knowledgeDomains',                 label: 'Knowledge Domains',                  defaultValues: KNOWLEDGE_DOMAINS },
  { key: 'impostorColumnManipulationTypes', label: 'Impostor Column Manipulation Types', defaultValues: IMPOSTOR_COLUMN_MANIPULATION_TYPES },
  { key: 'answerConstructionManipulationTypes', label: 'Answer Construction Manipulation',defaultValues: ANSWER_CONSTRUCTION_MANIPULATION_TYPES },
];

// ── Internal state ──
let _schema = null;          // null = use defaults
let _rawSchema = null;       // full parsed schema file, incl. keys the CMS doesn't edit
                             // (manipulationModifiers, knowledgeDomainGroups) — preserved on save
let _listeners = [];

function defaults() {
  const s = {};
  for (const f of SCHEMA_FIELDS) s[f.key] = [...f.defaultValues];
  return s;
}

function current() {
  return _schema || defaults();
}

// ── Public getters ──
export function getKnowledgeLevels()                   { return current().knowledgeLevels; }
export function getNicheKnowledgeLevels()              { return current().nicheKnowledgeLevels || NICHE_KNOWLEDGE_LEVELS; }
export function getManipulationTypes()                  { return current().manipulationTypes; }
export function getAbstractionLevels()                  { return current().abstractionLevels; }
export function getKnowledgeDomains()                   { return current().knowledgeDomains; }
export function getImpostorColumnManipulationTypes() { return current().impostorColumnManipulationTypes; }
export function getAnswerConstructionManipulationTypes() { return current().answerConstructionManipulationTypes; }
// manipulationModifiers is a structured key (not one of the editable lists);
// it rides in the raw schema file when present, else falls back to defaults.
export function getManipulationModifiers() { return (_rawSchema && _rawSchema.manipulationModifiers) || MANIPULATION_MODIFIERS; }

// ── Mutate ──
export function updateSchemaField(key, values) {
  if (!_schema) _schema = defaults();
  _schema[key] = [...values];
  notify();
}

export function resetSchemaToDefaults() {
  _schema = null;
  notify();
}

// ── Subscription ──
export function onSchemaChange(fn) {
  _listeners.push(fn);
  return () => { _listeners = _listeners.filter(f => f !== fn); };
}

function notify() {
  for (const fn of _listeners) fn(current());
}

// ── Persistence ──
const SCHEMA_FILENAME = 'pdl-schema.json';

export async function loadSchema(dirHandle) {
  if (!dirHandle) return;
  try {
    const fh = await dirHandle.getFileHandle(SCHEMA_FILENAME);
    const file = await fh.getFile();
    const data = JSON.parse(await file.text());
    // Validate: must be an object with at least one known key
    if (data && typeof data === 'object') {
      // Migrate old key name
      if (data.connectionIdManipulationTypes && !data.impostorColumnManipulationTypes) {
        data.impostorColumnManipulationTypes = data.connectionIdManipulationTypes;
      }
      const d = defaults();
      // Merge: use saved values for known keys, fall back to defaults for missing keys
      for (const f of SCHEMA_FIELDS) {
        if (Array.isArray(data[f.key])) d[f.key] = data[f.key];
      }
      _schema = d;
      _rawSchema = data;   // retain unknown keys so saveSchema can round-trip them
      notify();
    }
  } catch {
    // No schema file yet — use defaults
  }
}

export async function saveSchema(dirHandle) {
  if (!dirHandle) return;
  // Overlay the editable lists onto the raw file so structured keys
  // (manipulationModifiers, knowledgeDomainGroups) survive the round-trip.
  const data = { ...(_rawSchema || {}), ...current() };
  const fh = await dirHandle.getFileHandle(SCHEMA_FILENAME, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(data, null, 2));
  await w.close();
}

export function getSchemaForExport() {
  return current();
}

export function isSchemaCustomised() {
  return _schema !== null;
}
