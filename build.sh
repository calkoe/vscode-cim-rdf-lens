#!/usr/bin/env bash
#
# Baut die Extension zu einer .vsix und installiert sie auf Wunsch.
#
#   ./build.sh                 testen und bauen
#   ./build.sh --install       zusaetzlich in VS Code installieren
#   ./build.sh --no-test       ohne Tests bauen
#   ./build.sh --out /tmp      .vsix woandershin legen
#
# Gebraucht wird nur python3. node ist optional und wird ausschliesslich fuer
# die Tests gesucht -- auf einer Maschine ohne node wird gebaut und der
# Testlauf uebersprungen (mit Hinweis, nicht stillschweigend).
#
# Warum kein `npx @vscode/vsce`: der VS-Code-Server bringt ein node mit, aber
# kein npm. Der kanonische Weg scheitert also genau dort, wo dieses Projekt
# entwickelt wird. Das Packen uebernimmt deshalb scripts/package.py.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

RUN_TESTS=1
INSTALL=0
OUT_DIR="$HERE"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)  INSTALL=1; shift ;;
    --no-test)  RUN_TESTS=0; shift ;;
    --out)      OUT_DIR="${2:?--out braucht einen Ordner}"; shift 2 ;;
    -h|--help)  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          echo "Unbekannte Option: $1 (--help)" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v python3 >/dev/null || die "python3 nicht gefunden -- ohne das geht das Packen nicht."

# --- node suchen (nur fuer die Tests) --------------------------------------
# Reihenfolge: was auf dem PATH liegt, sonst das node, das der VS-Code-Server
# ohnehin mitbringt. Letzteres deckt genau den Fall ab, dass systemweit kein
# node installiert ist -- der Normalfall auf einem Remote-Host.
find_node() {
  if command -v node >/dev/null; then
    command -v node
    return 0
  fi
  local code_bin server
  if code_bin="$(command -v code 2>/dev/null)"; then
    server="$(dirname "$(dirname "$(dirname "$(readlink -f "$code_bin")")")")"
    [[ -x "$server/node" ]] && { echo "$server/node"; return 0; }
  fi
  # Sonst das neueste installierte Server-Bundle.
  server="$(ls -dt "$HOME"/.vscode-server/cli/servers/*/server/node 2>/dev/null | head -1)"
  [[ -n "$server" && -x "$server" ]] && { echo "$server"; return 0; }
  return 1
}

# --- Tests ------------------------------------------------------------------
if [[ $RUN_TESTS -eq 1 ]]; then
  if NODE="$(find_node)"; then
    say "Tests ($("$NODE" --version))"
    "$NODE" --test "test/*.test.js" || die "Tests fehlgeschlagen -- nichts gebaut."
  else
    warn "kein node gefunden -- Tests uebersprungen (mit --no-test verschwindet dieser Hinweis)"
  fi
fi

# --- Packen -----------------------------------------------------------------
# Erst den Zielpfad bestimmen, dann genau diese eine Datei ersetzen. Ein
# pauschales `rm *.vsix` wuerde bei --out auf einen fremden Ordner losgehen.
VSIX="$(python3 - "$OUT_DIR" <<'PY'
import json, pathlib, sys
manifest = json.loads(pathlib.Path("package.json").read_text(encoding="utf-8"))
print(pathlib.Path(sys.argv[1]).resolve() / f"{manifest['name']}-{manifest['version']}.vsix")
PY
)"

say "Paket"
rm -f "$VSIX"
python3 scripts/package.py --out "$OUT_DIR"

# --- Installieren -----------------------------------------------------------
if [[ $INSTALL -eq 1 ]]; then
  command -v code >/dev/null || die "'code' nicht gefunden -- .vsix liegt unter $VSIX"
  say "Installation"
  # Bei Remote-Entwicklung ist das hier die Remote-CLI: die Extension landet
  # serverseitig, also dort, wo auch die .rdf-Dateien liegen. Genau richtig.
  code --install-extension "$VSIX" --force
  printf '\nFenster neu laden: Strg+Shift+P -> "Developer: Reload Window"\n'
else
  printf '\nInstallieren mit:\n  code --install-extension %s\n' "$VSIX"
fi
