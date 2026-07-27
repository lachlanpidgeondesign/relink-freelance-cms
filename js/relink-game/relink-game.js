// Relink — interactive, reusable "play the puzzle" component.
//
// Reverse-engineered from the five static snapshots in "Saved html from Relink/".
// It is a genuine playable game (not a slideshow): four coloured rows in which the
// player taps to find each imposter (Phase 1), then assembles the relink answer from
// the tagged tiles (Phase 2). The visual language — Tailwind class names, inline
// styles, the drop-shadow tiles, the "imposter slides to the right column" animation,
// the merged grey imposter strip — is preserved verbatim from the snapshots via
// relink-game.css (the puzzlr-relink shadow-DOM stylesheet, extracted unchanged).
//
// Usage:
//   import { mountRelinkGame } from './relink-game/relink-game.js';
//   const game = mountRelinkGame(container, puzzle, { onComplete, onFail });
//   // ...later
//   game.destroy();
//
// `puzzle` follows the save-data JSON shape (see save-data/*.json), which mirrors the
// puzzle_rows / row_members (is_imposter / is_relink) / relink_tiles model in
// relink_platform_schema.sql:
//   {
//     rows: [ { category, tiles: [ { id, text, isImpostor, isRelink } x4 ] } x4 ],
//     relink: { tiles: [ { text, source:'grid'|'fodder', sourceRowId, sourceTileId } ] }
//   }

const COLOURS = ['purple', 'blue', 'green', 'orange'];
const TILE_SHADOW = { purple: '#594fe6', blue: '#4da6ff', green: '#00cc9d', orange: '#f3ac3d' };
const TOTAL_LIVES = 4;

const CSS_HREF = new URL('./relink-game.css', import.meta.url).href;

// ---- class-string builders (kept identical to the snapshot markup) ----------
const TILE_BASE =
  'flex min-h-18 w-full items-center justify-center rounded-lg border-2 px-0.5 py-4 ' +
  'text-xs leading-[1.15] font-bold uppercase tracking-wide select-none sm:text-sm';

const tileRaisedCls = (c) =>
  `${TILE_BASE} transition-[transform,translate,box-shadow,border-color] duration-300 ` +
  `active:translate-y-0 active:shadow-none -translate-y-[3px] shadow-[0_3px_0_var(--_tile-shadow)] ` +
  `bg-relink-${c}-100 text-relink-${c}-900 border-relink-${c}-400`;

const tileFlatCls = (c) =>
  `${TILE_BASE} transition-[transform,translate,box-shadow,background-color,border-color,color,opacity,padding,width,margin] ` +
  `duration-500 ease-out bg-relink-${c}-100 text-relink-${c}-900 border-relink-${c}-100`;

const tilePickedCls = (c) =>
  `${TILE_BASE} transition-[transform,translate,box-shadow,border-color] duration-300 ` +
  `active:translate-y-0 active:shadow-none translate-y-0 shadow-none ` +
  `bg-relink-${c}-300 text-relink-${c}-900 border-relink-${c}-500`;

const tileImposterCls = () =>
  `${TILE_BASE} transition-[transform,translate,box-shadow,background-color,border-color,color,opacity,padding,width,margin] ` +
  'duration-500 ease-out bg-secondary text-secondary-foreground ' +
  'dark:bg-[color-mix(in_oklab,var(--foreground)_20%,var(--background))] dark:text-foreground ' +
  'border-secondary dark:border-[color-mix(in_oklab,var(--foreground)_20%,var(--background))] px-0.5!';

const slotBtnCls = (filled, c) =>
  filled
    ? `${TILE_BASE} transition-[background-color,border-color,color,translate,box-shadow] duration-500 ease-out ` +
      `bg-relink-${c}-100 text-relink-${c}-900 border-relink-${c}-400 ` +
      'translate-y-[-3px] shadow-[0_3px_0_var(--_tile-shadow)] active:translate-y-0 active:shadow-none'
    : `${TILE_BASE} transition-[background-color,border-color,color,translate,box-shadow] duration-500 ease-out ` +
      'bg-background border-foreground/20';

const CTRL_BTN_CLS =
  'font-body flex h-11 w-full items-center justify-center rounded-full border-2 text-lg font-semibold ' +
  'shadow-[0_3px_0_var(--_border)] transition-[translate,box-shadow] duration-100 hover:brightness-90 ' +
  'active:translate-y-[3px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-30';
const CTRL_BTN_STYLE =
  '--_surface: var(--game-relink-surface, var(--game-default-surface)); ' +
  '--_border: color-mix(in oklch, var(--_surface) 70%, black); background-color: var(--_surface); ' +
  'color: var(--game-relink-on-surface, var(--game-default-on-surface)); border-color: var(--_border);';

// small DOM helpers
const el = (tag, cls, style) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (style) n.setAttribute('style', style);
  return n;
};
const fromHTML = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const shuffleInPlace = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function normalisePuzzle(puzzle) {
  const rows = (puzzle.rows || []).slice(0, 4).map((r, ri) => ({
    index: ri,
    colour: COLOURS[ri],
    category: r.category ?? r.category_text ?? '',
    tiles: (r.tiles || []).map((t, ci) => ({
      id: t.id ?? `r${ri}w${ci}`,
      text: t.text ?? t.word ?? '',
      isImpostor: !!(t.isImpostor ?? t.is_imposter ?? t.imposter),
      isRelink: !!(t.isRelink ?? t.is_relink),
      domCol: ci,
    })),
  }));
  const relinkTiles = ((puzzle.relink && puzzle.relink.tiles) || []).map((t) => ({
    text: t.text ?? '',
    source: t.source ?? 'grid',
    sourceTileId: t.sourceTileId ?? t.source_tile_id ?? null,
    joinNext: !!(t.joinNext ?? t.join_next),
  }));
  return { rows, relinkTiles };
}

export function mountRelinkGame(container, puzzle, opts = {}) {
  const data = normalisePuzzle(puzzle);

  // one imposter per row is the convention; find the correct relink set (is_relink tiles)
  const correctRelinkIds = new Set();

  // Map each tile id -> its row colour so the success caption can colour the
  // answer chips to match the row each grid tile came from.
  const tileColourById = new Map();
  data.rows.forEach((r) => r.tiles.forEach((t) => tileColourById.set(t.id, r.colour)));
  const relinkTileColour = (rt) => {
    if (rt.sourceTileId && tileColourById.has(rt.sourceTileId)) return tileColourById.get(rt.sourceTileId);
    const match = data.rows.flatMap((r) => r.tiles).find((t) => t.isRelink && t.text === rt.text);
    return match ? tileColourById.get(match.id) : 'blue';
  };
  data.rows.forEach((r) => r.tiles.forEach((t) => { if (t.isRelink) correctRelinkIds.add(t.id); }));
  const gridSlotCount = data.relinkTiles.filter((t) => t.source === 'grid').length ||
    correctRelinkIds.size;

  // ---- shadow host + stylesheet -------------------------------------------
  const host = el('div');
  host.setAttribute('data-relink-play-host', '');
  const shadow = host.attachShadow({ mode: 'open' });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_HREF;
  shadow.appendChild(link);

  const root = el(
    'div',
    'bg-background text-foreground relative flex flex-1 flex-col items-center text-center min-h-dvh',
    '--embed-height: 600px;'
  );
  shadow.appendChild(root);

  // ---- state ---------------------------------------------------------------
  const state = {
    phase: 1, // 1 = find imposters, 2 = relink, 'done', 'failed'
    lives: TOTAL_LIVES,
    pitch: 0,
    trayPicked: [], // tile objects placed into grid slots
  };
  // per-tile runtime fields added on build: el, innerDiv, visualCol, picked, locked, rowIndex
  const refs = { dots: [], slots: [], rows: [] };

  // ---- static scaffold -----------------------------------------------------
  const wrap = el('div', 'relative w-full');
  const col = el('div', 'relative flex w-full flex-col');
  wrap.appendChild(col);
  root.appendChild(wrap);

  // branded top bar (coloured strip) — external CDN icons intentionally omitted
  col.appendChild(fromHTML(
    '<div class="relative isolate before:absolute before:inset-0 before:-right-[100vw] before:-left-[100vw] ' +
    'before:-z-10 before:content-[\'\'] before:border-b before:border-[var(--branded-border)] before:bg-[var(--branded-bg)]" ' +
    'style="--branded-bg: color-mix(in oklch, var(--game-relink-surface, var(--game-default-surface)) 50%, transparent); ' +
    '--branded-border: var(--game-relink-surface, var(--game-default-surface));">' +
    '<nav class="relative z-40 grid items-center border-b mx-auto w-full max-w-lg" ' +
    'style="grid-template-columns: 1fr auto 1fr; padding-top: 4px; padding-bottom: 4px; ' +
    'border-color: var(--game-relink-surface, var(--game-default-surface));">' +
    '<div></div><div class="flex items-center justify-center" style="width:32px;height:32px;"></div><div></div>' +
    '</nav></div>'
  ));

  const main = el('div', 'flex w-full flex-col items-center gap-4 px-2 pt-1 pb-4');
  col.appendChild(main);

  const headerWrap = el('div', 'flex min-h-7 items-center justify-center');
  const headerP = el('p', 'font-body text-foreground/70 text-sm');
  headerP.textContent = 'Find the imposter in each coloured row';
  headerWrap.appendChild(headerP);
  main.appendChild(headerWrap);

  // rows
  const boardOuter = el('div', 'w-full max-w-lg');
  const board = el('div', 'relative flex w-full flex-col gap-2');
  boardOuter.appendChild(board);
  main.appendChild(boardOuter);
  data.rows.forEach((row) => board.appendChild(buildRow(row)));

  // relink area (+ padlock overlay for Phase 1)
  const relinkOuter = el('div', 'relative w-full max-w-lg');
  const relinkStack = el('div', 'flex w-full flex-col gap-4');
  const relinkArea = el(
    'div',
    'transition-background-color relative rounded-xl p-2 duration-500 ease-out bg-foreground/10 dark:bg-[color-mix(in_oklab,var(--secondary)_85%,var(--background))]'
  );
  relinkArea.setAttribute('data-relink-area', 'true');
  const slotGrid = el('div', 'relative z-10 grid grid-cols-4 gap-1.5');
  relinkArea.appendChild(slotGrid);
  relinkStack.appendChild(relinkArea);
  relinkOuter.appendChild(relinkStack);
  main.appendChild(relinkOuter);

  // Only the player-fillable answer slots (grid tiles) appear in the tray during play.
  // Fodder (fixed connective words like "They have") is hidden until the puzzle is
  // solved, when it is revealed as part of the success sentence.
  data.relinkTiles.forEach((rt) => { if (rt.source !== 'fodder') slotGrid.appendChild(buildSlot(rt)); });

  const padlock = fromHTML(
    '<div class="bg-background/50 absolute inset-0 z-10 flex items-center justify-center rounded-xl">' +
    '<div class="text-foreground"><svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M21.225 10.5H19.4475V7.4475C19.4475 3.3375 16.1025 0 12 0C7.8975 0 4.5525 3.3375 4.5525 7.4475V10.5H2.775C2.07 10.5 1.5 11.07 1.5 11.775V22.725C1.5 23.43 2.07 24 2.775 24H21.225C21.93 24 22.5 23.43 22.5 22.725V11.775C22.5 11.07 21.93 10.5 21.225 10.5ZM6.8025 7.4475C6.8025 4.5825 9.135 2.25 12 2.25C14.865 2.25 17.1975 4.5825 17.1975 7.4475V10.5H6.8025V7.4475Z"></path>' +
    '</svg></div></div>'
  );
  relinkOuter.appendChild(padlock);

  // lives dots
  const dotsWrap = el('div', 'flex justify-center');
  const dotsRow = el('div', 'flex items-center gap-1');
  for (let i = 0; i < TOTAL_LIVES; i++) {
    const dot = el('div', 'relative h-3 w-3 rounded-full border border-foreground/80');
    dot.appendChild(el('div', 'bg-foreground/80 border-foreground/80 absolute -inset-px rounded-full border'));
    refs.dots.push(dot);
    dotsRow.appendChild(dot);
  }
  dotsWrap.appendChild(dotsRow);
  main.appendChild(dotsWrap);

  // control buttons
  const ctrls = el('div', 'grid w-full max-w-lg grid-cols-3 gap-3', 'margin-top: 0px;');
  const shuffleBtn = el('button', CTRL_BTN_CLS, CTRL_BTN_STYLE); shuffleBtn.type = 'button'; shuffleBtn.textContent = 'Shuffle';
  const clearBtn = el('button', CTRL_BTN_CLS, CTRL_BTN_STYLE); clearBtn.type = 'button'; clearBtn.textContent = 'Clear'; clearBtn.disabled = true;
  const submitBtn = el('button', CTRL_BTN_CLS, CTRL_BTN_STYLE); submitBtn.type = 'button'; submitBtn.textContent = 'Submit'; submitBtn.disabled = true;
  submitBtn.setAttribute('data-submit-button', 'true');
  ctrls.append(shuffleBtn, clearBtn, submitBtn);
  main.appendChild(ctrls);

  // ---- row / tile / slot builders -----------------------------------------
  function buildRow(row) {
    const c = row.colour;
    row.solved = false;
    row.selectedTileId = null;
    refs.rows.push(row); // register before tiles call updateTile()
    const rowEl = el('div', 'relative');
    rowEl.setAttribute('data-row-index', String(row.index));
    const inner = el('div', 'relative', 'margin-top: 0.5rem;');
    rowEl.appendChild(inner);

    const leftZone = el(
      'div', `pointer-events-none absolute origin-center rounded-xl bg-relink-${c}-100`,
      'left: 0px; top: -0.375rem; bottom: -0.375rem; width: calc(75% - 1.5px); opacity: 0; transform: scale(0.97);'
    );
    const rightZone = el(
      'div',
      'pointer-events-none absolute origin-center transition-colors duration-500 bg-foreground/10 dark:bg-[color-mix(in_oklab,var(--secondary)_85%,var(--background))]',
      'right: 0px; width: calc(25% - 1.5px); opacity: 0; top: -0.375rem; bottom: -0.375rem; border-radius: 0.75rem; transform: scale(0.97);'
    );
    inner.append(leftZone, rightZone);

    const grid = el('div', 'relative z-10 grid grid-cols-4 gap-1.5');
    row.tiles.forEach((t) => {
      t.rowIndex = row.index;
      t.visualCol = t.domCol;
      t.picked = false;
      t.locked = false;
      t.selected = false;
      const btn = el('button');
      btn.type = 'button';
      btn.setAttribute('data-tile-id', t.id);
      const innerDiv = el('div', 'flex items-center justify-center', 'width: calc(100% - 8px);');
      const span = el('span', 'max-w-full text-center wrap-break-word', 'font-size: 14px; line-height: 1.15;');
      span.textContent = t.text;
      innerDiv.appendChild(span);
      btn.appendChild(innerDiv);
      btn.addEventListener('click', () => onTileClick(t));
      t.el = btn;
      t.innerDiv = innerDiv;
      t.span = span;
      grid.appendChild(btn);
      updateTile(t);
    });
    inner.appendChild(grid);

    const label = el(
      'span',
      `pointer-events-none absolute z-20 rounded-b-sm px-3 py-0.5 font-bold tracking-wider whitespace-nowrap uppercase bg-relink-${c}-200 text-relink-${c}-900`,
      'top: -0.375rem; left: calc(37.5% - 0.75px); transform: translateX(-50%); font-size: 12px; line-height: 1.4; opacity: 0;'
    );
    label.textContent = row.category;
    inner.appendChild(label);

    row.el = rowEl;
    row.leftZone = leftZone;
    row.rightZone = rightZone;
    row.label = label;
    return rowEl;
  }

  function buildSlot(rt) {
    const slot = { relinkTile: rt, filledBy: null };
    const btn = el('button', slotBtnCls(false), 'opacity: 1; transform: none;');
    const outerSpan = el('span', 'transition-opacity duration-500 ease-out opacity-0');
    const innerSpan = el('span', 'max-w-full text-center wrap-break-word', 'font-size: 14px; line-height: 1.15;');
    outerSpan.appendChild(innerSpan);
    btn.appendChild(outerSpan);
    slot.el = btn;
    slot.outerSpan = outerSpan;
    slot.innerSpan = innerSpan;
    refs.slots.push(slot);
    return btn;
  }

  // ---- rendering -----------------------------------------------------------
  // Measure the column pitch live (layout position, unaffected by transforms).
  // Done on demand so it is always taken after the stylesheet has applied.
  function measurePitch() {
    const t = refs.rows[0]?.tiles;
    if (t && t.length > 1) {
      const p = t[1].el.offsetLeft - t[0].el.offsetLeft;
      if (p > 0) state.pitch = p;
    }
    return state.pitch;
  }

  // Shrink a tile's font-size until its text fits on a single line within the tile.
  function fitText(span, box, max = 15, min = 7) {
    if (!span || !box || !box.clientWidth) return;
    span.style.whiteSpace = 'nowrap';
    let size = max;
    span.style.fontSize = size + 'px';
    let guard = 0;
    while (size > min && box.scrollWidth > box.clientWidth && guard++ < 48) {
      size -= 0.5;
      span.style.fontSize = size + 'px';
    }
  }
  function fitAllText() {
    refs.rows.forEach((r) => r.tiles.forEach((t) => fitText(t.span, t.innerDiv)));
    refs.slots.forEach((s) => { if (s.filledBy || s.fodder) fitText(s.innerSpan, s.el); });
  }

  function tileTransformX(t) {
    const row = refs.rows[t.rowIndex];
    let x = (t.visualCol - t.domCol) * state.pitch;
    if (row.solved) x += t.isImpostor ? -1.5 : ([3, 0, -3][t.visualCol] ?? 0);
    return x;
  }

  function updateTile(t) {
    const row = refs.rows[t.rowIndex];
    const c = row.colour;
    const btn = t.el;
    btn.style.setProperty('--_tile-shadow', TILE_SHADOW[c]);
    btn.style.width = '';
    btn.style.marginInline = '';
    let innerW = 'calc(100% - 8px)';

    if (!row.solved) {
      btn.className = (state.phase === 1 && t.selected) ? tilePickedCls(c) : tileRaisedCls(c);
      btn.disabled = state.phase !== 1;
    } else if (t.isImpostor) {
      btn.className = tileImposterCls();
      btn.disabled = true;
      btn.setAttribute('data-imposter', 'true');
      btn.style.width = 'calc(100% - 8px)';
      btn.style.marginInline = '4px';
      innerW = '100%';
    } else if (state.phase === 1) {
      btn.className = tileFlatCls(c);
      btn.disabled = true;
    } else if (t.picked) {
      btn.className = tilePickedCls(c);
      btn.disabled = true;
    } else {
      btn.className = tileRaisedCls(c);
      btn.disabled = state.phase !== 2 || t.locked; // pickable in Phase 2 until tray is full
    }
    btn.style.transform = `translate(${tileTransformX(t)}px, 0px)`;
    t.innerDiv.style.width = innerW;
  }

  function updateDots() {
    refs.dots.forEach((dot, i) => {
      const filled = i < state.lives;
      const fill = dot.firstElementChild;
      if (filled && !fill) {
        dot.appendChild(el('div', 'bg-foreground/80 border-foreground/80 absolute -inset-px rounded-full border'));
      } else if (!filled && fill) {
        fill.remove();
      }
    });
  }

  function updateButtons() {
    if (state.phase === 1) {
      const anySel = refs.rows.some((r) => !r.solved && r.selectedTileId);
      clearBtn.disabled = !anySel;
      submitBtn.disabled = !anySel;
    } else if (state.phase === 2) {
      const gridSlotsFilled = refs.slots.filter((s) => !s.fodder && s.filledBy).length;
      clearBtn.disabled = state.trayPicked.length === 0;
      submitBtn.disabled = gridSlotsFilled < gridSlotCount;
    } else {
      clearBtn.disabled = true;
      submitBtn.disabled = true;
    }
  }

  // ---- interactions --------------------------------------------------------
  function shakeEl(node) {
    node.classList.remove('relink-row-shake');
    void node.offsetWidth; // reflow to restart the animation
    node.classList.add('relink-row-shake');
  }

  function onTileClick(t) {
    if (state.phase === 1) {
      const row = refs.rows[t.rowIndex];
      if (row.solved) return;
      selectTile(row, t);
    } else if (state.phase === 2) {
      if (t.isImpostor || t.picked || t.locked) return;
      pickTile(t);
    }
  }

  // Phase 1: tap a tile to select it (it presses down like a Phase-2 pick);
  // one selection per row. Submit then checks the current selections.
  function selectTile(row, t) {
    row.selectedTileId = row.selectedTileId === t.id ? null : t.id;
    row.tiles.forEach((tt) => { tt.selected = tt.id === row.selectedTileId; });
    row.tiles.forEach(updateTile);
    updateButtons();
  }

  function clearSelections() {
    refs.rows.forEach((row) => {
      if (row.solved) return;
      row.selectedTileId = null;
      row.tiles.forEach((tt) => { tt.selected = false; });
      row.tiles.forEach(updateTile);
    });
    updateButtons();
  }

  function submitGuesses() {
    refs.rows.forEach((row) => {
      if (row.solved || !row.selectedTileId) return;
      const t = row.tiles.find((x) => x.id === row.selectedTileId);
      row.selectedTileId = null;
      row.tiles.forEach((tt) => { tt.selected = false; });
      if (t && t.isImpostor) {
        solveRow(row);
      } else {
        row.tiles.forEach(updateTile);
        shakeEl(row.el);
        loseLife();
      }
    });
    updateButtons();
  }

  function solveRow(row) {
    measurePitch();
    row.solved = true;
    const specialists = row.tiles.filter((t) => !t.isImpostor).sort((a, b) => a.domCol - b.domCol);
    specialists.forEach((t, i) => { t.visualCol = i; });
    row.tiles.find((t) => t.isImpostor).visualCol = 3;
    row.leftZone.style.opacity = '1';
    row.leftZone.style.transform = 'none';
    row.rightZone.style.opacity = '1';
    row.rightZone.style.transform = 'none';
    // Solved rows show the solid black imposter bar (mirrors the Success state).
    row.rightZone.classList.remove('bg-foreground/10');
    row.rightZone.classList.add('bg-secondary');
    row.label.style.opacity = '1';
    row.tiles.forEach(updateTile);
    if (refs.rows.every((r) => r.solved)) enterPhase2();
  }

  function loseLife() {
    state.lives = Math.max(0, state.lives - 1);
    updateDots();
    if (state.lives === 0) fail();
  }

  function enterPhase2() {
    state.phase = 2;
    headerP.textContent = 'Select from the coloured tiles to Relink the imposters';
    mergeImposterZones();
    padlock.remove();
    refs.rows.forEach((r) => r.tiles.forEach(updateTile));
    updateButtons();
    requestAnimationFrame(fitAllText);
  }

  function mergeImposterZones() {
    const n = refs.rows.length;
    refs.rows.forEach((row, i) => {
      const z = row.rightZone;
      const top = i === 0 ? '-0.375rem' : '-0.5rem';
      const bottom = i === n - 1 ? '-0.375rem' : '-0.5rem';
      let radius = '0rem';
      if (i === 0) radius = '0.75rem 0.75rem 0rem 0rem';
      else if (i === n - 1) radius = '0rem 0rem 0.75rem 0.75rem';
      z.style.top = top;
      z.style.bottom = bottom;
      z.style.borderRadius = radius;
    });
  }

  function pickTile(t) {
    const slot = refs.slots.find((s) => !s.fodder && !s.filledBy);
    if (!slot) return;
    const c = refs.rows[t.rowIndex].colour;
    t.picked = true;
    slot.filledBy = t;
    slot.el.className = slotBtnCls(true, c);
    slot.el.setAttribute('style', 'opacity: 1; transform: none;');
    slot.el.style.setProperty('--_tile-shadow', TILE_SHADOW[c]);
    slot.outerSpan.className = 'transition-opacity duration-500 ease-out opacity-100';
    slot.innerSpan.textContent = t.text;
    requestAnimationFrame(() => fitText(slot.innerSpan, slot.el));
    state.trayPicked.push(t);

    const full = refs.slots.filter((s) => !s.fodder && s.filledBy).length >= gridSlotCount;
    if (full) {
      refs.rows.forEach((r) => r.tiles.forEach((tt) => { if (!tt.isImpostor && !tt.picked) tt.locked = true; }));
    }
    refs.rows.forEach((r) => r.tiles.forEach(updateTile));
    updateButtons();
  }

  function clearTray() {
    state.trayPicked = [];
    refs.rows.forEach((r) => r.tiles.forEach((t) => { t.picked = false; t.locked = false; }));
    refs.slots.forEach((slot) => {
      if (slot.fodder) return;
      slot.filledBy = null;
      slot.el.className = slotBtnCls(false);
      slot.el.setAttribute('style', 'opacity: 1; transform: none;');
      slot.outerSpan.className = 'transition-opacity duration-500 ease-out opacity-0';
      slot.innerSpan.textContent = '';
    });
    refs.rows.forEach((r) => r.tiles.forEach(updateTile));
    updateButtons();
  }

  function submitRelink() {
    const placed = new Set(state.trayPicked.map((t) => t.id));
    const correct = placed.size === correctRelinkIds.size &&
      [...placed].every((id) => correctRelinkIds.has(id));
    if (correct) win();
    else {
      shakeEl(relinkArea);
      loseLife();
    }
  }

  // Build the success caption: the writer's relink sentence, revealed only once the
  // puzzle is solved. Fodder tiles are plain uppercase connective text; grid tiles are
  // coloured chips matching their source row. Separate words are spaced apart, but a
  // run of grid tiles joined with `joinNext` — a "smoosh" — renders as a single
  // seamless pill with no gap (e.g. HER + RINGS → one "HERRINGS" pill). The markup
  // mirrors the puzzlr success snapshot (Saved html from Relink/Success.html).
  function buildAnswerCaption() {
    const wrap = el(
      'div',
      'relative z-10 flex min-h-14 flex-wrap items-center justify-center px-1 py-1'
    );

    // Group the tiles: fodder is its own text group; consecutive grid tiles chained by
    // `joinNext` form one smoosh group, otherwise each grid tile is its own group.
    const groups = [];
    let current = null;
    data.relinkTiles.forEach((rt) => {
      if (rt.source === 'fodder') {
        groups.push({ type: 'fodder', text: rt.text });
        current = null;
        return;
      }
      if (current) {
        current.tiles.push(rt);
      } else {
        current = { type: 'grid', tiles: [rt] };
        groups.push(current);
      }
      if (!rt.joinNext) current = null; // this run ends here
    });

    const spacer = () =>
      el('span', 'text-xs font-bold tracking-wider whitespace-pre uppercase text-secondary-foreground');

    const chipText = (text) => {
      const s = el('span', 'max-w-full text-center wrap-break-word');
      s.textContent = text;
      return s;
    };

    groups.forEach((g, gi) => {
      if (gi > 0) {
        const sp = spacer();
        sp.textContent = ' ';
        wrap.appendChild(sp);
      }
      if (g.type === 'fodder') {
        const s = spacer();
        s.classList.remove('whitespace-pre');
        s.textContent = g.text;
        wrap.appendChild(s);
        return;
      }
      if (g.tiles.length === 1) {
        const c = relinkTileColour(g.tiles[0]);
        const chip = el(
          'span',
          'inline-flex items-center justify-center rounded-md px-3 py-1 text-xs font-bold ' +
          `tracking-wider whitespace-nowrap uppercase bg-relink-${c}-200 text-relink-${c}-900`
        );
        chip.appendChild(chipText(g.tiles[0].text));
        wrap.appendChild(chip);
        return;
      }
      // Smoosh pill: multiple coloured segments joined seamlessly (no gap).
      const pill = el(
        'span',
        'inline-flex max-w-full items-stretch justify-center overflow-hidden rounded-md ' +
        'text-xs font-bold tracking-wider whitespace-nowrap uppercase'
      );
      g.tiles.forEach((rt, i) => {
        const c = relinkTileColour(rt);
        const first = i === 0;
        const last = i === g.tiles.length - 1;
        const pad = first ? 'pl-3 pr-0.5' : last ? 'pl-0.5 pr-3' : 'px-0.5';
        const seg = el(
          'span',
          `inline-flex min-w-0 items-center justify-center py-1 ${pad} bg-relink-${c}-200 text-relink-${c}-900`
        );
        seg.appendChild(chipText(rt.text));
        pill.appendChild(seg);
      });
      wrap.appendChild(pill);
    });
    return wrap;
  }

  function win() {
    state.phase = 'done';
    headerP.textContent = 'Solved!';
    headerP.className = 'font-body text-sm font-semibold text-[#009b72]';
    ctrls.remove();

    // On success, reveal the writer's relink sentence as a caption in the black bar:
    // fodder → plain connective text, grid tiles → coloured chips matching their row.
    // This is hidden during play and only shown once the puzzle is correct. If there
    // is no relink sentence, fall back to the plain success box.
    if (data.relinkTiles.length) {
      const caption = buildAnswerCaption();
      caption.style.transition = 'opacity 0.5s ease-out, transform 0.5s ease-out';
      caption.style.opacity = '0';
      caption.style.transform = 'scale(0.96)';
      slotGrid.style.transition = 'opacity 0.35s ease-out';
      slotGrid.style.opacity = '0';
      relinkArea.className =
        'transition-background-color relative rounded-xl p-2 duration-500 ease-out ' +
        'bg-secondary dark:bg-[color-mix(in_oklab,var(--secondary)_85%,var(--background))]';
      setTimeout(() => {
        slotGrid.remove();
        relinkArea.appendChild(caption);
        requestAnimationFrame(() => {
          caption.style.opacity = '1';
          caption.style.transform = 'none';
        });
      }, 350);
    } else {
      relinkArea.className =
        'transition-background-color relative rounded-xl p-2 duration-500 ease-out bg-success/10';
    }

    if (typeof opts.onComplete === 'function') opts.onComplete();
  }

  function fail() {
    state.phase = 'failed';
    headerP.textContent = 'Out of guesses';
    headerP.className = 'font-body text-sm font-semibold text-[#c51f2d]';
    refs.rows.forEach((r) => r.tiles.forEach((t) => { t.el.disabled = true; }));
    shuffleBtn.disabled = true;
    clearBtn.disabled = true;
    submitBtn.disabled = true;
    if (typeof opts.onFail === 'function') opts.onFail();
  }

  function shuffleGrid() {
    if (state.phase !== 1 && state.phase !== 2) return;
    measurePitch();
    refs.rows.forEach((row) => {
      if (row.solved) {
        const specs = row.tiles.filter((t) => !t.isImpostor);
        const cols = shuffleInPlace(specs.map((t) => t.visualCol));
        specs.forEach((t, i) => { t.visualCol = cols[i]; });
      } else {
        const cols = shuffleInPlace(row.tiles.map((t) => t.visualCol));
        row.tiles.forEach((t, i) => { t.visualCol = cols[i]; });
      }
      row.tiles.forEach(updateTile);
    });
  }

  shuffleBtn.addEventListener('click', shuffleGrid);
  clearBtn.addEventListener('click', () => {
    if (state.phase === 1) clearSelections();
    else if (state.phase === 2) clearTray();
  });
  submitBtn.addEventListener('click', () => {
    if (state.phase === 1) submitGuesses();
    else if (state.phase === 2) submitRelink();
  });

  // ---- mount --------------------------------------------------------------
  container.appendChild(host);

  const runLayout = () => { measurePitch(); fitAllText(); };
  requestAnimationFrame(runLayout);
  link.addEventListener('load', runLayout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(runLayout).catch(() => {});
  const onResize = () => fitAllText();
  window.addEventListener('resize', onResize);

  return {
    host,
    destroy() {
      window.removeEventListener('resize', onResize);
      host.remove();
    },
    getState() { return { phase: state.phase, lives: state.lives }; },
  };
}
