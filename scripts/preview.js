'use strict';

/**
 * Zeigt im Terminal, was die Extension in die Rinne zeichnen wuerde.
 *
 *   npm run preview -- ../../contracts/model/leistungsschalter.rdf
 *
 * Gedacht zum Nachsehen und zum Debuggen: dieselben Module wie im Editor,
 * nur mit ANSI-Farbe statt SVG. Wer die Hierarchie einer neuen Datei pruefen
 * will, muss dafuer keinen Extension-Host starten.
 */

const fs = require('node:fs');
const path = require('node:path');

const { parse } = require('../src/parser');
const { analyze } = require('../src/graph');

const BLOCK = '█';

// Konstante Farbe je Objekt -- wie im Editor. Ein Vorfahrenbalken sieht genau
// so aus wie der Block, zu dem er gehoert; das ist der ganze Zweck.
function ansi(hex) {
  const value = String(hex).replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `[38;2;${r};${g};${b}m`;
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('Aufruf: node scripts/preview.js <datei.rdf>');
    process.exit(2);
  }
  const file = path.resolve(process.cwd(), target);
  const text = fs.readFileSync(file, 'utf8');
  const model = analyze(parse(text));
  const lines = text.split('\n');

  console.log(`${file}\n${model.nodes.size} Objekte, ${model.columns} Balkenspalten\n`);

  lines.forEach((line, index) => {
    const bars = model.lineStacks.get(index) || [];
    let gutter = '';
    for (let column = 0; column < model.columns; column++) {
      const bar = bars[column];
      gutter += bar ? `${ansi(bar.color)}${BLOCK}[0m` : ' ';
    }
    console.log(`${gutter} ${String(index + 1).padStart(4)} ${line}`);
  });

  console.log('\nObjekte:');
  for (const node of model.orderedNodes) {
    const indent = '  '.repeat(model.depth.get(node.key));
    const color = model.color.get(node.key);
    console.log(
      `  ${ansi(color)}${BLOCK}${BLOCK}[0m ${indent}${node.tag}` +
        `${node.name ? ` "${node.name}"` : ''}  ${color}`,
    );
  }
}

main();
