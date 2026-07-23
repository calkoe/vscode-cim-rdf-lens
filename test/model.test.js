'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parse, normalizeId } = require('../src/parser');
const { analyze } = require('../src/graph');
const { barsSvg, signature } = require('../src/svg');

const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<!-- <cim:Breaker rdf:about="urn:uuid:deadbeef"> auskommentiert, zaehlt nicht -->
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:cim="http://iec.ch/TC57/CIM100#">
  <cim:Breaker rdf:about="urn:uuid:aaaa0001">
    <cim:IdentifiedObject.name>LS-1</cim:IdentifiedObject.name>
  </cim:Breaker>
  <cim:Terminal rdf:about="urn:uuid:aaaa0002">
    <cim:IdentifiedObject.name>LS-1-T1</cim:IdentifiedObject.name>
    <cim:Terminal.ConductingEquipment rdf:resource="urn:uuid:aaaa0001"/>
  </cim:Terminal>
  <cim:Analog rdf:about="urn:uuid:aaaa0011">
    <cim:IdentifiedObject.name>current_a</cim:IdentifiedObject.name>
    <cim:Measurement.unitSymbol rdf:resource="http://iec.ch/TC57/CIM100#UnitSymbol.A"/>
    <cim:Measurement.Terminal rdf:resource="urn:uuid:aaaa0002"/>
    <cim:Measurement.PowerSystemResource rdf:resource="urn:uuid:aaaa0001"/>
  </cim:Analog>
</rdf:RDF>
`;

const KEY = { breaker: 'aaaa0001', terminal: 'aaaa0002', analog: 'aaaa0011' };

test('normalizeId vereinheitlicht die Schreibweisen einer Kennung', () => {
  assert.equal(normalizeId('urn:uuid:AAAA0001'), 'aaaa0001');
  assert.equal(normalizeId('#_aaaa0001'), 'aaaa0001');
  assert.equal(normalizeId('  aaaa0001  '), 'aaaa0001');
  // Externe URIs bleiben, wie sie sind, und finden so kein Gegenstueck.
  assert.equal(
    normalizeId('http://iec.ch/TC57/CIM100#UnitSymbol.A'),
    'http://iec.ch/tc57/cim100#unitsymbol.a',
  );
});

test('parse findet Definitionen, Namen und Bloecke', () => {
  const parsed = parse(FIXTURE);
  assert.equal(parsed.nodes.size, 3, 'der auskommentierte Breaker darf nicht zaehlen');
  assert.equal(parsed.nodes.get(KEY.breaker).tag, 'cim:Breaker');
  assert.equal(parsed.nodes.get(KEY.breaker).name, 'LS-1');
  assert.equal(parsed.nodes.get(KEY.analog).name, 'current_a');

  const analog = parsed.nodes.get(KEY.analog);
  assert.equal(FIXTURE.split('\n')[analog.startLine].includes('<cim:Analog'), true);
  assert.equal(FIXTURE.split('\n')[analog.endLine].includes('</cim:Analog>'), true);
});

test('parse ordnet Referenzen ihrem umgebenden Block zu', () => {
  const parsed = parse(FIXTURE);
  const internal = parsed.refs.filter((ref) => parsed.nodes.has(ref.targetKey));
  assert.equal(internal.length, 3);
  for (const ref of internal) {
    assert.ok([KEY.terminal, KEY.analog].includes(ref.ownerKey));
  }
  // Der Verweis auf das Einheiten-Enum ist eine Referenz, aber kein Elter.
  assert.equal(parsed.refs.length, 4);
});

test('analyze legt die Hierarchie ueber den laengsten Weg zur Wurzel', () => {
  const model = analyze(parse(FIXTURE));
  assert.equal(model.depth.get(KEY.breaker), 0);
  assert.equal(model.depth.get(KEY.terminal), 1);
  // Analog haengt am Terminal *und* direkt am Breaker -- der laengere Weg gewinnt.
  assert.equal(model.depth.get(KEY.analog), 2);
  assert.deepEqual(model.chain.get(KEY.analog), [KEY.breaker, KEY.terminal, KEY.analog]);
});

test('analyze faerbt jedes Objekt unterschiedlich', () => {
  const model = analyze(parse(FIXTURE));
  const colors = new Set([...model.color.values()]);
  assert.equal(colors.size, model.nodes.size);
});

test('Balkenfolge je Zeile: Vorfahrenkette, eigener Block zuletzt', () => {
  const model = analyze(parse(FIXTURE));
  const analog = model.nodes.get(KEY.analog);
  const bars = model.lineStacks.get(analog.startLine);
  assert.equal(bars.length, 3);
  assert.deepEqual(
    bars.map((bar) => bar.strong),
    [false, false, true],
  );
  assert.equal(bars[0].color, model.color.get(KEY.breaker));
});

test('alle Zeilen eines Blocks tragen dieselbe Balkenfolge (durchgehend)', () => {
  const model = analyze(parse(FIXTURE));
  const analog = model.nodes.get(KEY.analog);
  const first = model.lineStacks.get(analog.startLine);
  for (let line = analog.startLine; line <= analog.endLine; line++) {
    assert.deepEqual(model.lineStacks.get(line), first, `Zeile ${line} bricht aus`);
  }
});

test('Standard: Referenzzeilen bekommen keinen Zusatzbalken', () => {
  const lines = FIXTURE.split('\n');
  const model = analyze(parse(FIXTURE));
  for (const needle of ['Measurement.PowerSystemResource', 'Measurement.Terminal', 'unitSymbol']) {
    const line = lines.findIndex((text) => text.includes(needle));
    assert.equal(model.lineStacks.get(line).length, 3, needle);
  }
});

test('markReferences: true haengt den Zielbalken wieder an', () => {
  const lines = FIXTURE.split('\n');
  const model = analyze(parse(FIXTURE), { markReferences: true });
  const line = lines.findIndex((text) => text.includes('Measurement.PowerSystemResource'));
  const bars = model.lineStacks.get(line);
  assert.equal(bars.length, 4, 'drei Ebenen des Blocks plus der Verweis');
  assert.equal(bars[3].color, model.color.get(KEY.breaker));
  assert.equal(bars[3].link, true);

  // Auch dann bleibt eine Referenz aus der Datei heraus unmarkiert.
  const external = lines.findIndex((text) => text.includes('unitSymbol'));
  assert.equal(model.lineStacks.get(external).length, 3);
});

test('columns ist dokumentweit, damit die Spalten fluchten', () => {
  const model = analyze(parse(FIXTURE));
  let widest = 0;
  for (const bars of model.lineStacks.values()) widest = Math.max(widest, bars.length);
  assert.equal(model.columns, widest);
  // Tiefster Block ist cim:Analog auf Ebene 2 -> drei Balken, keine Zusatzspalte.
  assert.equal(model.columns, 3);
});

test('maxColumns kuerzt tiefe Ketten und behaelt die Wurzel', () => {
  const model = analyze(parse(FIXTURE), { maxColumns: 2 });
  assert.equal(model.columns, 2);
  for (const bars of model.lineStacks.values()) assert.ok(bars.length <= 2);
});

test('Zyklen bringen den Graphen nicht zum Haengen', () => {
  const cyclic = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cim="x#">
  <cim:A rdf:about="urn:uuid:1"><cim:r rdf:resource="urn:uuid:2"/></cim:A>
  <cim:B rdf:about="urn:uuid:2"><cim:r rdf:resource="urn:uuid:1"/></cim:B>
</rdf:RDF>`;
  const model = analyze(parse(cyclic));
  assert.equal(model.nodes.size, 2);
  for (const chain of model.chain.values()) assert.ok(chain.length <= 2);
});

test('unvollstaendiges Markup (Tippzustand) wirft nicht', () => {
  assert.doesNotThrow(() => analyze(parse('<cim:Breaker rdf:about="urn:uuid:1">')));
  assert.doesNotThrow(() => analyze(parse('<cim:Breaker rdf:about=')));
  assert.doesNotThrow(() => analyze(parse('')));
});

test('SVG: eine viewBox fuer alle Zeilen, ein Rechteck je Balken', () => {
  const bars = [
    { color: '#4f9dff', strong: false },
    { color: '#ff8a3d', strong: true },
  ];
  const svg = barsSvg(bars, 4, { dim: 0.45, fill: 0.66 });
  assert.match(svg, /viewBox="0 0 16 16"/);
  assert.equal((svg.match(/<rect /g) || []).length, 2);
  assert.match(svg, /fill="#4f9dff" fill-opacity="0.45"/);
  assert.match(svg, /fill="#ff8a3d" fill-opacity="1"/);
  // Spalte 2 sitzt eine Slotbreite (16/4) weiter rechts als Spalte 1.
  const xs = [...svg.matchAll(/x="([\d.]+)"/g)].map((match) => Number(match[1]));
  assert.equal(Math.round((xs[1] - xs[0]) * 100) / 100, 4);
});

test('Balken sind standardmaessig voll deckend -- gleiche Farbe wie am Ursprung', () => {
  const bars = [
    { color: '#4f9dff', strong: false },
    { color: '#ff8a3d', strong: true },
  ];
  const svg = barsSvg(bars, 4);
  const opacities = [...svg.matchAll(/fill-opacity="([\d.]+)"/g)].map((m) => m[1]);
  assert.deepEqual(opacities, ['1', '1']);
});

test('bei voller Deckkraft fallen Vorfahr und eigener Block auf eine Signatur', () => {
  const strong = [{ color: '#111111', strong: true }];
  const weak = [{ color: '#111111', strong: false }];
  // Gleiches Bild -> gleiche Signatur -> ein Dekorationstyp statt zwei.
  assert.equal(signature(strong, 3, {}), signature(weak, 3, {}));
  // Wer die Abschwaechung will, bekommt sie weiterhin.
  assert.notEqual(signature(strong, 3, { dim: 0.45 }), signature(weak, 3, { dim: 0.45 }));
});

test('Unterstriche treffen die UUID, nicht das urn:uuid:-Praefix', () => {
  const model = analyze(parse(FIXTURE));
  const marks = model.underlines;

  // 3 Definitionen + 3 dateiinterne Referenzen; UnitSymbol.A ist nicht dabei.
  assert.equal(marks.length, 6);
  for (const mark of marks) {
    assert.equal(FIXTURE.slice(mark.start, mark.end).toLowerCase(), mark.key);
    assert.equal(mark.color, model.color.get(mark.key));
  }

  const definitions = marks.filter((mark) => mark.kind === 'definition');
  assert.equal(definitions.length, 3);
  // Direkt vor der Kennung steht das Praefix, nicht das Anfuehrungszeichen.
  assert.equal(FIXTURE.slice(definitions[0].start - 9, definitions[0].start), 'urn:uuid:');
});

test('Definition und Referenz derselben UUID werden gleich unterstrichen', () => {
  const model = analyze(parse(FIXTURE));
  const colors = new Set(
    model.underlines.filter((mark) => mark.key === KEY.breaker).map((mark) => mark.color),
  );
  assert.equal(colors.size, 1);
  assert.equal([...colors][0], model.color.get(KEY.breaker));
});

test('signature trennt Zeilen, die verschieden aussehen muessen', () => {
  const a = [{ color: '#111111', strong: true }];
  const b = [{ color: '#111111', strong: false }];
  const opts = { dim: 0.45, fill: 0.66 };
  assert.notEqual(signature(a, 3, opts), signature(b, 3, opts));
  assert.notEqual(signature(a, 3, opts), signature(a, 4, opts));
  assert.equal(signature(a, 3, opts), signature([{ ...a[0] }], 3, opts));
});

// --- Gegenprobe an der echten Modelldatei des Projekts ---------------------

const REAL = path.join(__dirname, '..', '..', '..', 'contracts', 'model', 'leistungsschalter.rdf');

test('leistungsschalter.rdf: der erwartete CIM-Baum', { skip: !fs.existsSync(REAL) }, () => {
  const model = analyze(parse(fs.readFileSync(REAL, 'utf8')));
  const byName = new Map();
  for (const node of model.orderedNodes) {
    if (node.name) byName.set(`${node.tag}/${node.name}`, node);
  }

  assert.equal(model.nodes.size, 22, 'Breaker, Terminal, 4 Analog, 4 LimitSet, 6 Limit, Discrete, ValueAliasSet, 4 ValueToAlias');

  // 22 Objekte auf 12 Paletteneintraege: die Palette muss verlaengert worden
  // sein, sonst haetten zwei Bloecke dieselbe Farbe.
  assert.equal(new Set([...model.color.values()]).size, 22);

  const breaker = byName.get('cim:Breaker/LS-DUMMY-01');
  const current = byName.get('cim:Analog/current_a');
  assert.ok(breaker && current);

  // Der tiefste Zweig: Breaker > Terminal > Analog > AnalogLimitSet > AnalogLimit.
  const limit = model.orderedNodes.find(
    (node) => node.tag === 'cim:AnalogLimit' && model.depth.get(node.key) === 4,
  );
  assert.ok(limit, 'es muss einen Grenzwert auf Ebene 4 geben');
  const chain = model.chain.get(limit.key).map((key) => model.nodes.get(key).tag);
  assert.deepEqual(chain, [
    'cim:Breaker',
    'cim:Terminal',
    'cim:Analog',
    'cim:AnalogLimitSet',
    'cim:AnalogLimit',
  ]);

  // ValueToAlias haengt am ValueAliasSet, das keine Referenz hat -- eigene Wurzel.
  const alias = model.orderedNodes.find((node) => node.tag === 'cim:ValueToAlias');
  assert.equal(model.depth.get(alias.key), 1);
  assert.equal(model.nodes.get(model.chain.get(alias.key)[0]).tag, 'cim:ValueAliasSet');

  // Jede Zeile des Breaker-Blocks traegt genau einen kraeftigen Balken.
  const bars = model.lineStacks.get(breaker.startLine);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].strong, true);
  assert.equal(bars[0].color, model.color.get(breaker.key));
});
