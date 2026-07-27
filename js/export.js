// Export utilities: JSON, PDL summary
import { downloadBlob } from './fileio.js';

function escapeCSV(value, sep = ',') {
  const str = String(value ?? '');
  if (str.includes(sep) || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

export function exportPDLSummaryAsCSV(puzzles) {
  const counts = {};
  function tally(axis, val) {
    if (!val) return;
    const vals = Array.isArray(val) ? val : [val];
    for (const v of vals) counts[`${axis}:${v}`] = (counts[`${axis}:${v}`] || 0) + 1;
  }
  for (const p of puzzles) {
    for (const row of p.rows) {
      const g = row.pdl.group;
      tally('knowledge', g.knowledge);
      tally('manipulation', g.manipulation);
      tally('abstraction', g.abstraction);
      tally('domain', g.knowledgeDomain);
    }
  }
  const lines = ['Axis,Value,Count'];
  for (const [key, count] of Object.entries(counts).sort()) {
    const [axis, value] = key.split(':');
    lines.push(`${escapeCSV(axis)},${escapeCSV(value)},${count}`);
  }
  return lines.join('\n');
}

export function doExportCurrentJSON(puzzle) {
  downloadBlob(JSON.stringify(puzzle, null, 2), `${puzzle.id}.json`, 'application/json');
}

export function doExportAllJSON(puzzles) {
  downloadBlob(JSON.stringify(puzzles, null, 2), 'relink-puzzles.json', 'application/json');
}

export function doExportPDLSummary(puzzles) {
  downloadBlob(exportPDLSummaryAsCSV(puzzles), 'relink-pdl-summary.csv', 'text/csv');
}
