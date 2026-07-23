#!/usr/bin/env python3
"""Packt die Extension zu einer .vsix -- ohne Node, ohne npm, ohne vsce.

Eine .vsix ist ein ZIP mit drei festen Bestandteilen:

    extension.vsixmanifest   Metadaten, die VS Code beim Installieren liest
    [Content_Types].xml      MIME-Typ je Dateiendung (OPC-Format)
    extension/...            die Extension selbst

Das laesst sich mit der Python-Standardbibliothek erzeugen. Der Umweg ueber
`npx @vscode/vsce` scheitert auf genau den Maschinen, auf denen dieses Projekt
laeuft: der VS-Code-Server bringt zwar ein node mit, aber kein npm. Python 3
ist dagegen ohnehin da -- backend-api und measurement-preprocessor sind Python.

Aufruf ueber build.sh; direkt geht auch:

    python3 scripts/package.py [--out DIR]
"""

import argparse
import json
import sys
import zipfile
from fnmatch import fnmatch
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

ROOT = Path(__file__).resolve().parent.parent

# Kommt nie ins Paket, egal was in .vscodeignore steht.
ALWAYS_IGNORED = (".git/**", "node_modules/**", "*.vsix", ".DS_Store", ".vscodeignore")

CONTENT_TYPES = {
    ".js": "application/javascript",
    ".json": "application/json",
    ".md": "text/markdown",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".vsixmanifest": "text/xml",
    ".xml": "text/xml",
}
FALLBACK_CONTENT_TYPE = "application/octet-stream"


def ignore_patterns() -> list:
    patterns = list(ALWAYS_IGNORED)
    ignore_file = ROOT / ".vscodeignore"
    if ignore_file.exists():
        for line in ignore_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            # Nur das Praefix "./" abschneiden. lstrip("./") waere ein
            # Zeichensatz und wuerde aus ".vscode/**" ein "vscode/**" machen.
            if line.startswith("./"):
                line = line[2:]
            patterns.append(line)
    return patterns


def is_ignored(relative: str, patterns: list) -> bool:
    """Teilmenge der .vscodeignore-Syntax: `dir/**`, `*.ext`, exakte Pfade.

    Reicht fuer diese Extension und ist nachvollziehbar. Wer die volle
    glob-Semantik braucht, nimmt vsce.
    """
    name = relative.rsplit("/", 1)[-1]
    for pattern in patterns:
        if pattern.endswith("/**"):
            if relative.startswith(pattern[:-2]):
                return True
        elif fnmatch(relative, pattern) or fnmatch(name, pattern):
            return True
    return False


def collect_files() -> list:
    patterns = ignore_patterns()
    files = []
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT).as_posix()
        if is_ignored(relative, patterns):
            continue
        files.append((path, relative))
    return files


def readme_path(files: list):
    for _, relative in files:
        if relative.lower() == "readme.md":
            return relative
    return None


def build_manifest(manifest: dict, files: list) -> str:
    identity = manifest["name"]
    publisher = manifest["publisher"]
    version = manifest["version"]
    engine = manifest.get("engines", {}).get("vscode", "*")

    # Wie vsce: Keywords, Sprach-IDs und beigesteuerte Dateiendungen werden zu
    # Tags. Die __ext_-Eintraege sind der Grund, warum der Marketplace zu einer
    # .rdf-Datei ueberhaupt eine Extension vorschlagen kann.
    tags = list(manifest.get("keywords", []))
    for language in manifest.get("contributes", {}).get("languages", []):
        if language.get("id"):
            tags.append(language["id"])
        for extension in language.get("extensions", []):
            tags.append("__ext_" + extension.lstrip("."))

    kinds = manifest.get("extensionKind") or ["workspace"]
    assets = [
        '<Asset Type="Microsoft.VisualStudio.Code.Manifest" '
        'Path="extension/package.json" Addressable="true" />'
    ]
    readme = readme_path(files)
    if readme:
        assets.append(
            '<Asset Type="Microsoft.VisualStudio.Services.Content.Details" '
            f"Path={quoteattr('extension/' + readme)} Addressable=\"true\" />"
        )

    properties = [
        ("Microsoft.VisualStudio.Code.Engine", engine),
        ("Microsoft.VisualStudio.Code.ExtensionDependencies", ""),
        ("Microsoft.VisualStudio.Code.ExtensionPack", ""),
        ("Microsoft.VisualStudio.Code.ExtensionKind", ",".join(kinds)),
        ("Microsoft.VisualStudio.Code.LocalizedLanguages", ""),
        ("Microsoft.VisualStudio.Code.ExecutesCode", "true"),
        ("Microsoft.VisualStudio.Services.Content.Pricing", "Free"),
    ]

    lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<PackageManifest Version="2.0.0" '
        'xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" '
        'xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">',
        "  <Metadata>",
        f'    <Identity Language="en-US" Id={quoteattr(identity)} '
        f"Version={quoteattr(version)} Publisher={quoteattr(publisher)} />",
        f"    <DisplayName>{escape(manifest.get('displayName', identity))}</DisplayName>",
        f'    <Description xml:space="preserve">'
        f"{escape(manifest.get('description', ''))}</Description>",
        f"    <Tags>{escape(','.join(dict.fromkeys(tags)))}</Tags>",
        f"    <Categories>{escape(','.join(manifest.get('categories', [])))}</Categories>",
        "    <GalleryFlags>Public</GalleryFlags>",
        "    <Properties>",
    ]
    for key, value in properties:
        lines.append(f"      <Property Id={quoteattr(key)} Value={quoteattr(value)} />")
    lines += [
        "    </Properties>",
        "  </Metadata>",
        "  <Installation>",
        '    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>',
        "  </Installation>",
        "  <Dependencies/>",
        "  <Assets>",
    ]
    lines += [f"    {asset}" for asset in assets]
    lines += ["  </Assets>", "</PackageManifest>", ""]
    return "\n".join(lines)


def build_content_types(files: list) -> str:
    suffixes = {".vsixmanifest"}
    for _, relative in files:
        suffix = Path(relative).suffix.lower()
        if suffix:
            suffixes.add(suffix)
    defaults = "".join(
        f'<Default Extension={quoteattr(suffix)} '
        f"ContentType={quoteattr(CONTENT_TYPES.get(suffix, FALLBACK_CONTENT_TYPE))}/>"
        for suffix in sorted(suffixes)
    )
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        f"{defaults}</Types>\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Baut die .vsix der Extension.")
    parser.add_argument("--out", default=str(ROOT), help="Zielordner (Standard: Extensionordner)")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    for required in ("name", "publisher", "version"):
        if not manifest.get(required):
            print(f"FEHLER: package.json ohne '{required}'", file=sys.stderr)
            return 1

    files = collect_files()
    if not any(relative == "package.json" for _, relative in files):
        print("FEHLER: package.json wird von .vscodeignore ausgeschlossen", file=sys.stderr)
        return 1

    main_file = manifest.get("main", "").lstrip("./")
    if main_file and not any(relative == main_file for _, relative in files):
        print(f"FEHLER: '{main_file}' fehlt im Paket -- .vscodeignore pruefen", file=sys.stderr)
        return 1

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"{manifest['name']}-{manifest['version']}.vsix"

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("extension.vsixmanifest", build_manifest(manifest, files))
        archive.writestr("[Content_Types].xml", build_content_types(files))
        for path, relative in files:
            archive.write(path, "extension/" + relative)

    if not args.quiet:
        for _, relative in files:
            print(f"  extension/{relative}")
        size = target.stat().st_size / 1024
        print(f"\n{target}  ({len(files)} Dateien, {size:.1f} KB)")
    else:
        print(target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
