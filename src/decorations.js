'use strict';

const vscode = require('vscode');
const { barsDataUri, signature, ownColor } = require('./svg');

/**
 * Verwaltet die Dekorationstypen -- Balken am Rand und Unterstriche im Text.
 *
 * Ein Typ je *Erscheinungsbild*, nicht je Zeile: Dekorationstypen sind teuer
 * und muessen einzeln entsorgt werden. Wer sie pro Zeile anlegt, hat bei einer
 * 2000-Zeilen-Datei 2000 Objekte, die beim naechsten Tastendruck alle neu
 * entstehen. Balken teilen sich einen Typ je Balkenfolge, Unterstriche einen
 * je Farbe.
 *
 * Zweite Aufgabe: das Aufraeumen. `setDecorations` ersetzt immer nur die Ranges
 * *eines* Typs. Ein Typ, der nach einer Aenderung nicht mehr vorkommt, behaelt
 * also seine alten Ranges und zeichnet an Stellen, die es so nicht mehr gibt.
 * Deshalb merkt sich `applied`, was je Editor zuletzt gesetzt war, und leert
 * genau die Differenz.
 */
class Decorations {
  constructor() {
    this.bars = new Map(); // Signatur -> DecorationType
    this.underlines = new Map(); // Farbe -> DecorationType
    this.applied = new Map(); // Editor-Schluessel -> {bars:Set, underlines:Set}
  }

  apply(editor, model, options) {
    const key = editorKey(editor);
    const previous = this.applied.get(key) || { bars: new Set(), underlines: new Set() };
    const current = { bars: new Set(), underlines: new Set() };

    this.applyBars(editor, model, options, current);
    this.applyUnderlines(editor, model, options, current);

    for (const sig of previous.bars) {
      if (!current.bars.has(sig)) clearType(editor, this.bars.get(sig));
    }
    for (const color of previous.underlines) {
      if (!current.underlines.has(color)) clearType(editor, this.underlines.get(color));
    }

    this.applied.set(key, current);
    this.prune();
  }

  applyBars(editor, model, options, current) {
    const grouped = new Map();
    for (const [line, bars] of model.lineStacks) {
      if (!bars.length) continue;
      const sig = signature(bars, model.columns, options);
      let entry = grouped.get(sig);
      if (!entry) {
        entry = { bars, ranges: [] };
        grouped.set(sig, entry);
      }
      entry.ranges.push(new vscode.Range(line, 0, line, 0));
    }
    for (const [sig, entry] of grouped) {
      editor.setDecorations(this.barType(sig, entry.bars, model.columns, options), entry.ranges);
      current.bars.add(sig);
    }
  }

  applyUnderlines(editor, model, options, current) {
    if (!options.underlineIds) return;
    const grouped = new Map();
    for (const mark of model.underlines) {
      if (!mark.color) continue;
      const range = new vscode.Range(
        editor.document.positionAt(mark.start),
        editor.document.positionAt(mark.end),
      );
      const ranges = grouped.get(mark.color);
      if (ranges) ranges.push(range);
      else grouped.set(mark.color, [range]);
    }
    for (const [color, ranges] of grouped) {
      editor.setDecorations(this.underlineType(color, options), ranges);
      current.underlines.add(color);
    }
  }

  barType(sig, bars, columns, options) {
    let type = this.bars.get(sig);
    if (type) return type;
    const decoration = {
      gutterIconPath: vscode.Uri.parse(barsDataUri(bars, columns, options)),
      gutterIconSize: 'contain',
    };
    if (options.overviewRuler) {
      decoration.overviewRulerColor = ownColor(bars);
      decoration.overviewRulerLane = vscode.OverviewRulerLane.Left;
    }
    type = vscode.window.createTextEditorDecorationType(decoration);
    this.bars.set(sig, type);
    return type;
  }

  underlineType(color, options) {
    let type = this.underlines.get(color);
    if (type) return type;
    type = vscode.window.createTextEditorDecorationType({
      // Nur der untere Rand: die Schriftfarbe bleibt beim XML-Highlighting.
      borderColor: color,
      borderStyle: 'solid',
      borderWidth: `0 0 ${options.underlineWidth}px 0`,
      // Sonst waechst der Unterstrich beim Tippen am Rand mit.
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.underlines.set(color, type);
    return type;
  }

  clear(editor) {
    const key = editorKey(editor);
    const previous = this.applied.get(key);
    if (!previous) return;
    for (const sig of previous.bars) clearType(editor, this.bars.get(sig));
    for (const color of previous.underlines) clearType(editor, this.underlines.get(color));
    this.applied.delete(key);
  }

  /** Erscheinungsbilder, die kein Editor mehr zeigt, freigeben. */
  prune(limit = 400) {
    if (this.bars.size + this.underlines.size <= limit) return;
    const live = { bars: new Set(), underlines: new Set() };
    for (const entry of this.applied.values()) {
      for (const sig of entry.bars) live.bars.add(sig);
      for (const color of entry.underlines) live.underlines.add(color);
    }
    for (const [sig, type] of this.bars) {
      if (live.bars.has(sig)) continue;
      type.dispose();
      this.bars.delete(sig);
    }
    for (const [color, type] of this.underlines) {
      if (live.underlines.has(color)) continue;
      type.dispose();
      this.underlines.delete(color);
    }
  }

  dispose() {
    for (const type of this.bars.values()) type.dispose();
    for (const type of this.underlines.values()) type.dispose();
    this.bars.clear();
    this.underlines.clear();
    this.applied.clear();
  }
}

function clearType(editor, type) {
  if (type) editor.setDecorations(type, []);
}

function editorKey(editor) {
  return `${editor.document.uri.toString()}#${editor.viewColumn ?? 'x'}`;
}

module.exports = { Decorations };
