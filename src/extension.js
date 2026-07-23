'use strict';

const path = require('path');
const vscode = require('vscode');

const { parse } = require('./parser');
const { analyze } = require('./graph');
const { Decorations } = require('./decorations');

const SECTION = 'cimRdfLens';
const RENDER_DELAY_MS = 150;

const decorations = new Decorations();
const models = new Map(); // Dokument-URI -> {version, epoch, model}
let epoch = 0; // steigt bei jeder Konfigurationsaenderung und entwertet den Cache
let renderTimer = null;

function activate(context) {
  context.subscriptions.push(
    { dispose: () => decorations.dispose() },

    vscode.commands.registerCommand(`${SECTION}.toggle`, toggle),
    vscode.commands.registerCommand(`${SECTION}.refresh`, () => {
      models.clear();
      renderAll();
    }),

    vscode.languages.registerHoverProvider({ language: 'xml' }, { provideHover }),
    vscode.languages.registerDefinitionProvider({ language: 'xml' }, { provideDefinition }),
    vscode.languages.registerReferenceProvider({ language: 'xml' }, { provideReferences }),

    vscode.window.onDidChangeVisibleTextEditors(renderAll),
    vscode.window.onDidChangeActiveTextEditor(() => renderAll()),

    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!isTarget(event.document)) return;
      scheduleRender();
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      models.delete(document.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(SECTION)) return;
      epoch++;
      models.clear();
      renderAll();
    }),
  );

  renderAll();
}

function deactivate() {
  if (renderTimer) clearTimeout(renderTimer);
  decorations.dispose();
}

// --- Konfiguration ---------------------------------------------------------

function settings() {
  const config = vscode.workspace.getConfiguration(SECTION);
  return {
    enabled: config.get('enabled', true),
    fileExtensions: config.get('fileExtensions', ['.rdf']),
    palette: config.get('palette', []),
    dim: config.get('ancestorOpacity', 1),
    fill: config.get('barWidth', 0.66),
    maxColumns: config.get('maxColumns', 8),
    markReferences: config.get('markReferences', false),
    overviewRuler: config.get('overviewRuler', true),
    underlineIds: config.get('underlineIds', true),
    underlineWidth: config.get('underlineWidth', 2),
  };
}

function isTarget(document) {
  if (!document) return false;
  if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') return false;
  const extensions = settings().fileExtensions.map((value) => String(value).toLowerCase());
  const suffix = path.extname(document.uri.fsPath || document.uri.path).toLowerCase();
  return extensions.includes(suffix);
}

// --- Modell (je Dokumentversion einmal gerechnet) ---------------------------

function modelFor(document) {
  const key = document.uri.toString();
  const cached = models.get(key);
  if (cached && cached.version === document.version && cached.epoch === epoch) return cached.model;

  const options = settings();
  const model = analyze(parse(document.getText()), {
    palette: options.palette,
    maxColumns: options.maxColumns,
    markReferences: options.markReferences,
  });
  models.set(key, { version: document.version, epoch, model });
  return model;
}

// --- Zeichnen --------------------------------------------------------------

function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderAll();
  }, RENDER_DELAY_MS);
}

function renderAll() {
  for (const editor of vscode.window.visibleTextEditors) render(editor);
}

function render(editor) {
  const options = settings();
  if (!options.enabled || !isTarget(editor.document)) {
    decorations.clear(editor);
    return;
  }
  try {
    decorations.apply(editor, modelFor(editor.document), options);
  } catch (error) {
    // Eine kaputte Datei darf den Editor nicht behindern -- lieber keine Balken.
    console.error('[cim-rdf-lens]', error);
    decorations.clear(editor);
  }
}

function toggle() {
  const config = vscode.workspace.getConfiguration(SECTION);
  const next = !config.get('enabled', true);
  const target = vscode.workspace.workspaceFolders
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  config.update('enabled', next, target);
  vscode.window.setStatusBarMessage(
    next ? 'CIM/RDF Lens: Balken an' : 'CIM/RDF Lens: Balken aus',
    2000,
  );
}

// --- Sprachdienste ---------------------------------------------------------

/** Was liegt an dieser Position: eine Referenz, eine Definition, nichts? */
function resolve(document, position) {
  if (!isTarget(document)) return null;
  const model = modelFor(document);
  const offset = document.offsetAt(position);

  for (const ref of model.refs) {
    if (offset < ref.startOffset || offset > ref.endOffset) continue;
    const target = model.nodes.get(ref.targetKey);
    if (target) return { kind: 'reference', key: ref.targetKey, node: target, ref, model };
  }
  for (const node of model.orderedNodes) {
    if (offset >= node.startOffset && offset <= node.endOffset && node.startLine === position.line) {
      return { kind: 'definition', key: node.key, node, model };
    }
  }
  return null;
}

function provideHover(document, position) {
  const hit = resolve(document, position);
  if (!hit) return null;

  const { model, node } = hit;
  const markdown = new vscode.MarkdownString();
  markdown.supportHtml = true;

  const swatch = (key) =>
    `<span style="color:${model.color.get(key)};">&#9608;&#9608;</span>`;
  const label = (key) => {
    const entry = model.nodes.get(key);
    if (!entry) return key;
    return entry.name ? `${entry.tag} \`${entry.name}\`` : entry.tag;
  };

  markdown.appendMarkdown(`${swatch(node.key)} **${node.tag}**`);
  if (node.name) markdown.appendMarkdown(` — ${node.name}`);
  markdown.appendMarkdown(`\n\n\`${node.rawId}\`\n\n`);

  const chain = model.chain.get(node.key) || [node.key];
  markdown.appendMarkdown('**Hierarchie** (Wurzel links, wie die Balken)\n\n');
  chain.forEach((key, index) => {
    markdown.appendMarkdown(`${'&nbsp;'.repeat(index * 3)}${swatch(key)} ${label(key)}\n\n`);
  });

  const incoming = model.refs.filter((ref) => ref.targetKey === node.key).length;
  const outgoing = (model.parents.get(node.key) || []).length;
  markdown.appendMarkdown(
    `\n*${incoming} Referenz(en) hierher · ${outgoing} aufgeloeste Referenz(en) von hier · Ebene ${model.depth.get(node.key)}*`,
  );

  return new vscode.Hover(markdown);
}

function provideDefinition(document, position) {
  const hit = resolve(document, position);
  if (!hit || hit.kind !== 'reference') return null;
  return new vscode.Location(document.uri, document.positionAt(hit.node.startOffset));
}

function provideReferences(document, position, context) {
  const hit = resolve(document, position);
  if (!hit) return null;
  const locations = hit.model.refs
    .filter((ref) => ref.targetKey === hit.key)
    .map(
      (ref) =>
        new vscode.Location(
          document.uri,
          new vscode.Range(
            document.positionAt(ref.startOffset),
            document.positionAt(ref.endOffset),
          ),
        ),
    );
  if (context && context.includeDeclaration) {
    locations.unshift(
      new vscode.Location(
        document.uri,
        new vscode.Range(
          document.positionAt(hit.node.startOffset),
          document.positionAt(hit.node.endOffset),
        ),
      ),
    );
  }
  return locations;
}

module.exports = { activate, deactivate };
