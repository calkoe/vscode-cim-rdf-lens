'use strict';

/**
 * Zerlegt eine RDF/XML-Datei in Definitionen und Referenzen.
 *
 * Bewusst kein vollstaendiger XML-Parser: gebraucht werden nur zwei Dinge,
 * und beide haengen an Attributen, nicht an Inhalten --
 *
 *   Definition   ein Element mit rdf:about (oder rdf:ID). Es *ist* das Objekt,
 *                seine UUID ist der Schluessel.
 *   Referenz     ein Element mit rdf:resource. Es zeigt auf ein Objekt; ob auf
 *                eines aus dieser Datei, entscheidet erst der Graph.
 *
 * Ein Streaming-Scanner ueber die Tags ist hier robuster als ein DOM: die
 * Zeilennummern fallen ohnehin an, und eine halbfertige Datei im Editor (waehrend
 * des Tippens ist sie das die meiste Zeit) bringt ihn nicht aus dem Tritt.
 *
 * Dieses Modul kennt vscode nicht -- deshalb ist es ohne Editor testbar.
 */

// Ein Tag bis zum ersten '>', das nicht in Anfuehrungszeichen steht. Ob es
// selbstschliessend ist, entscheidet das letzte Zeichen des Attributteils.
const TAG_RE = /<(\/?)([A-Za-z_][A-Za-z0-9_.\-]*(?::[A-Za-z0-9_.\-]+)?)((?:'[^']*'|"[^"]*"|[^>'"])*)>/g;
const ATTR_RE = /([A-Za-z_][A-Za-z0-9_.\-]*(?::[A-Za-z0-9_.\-]+)?)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const NAME_RE = /<(?:[A-Za-z0-9_.\-]+:)?IdentifiedObject\.name\s*>([^<]*)</;

/**
 * Vereinheitlicht die Schreibweisen, in denen dieselbe Kennung auftreten kann:
 * `urn:uuid:4a1e...` in rdf:about, `#_4a1e...` in rdf:resource (CGMES-Stil),
 * `4a1e...` blank. Alles, was danach noch verschieden ist, ist auch verschieden
 * gemeint -- eine externe URI wie `http://iec.ch/TC57/CIM100#UnitSymbol.A`
 * ueberlebt die Normalisierung unveraendert und findet spaeter schlicht kein
 * Gegenstueck in der Datei.
 */
function normalizeId(raw) {
  if (!raw) return null;
  let value = raw.trim();
  if (value.startsWith('#')) value = value.slice(1);
  else if (/^urn:uuid:/i.test(value)) value = value.slice(9);
  if (value.startsWith('_')) value = value.slice(1);
  return value.length ? value.toLowerCase() : null;
}

/**
 * Kommentare, CDATA, Processing Instructions und DOCTYPE mit Leerzeichen
 * ueberschreiben -- gleiche Laenge, Zeilenumbrueche bleiben stehen. Damit
 * stimmen alle Offsets weiter, und ein auskommentierter Block liefert keine
 * Geisterbeziehungen.
 */
function maskNonMarkup(text) {
  const chars = text.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < chars.length; i++) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  };
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('<', cursor);
    if (open === -1) break;
    let close = -1;
    if (text.startsWith('<!--', open)) close = indexAfter(text, '-->', open + 4);
    else if (text.startsWith('<![CDATA[', open)) close = indexAfter(text, ']]>', open + 9);
    else if (text.startsWith('<?', open)) close = indexAfter(text, '?>', open + 2);
    else if (text.startsWith('<!', open)) close = indexAfter(text, '>', open + 2);
    if (close === -1) {
      cursor = open + 1;
      continue;
    }
    blank(open, close);
    cursor = close;
  }
  return chars.join('');
}

function indexAfter(text, needle, from) {
  const hit = text.indexOf(needle, from);
  return hit === -1 ? text.length : hit + needle.length;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Attribute eines Tags samt Position ihres Wertes.
 *
 * Die Position wird gebraucht, um die Kennung im Text unterstreichen zu
 * koennen -- dafuer reicht der Wert allein nicht, es muss die Stelle sein.
 * `offset` ist der absolute Beginn des Tags, damit hier gleich absolute
 * Offsets herauskommen.
 */
function attributes(tagText, offset) {
  const found = new Map();
  ATTR_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_RE.exec(tagText))) {
    if (found.has(match[1])) continue;
    const value = match[2] !== undefined ? match[2] : match[3];
    // match[0] endet auf dem schliessenden Anfuehrungszeichen, davor steht der
    // Wert -- daraus faellt sein Beginn ohne zweite Suche heraus.
    const start = offset + match.index + match[0].length - 1 - value.length;
    found.set(match[1], { value, start, end: start + value.length });
  }
  return found;
}

/**
 * Der Bereich der reinen Kennung innerhalb des Attributwertes.
 *
 * `urn:uuid:4a1e...` und `#_4a1e...` sollen nur auf der UUID unterstrichen
 * werden, nicht auf dem Praefix. Wird die Kennung nicht wiedergefunden (etwa
 * bei ungewoehnlicher Schreibweise), gilt der ganze Wert -- lieber zu viel
 * unterstrichen als gar nichts.
 */
function idRange(attribute, key) {
  const index = attribute.value.toLowerCase().lastIndexOf(key);
  if (index === -1) return { start: attribute.start, end: attribute.end };
  return { start: attribute.start + index, end: attribute.start + index + key.length };
}

/**
 * @returns {{nodes: Map<string, object>, refs: object[], lineCount: number}}
 */
function parse(text) {
  const masked = maskNonMarkup(text);
  const starts = lineStarts(text);
  const nodes = new Map();
  const refs = [];
  const stack = [];

  TAG_RE.lastIndex = 0;
  let match;
  while ((match = TAG_RE.exec(masked))) {
    const [full, closing, tag, attrText] = match;
    const from = match.index;
    const to = from + full.length;
    const startLine = lineOf(starts, from);
    const endLine = lineOf(starts, to - 1);

    if (closing) {
      // Bis zum passenden offenen Tag abraeumen. Was dazwischen liegt, war
      // unbalanciert -- in einer Datei, die gerade getippt wird, der Normalfall.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag !== tag) continue;
        while (stack.length > i) {
          const element = stack.pop();
          if (element.node) {
            element.node.endLine = endLine;
            element.node.endOffset = to;
          }
        }
        break;
      }
      continue;
    }

    // Der Tagtext beginnt mit '<' -- die Attributpositionen zaehlen ab dort.
    const attrs = attributes(attrText, from + 1 + tag.length + closing.length);
    const selfClosing = /\/\s*$/.test(attrText);
    const owner = topNode(stack);

    const about = attrs.get('rdf:about') || attrs.get('rdf:ID');
    const aboutKey = normalizeId(about && about.value);
    let node = null;
    if (aboutKey) {
      node = nodes.get(aboutKey);
      if (!node) {
        node = {
          key: aboutKey,
          rawId: about.value.trim(),
          idRange: idRange(about, aboutKey),
          tag,
          name: null,
          startLine,
          endLine,
          startOffset: from,
          endOffset: to,
          refs: new Set(),
        };
        nodes.set(aboutKey, node);
      }
    }

    const resource = attrs.get('rdf:resource');
    if (resource) {
      const targetKey = normalizeId(resource.value);
      const holder = node || owner;
      if (targetKey) {
        refs.push({
          targetKey,
          rawTarget: resource.value.trim(),
          targetRange: idRange(resource, targetKey),
          tag,
          startLine,
          endLine,
          startOffset: from,
          endOffset: to,
          ownerKey: holder ? holder.key : null,
        });
        if (holder && holder.key !== targetKey) holder.refs.add(targetKey);
      }
    }

    if (!selfClosing) stack.push({ tag, node });
    else if (node) node.endLine = endLine;
  }

  // Was am Dateiende offen blieb, reicht bis dorthin.
  const lastLine = starts.length - 1;
  while (stack.length) {
    const element = stack.pop();
    if (element.node) {
      element.node.endLine = lastLine;
      element.node.endOffset = text.length;
    }
  }

  for (const node of nodes.values()) {
    const slice = text.slice(node.startOffset, node.endOffset);
    const name = NAME_RE.exec(slice);
    if (name) node.name = name[1].trim();
  }

  return { nodes, refs, lineCount: starts.length };
}

function topNode(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].node) return stack[i].node;
  }
  return null;
}

module.exports = { parse, normalizeId };
