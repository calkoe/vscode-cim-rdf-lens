'use strict';

/**
 * Die Balken selbst: ein SVG je vorkommender Balkenfolge, als data:-URI.
 *
 * Warum ein Bild und nicht mehrere Dekorationen uebereinander: VS Code zeichnet
 * pro Zeile genau ein Gutter-Icon. Gestapelte Balken muessen also in *einem*
 * Bild stehen -- deshalb wird die ganze Folge in ein SVG gerechnet.
 *
 * Warum fuer alle Zeilen dieselbe viewBox-Breite: nur so liegen gleiche Ebenen
 * ueber alle Zeilen in derselben Spalte. Waere das Bild pro Zeile so breit wie
 * ihre Balkenzahl, wuerde `contain` jede Zeile anders skalieren und aus den
 * Spalten wuerde eine Treppe. Die Zahl der Spalten ist deshalb eine Eigenschaft
 * des Dokuments, nicht der Zeile.
 *
 * Kein vscode-Import -- damit testbar.
 */

const VIEW = 16; // Kantenlaenge der viewBox; quadratisch, weil die Rinne es ist.

// Vorfahren werden standardmaessig *nicht* abgeschwaecht.
//
// Eine halbtransparente Farbe mischt sich mit dem Editor-Hintergrund und ist
// damit ein anderer Farbton als derselbe Balken am Ursprungsblock -- genau die
// Zuordnung, die die Balken herstellen sollen, geht dabei verloren. Welcher
// Balken der eigene Block ist, sagt schon die Spalte (der aeusserste ohne
// Verweis); dafuer braucht es keine zweite Codierung ueber die Deckkraft.
const DEFAULT_DIM = 1;

function barsSvg(bars, columns, options = {}) {
  const dim = clamp(options.dim === undefined ? DEFAULT_DIM : options.dim, 0.05, 1);
  const fill = clamp(options.fill === undefined ? 0.66 : options.fill, 0.1, 1);
  const slots = Math.max(columns, 1);
  const slot = VIEW / slots;
  const width = Math.max(slot * fill, 0.75);

  const rects = bars
    .map((bar, index) => {
      const x = index * slot + (slot - width) / 2;
      const opacity = bar.strong ? 1 : dim;
      return (
        `<rect x="${round(x)}" y="0" width="${round(width)}" height="${VIEW}"` +
        ` fill="${escapeAttr(bar.color)}" fill-opacity="${round(opacity)}"/>`
      );
    })
    .join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEW}" height="${VIEW}"` +
    ` viewBox="0 0 ${VIEW} ${VIEW}" shape-rendering="crispEdges">${rects}</svg>`
  );
}

function barsDataUri(bars, columns, options) {
  const svg = barsSvg(bars, columns, options);
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

/**
 * Erkennungsmerkmal einer Balkenfolge. Zeilen mit gleicher Signatur teilen sich
 * eine Dekoration -- bei ein paar hundert Zeilen und einer Handvoll Bloecken
 * bleiben so wenige Dekorationstypen statt einem pro Zeile.
 */
function signature(bars, columns, options = {}) {
  // Nach der *gezeichneten* Deckkraft unterscheiden, nicht nach dem
  // strong-Flag: bei voller Deckkraft sehen Vorfahr und eigener Block gleich
  // aus, und zwei Signaturen fuer dasselbe Bild waeren zwei Dekorationstypen
  // fuer nichts.
  const dim = options.dim === undefined ? DEFAULT_DIM : options.dim;
  const shape = bars.map((bar) => `${bar.color}@${bar.strong ? 1 : dim}`).join(',');
  return `${columns}|${options.fill}|${shape}`;
}

/** Farbe des Objekts, zu dem die Zeile gehoert -- fuer die Uebersichtsleiste. */
function ownColor(bars) {
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].strong && !bars[i].link) return bars[i].color;
  }
  return bars.length ? bars[bars.length - 1].color : undefined;
}

function clamp(value, low, high) {
  if (typeof value !== 'number' || Number.isNaN(value)) return low;
  return Math.min(high, Math.max(low, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function escapeAttr(value) {
  return String(value === undefined || value === null ? '#888888' : value).replace(
    /[<>&"']/g,
    (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char],
  );
}

module.exports = { barsSvg, barsDataUri, signature, ownColor, VIEW, DEFAULT_DIM };
