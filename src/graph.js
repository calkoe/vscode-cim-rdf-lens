'use strict';

/**
 * Aus Definitionen und Referenzen wird hier der Baum, den die Balken zeigen.
 *
 * Richtung: eine Referenz zeigt vom Kind zum Elter. `cim:AnalogLimit` nennt sein
 * `LimitSet`, das Set nennt seine `Measurements`, die Messgroesse nennt ihre
 * `PowerSystemResource` -- wer den rdf:resource-Kanten folgt, laeuft also zur
 * Wurzel. Ein Objekt ohne aufloesbare Referenz *ist* eine Wurzel.
 *
 * Das Ergebnis ist ein DAG, kein Baum: cim:Analog haengt sowohl am Terminal als
 * auch direkt am Betriebsmittel. Fuer die Balkenreihenfolge braucht es aber
 * genau einen Pfad, also gewinnt der laengste -- Breaker > Terminal > Analog
 * statt Breaker > Analog. So sieht man die tiefste Einbettung, in der ein Objekt
 * steht, und nicht die zufaellig erste.
 *
 * Auch dieses Modul kennt vscode nicht.
 */

const DEFAULT_PALETTE = [
  '#4f9dff', '#ff8a3d', '#3ec98a', '#c77dff',
  '#ffd23f', '#ff5c8a', '#2ec5c5', '#a3d94a',
  '#ff6b5b', '#8b9dff', '#d9a066', '#6fd3ff',
];

const DEFAULTS = {
  palette: DEFAULT_PALETTE,
  maxColumns: 8,
  // Aus: ein Balken, der nur eine einzelne Zeile lang ist, unterbricht die
  // durchgehenden Blockbalken und sagt nichts, was der farbige Unterstrich
  // unter der UUID nicht schon sagt. Die Balken beschreiben die Hierarchie,
  // die Unterstriche die Verweise -- zwei Aufgaben, zwei Mittel.
  markReferences: false,
};

function analyze(parsed, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const palette = opts.palette && opts.palette.length ? opts.palette : DEFAULT_PALETTE;

  const ordered = [...parsed.nodes.values()].sort(
    (a, b) => a.startLine - b.startLine || (a.key < b.key ? -1 : 1),
  );

  const parents = new Map();
  for (const node of ordered) {
    // Nur dateiinterne Ziele sind Eltern. Verweise auf Enum-Literale wie
    // UnitSymbol.A zeigen aus der Datei heraus und stiften keine Hierarchie.
    const list = [];
    for (const target of node.refs) {
      if (target !== node.key && parsed.nodes.has(target)) list.push(target);
    }
    parents.set(node.key, list);
  }

  const depth = buildDepths(ordered, parents);
  const chain = buildChains(ordered, parents, depth, parsed.nodes);
  const color = assignColors(ordered, palette);

  const { lineStacks, columns } = buildLineStacks(parsed, { chain, color }, opts);

  return {
    nodes: parsed.nodes,
    refs: parsed.refs,
    orderedNodes: ordered,
    parents,
    depth,
    chain,
    color,
    lineStacks,
    columns,
    underlines: buildUnderlines(parsed, color),
  };
}

/**
 * Die Stellen im Text, an denen eine Kennung steht -- Definition wie Referenz,
 * jeweils in der Farbe des gemeinten Objekts.
 *
 * Unterstrichen wird, nicht eingefaerbt: die Schriftfarbe gehoert dem
 * XML-Highlighting, der Unterstrich ist frei. Dieselbe Farbe wie am
 * Balken, damit beide dasselbe sagen.
 */
function buildUnderlines(parsed, color) {
  const marks = [];
  for (const node of parsed.nodes.values()) {
    if (!node.idRange) continue;
    marks.push({ ...node.idRange, key: node.key, color: color.get(node.key), kind: 'definition' });
  }
  for (const ref of parsed.refs) {
    // Verweise aus der Datei heraus haben kein Objekt und damit keine Farbe.
    if (!ref.targetRange || !parsed.nodes.has(ref.targetKey)) continue;
    marks.push({
      ...ref.targetRange,
      key: ref.targetKey,
      color: color.get(ref.targetKey),
      kind: 'reference',
    });
  }
  marks.sort((a, b) => a.start - b.start);
  return marks;
}

/** Laengster Weg zu einer Wurzel. Zyklen werden als Tiefe 0 gedeckelt. */
function buildDepths(ordered, parents) {
  const depth = new Map();
  const visiting = new Set();

  const compute = (key) => {
    if (depth.has(key)) return depth.get(key);
    if (visiting.has(key)) return 0;
    visiting.add(key);
    let best = 0;
    for (const parent of parents.get(key) || []) {
      best = Math.max(best, compute(parent) + 1);
    }
    visiting.delete(key);
    depth.set(key, best);
    return best;
  };

  for (const node of ordered) compute(node.key);
  return depth;
}

function buildChains(ordered, parents, depth, nodes) {
  const chain = new Map();

  const primaryParent = (key) => {
    let best = null;
    for (const candidate of parents.get(key) || []) {
      // Nur echte Vorfahren: gleich tief oder tiefer waere ein Zyklus.
      if (depth.get(candidate) >= depth.get(key)) continue;
      if (best === null) {
        best = candidate;
        continue;
      }
      const a = depth.get(candidate);
      const b = depth.get(best);
      if (a > b || (a === b && nodes.get(candidate).startLine < nodes.get(best).startLine)) {
        best = candidate;
      }
    }
    return best;
  };

  const compute = (key, seen) => {
    if (chain.has(key)) return chain.get(key);
    if (seen.has(key)) return [key];
    seen.add(key);
    const parent = primaryParent(key);
    const result = parent ? [...compute(parent, seen), key] : [key];
    seen.delete(key);
    chain.set(key, result);
    return result;
  };

  for (const node of ordered) compute(node.key, new Set());
  return chain;
}

/**
 * Farbe je Objekt, moeglichst stabil und moeglichst verschieden.
 *
 * Startplatz ist ein Hash der UUID -- damit behaelt ein Objekt seine Farbe auch
 * dann, wenn ueber ihm etwas eingefuegt wird. Ist der Platz belegt, rueckt die
 * Vergabe weiter (lineares Sondieren), sonst saehen zwei Nachbarn im selben
 * Dokument gleich aus.
 *
 * Reicht die Palette nicht, wird sie verlaengert statt wiederholt: eine
 * Modelldatei hat schnell mehr Objekte als eine handverlesene Palette Farben
 * (leistungsschalter.rdf hat 22), und zwei gleichfarbige Bloecke sind genau die
 * Verwechslung, die die Balken verhindern sollen.
 */
function assignColors(ordered, palette) {
  const colors = extendPalette(palette, ordered.length);
  const color = new Map();
  let taken = new Set();
  for (const node of ordered) {
    if (taken.size >= colors.length) taken = new Set();
    let index = hash(node.key) % colors.length;
    for (let probe = 0; probe < colors.length && taken.has(index); probe++) {
      index = (index + 1) % colors.length;
    }
    taken.add(index);
    color.set(node.key, colors[index]);
  }
  return color;
}

/**
 * Palette auf die noetige Laenge bringen. Die konfigurierten Farben bleiben
 * vorn; angehaengt wird im goldenen Winkel, weil aufeinanderfolgende Farbtoene
 * damit am weitesten auseinanderliegen. Ueber MAX_COLORS wird wiederholt -- so
 * viele unterscheidbare Balken sieht ohnehin niemand.
 */
const MAX_COLORS = 64;

function extendPalette(palette, needed) {
  const colors = palette.slice();
  const target = Math.min(Math.max(needed, 1), MAX_COLORS);
  for (let step = 0; colors.length < target; step++) {
    const hue = (colors.length * 137.508) % 360;
    colors.push(hslToHex(hue, 58 + (step % 2) * 18, 60 + (step % 3) * 7));
  }
  return colors;
}

function hslToHex(h, s, l) {
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  const sector = Math.floor(h / 60) % 6;
  const rgb = [
    [chroma, secondary, 0],
    [secondary, chroma, 0],
    [0, chroma, secondary],
    [0, secondary, chroma],
    [secondary, 0, chroma],
    [chroma, 0, secondary],
  ][sector];
  return (
    '#' +
    rgb
      .map((channel) =>
        Math.round((channel + match) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

function hash(text) {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/**
 * Je Zeile die Balkenfolge, links die Wurzel.
 *
 * Grundlage ist allein der Block, in dem die Zeile liegt: seine Vorfahrenkette,
 * er selbst zuletzt. Alle Zeilen eines Blocks bekommen dieselbe Folge, sodass
 * die Balken ueber den ganzen Block durchlaufen -- das macht die Einbettung auf
 * einen Blick lesbar.
 *
 * Nur mit `markReferences` kommt auf Zeilen mit rdf:resource rechts ein
 * einzelner Balken in der Farbe des Ziels hinzu (Standard aus).
 */
function buildLineStacks(parsed, model, opts) {
  const stacks = new Map();

  // Grosse Bloecke zuerst, damit ein verschachtelter Block den umgebenden
  // ueberschreibt: die innerste Zugehoerigkeit ist die interessante.
  const byExtent = [...parsed.nodes.values()].sort(
    (a, b) => b.endLine - b.startLine - (a.endLine - a.startLine),
  );
  for (const node of byExtent) {
    const keys = model.chain.get(node.key) || [node.key];
    const bars = keys.map((key, index) => ({
      key,
      color: model.color.get(key),
      strong: index === keys.length - 1,
    }));
    for (let line = node.startLine; line <= node.endLine; line++) stacks.set(line, bars);
  }

  if (opts.markReferences) {
    for (const ref of parsed.refs) {
      if (!parsed.nodes.has(ref.targetKey)) continue;
      if (ref.ownerKey === ref.targetKey) continue;
      const bar = {
        key: ref.targetKey,
        color: model.color.get(ref.targetKey),
        strong: true,
        link: true,
      };
      for (let line = ref.startLine; line <= ref.endLine; line++) {
        stacks.set(line, (stacks.get(line) || []).concat([bar]));
      }
    }
  }

  let columns = 1;
  for (const bars of stacks.values()) columns = Math.max(columns, bars.length);

  const limit = Math.max(2, opts.maxColumns);
  if (columns > limit) {
    // Zu tief fuer die Rinne: Wurzel behalten, dann von rechts auffuellen. Die
    // Mitte faellt weg -- Wurzel und unmittelbare Umgebung tragen die Aussage.
    for (const [line, bars] of stacks) {
      if (bars.length > limit) stacks.set(line, [bars[0], ...bars.slice(bars.length - (limit - 1))]);
    }
    columns = limit;
  }

  return { lineStacks: stacks, columns };
}

module.exports = { analyze, DEFAULT_PALETTE };
