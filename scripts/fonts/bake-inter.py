"""Bake Inter's I/l disambiguation alternates into the self-hosted font files.

Fluux draws a serif capital I (Inter's cv08) and a tailed lowercase l (cv05) so
names such as "Ilia" and "llia" cannot be confused. The alternates are baked
into each file's character map instead of being turned on with CSS
`font-feature-settings`: the message-height predictor measures text on a canvas,
which ignores font features, and the alternates are wider than the default
letters (I by about 64%, l by about 14%). With the character map rewritten, the
canvas and the DOM draw the same glyphs.

Every character whose glyph has a cv05 or cv08 substitution is remapped, so the
accented forms (Í, İ, ł, ľ…) follow their base letter. The replacement glyphs
are read from each font's own GSUB table, never from hard-coded glyph names.
Each output's version string gets FLUUX_MARK, which fontCoverage.test.ts checks
so a file copied straight from an Inter release cannot slip in unbaked.

Usage, from the repository root, with the official Inter release unpacked
(https://github.com/rsms/inter/releases, the `web/` folder):

    python3 -m venv /tmp/fontenv
    /tmp/fontenv/bin/pip install fonttools brotli
    /tmp/fontenv/bin/python scripts/fonts/bake-inter.py <inter-release>/web

The fonts are under the SIL Open Font License 1.1 with no Reserved Font Name,
so a modified version may keep the Inter name (apps/fluux/public/fonts/Inter-OFL.txt).
"""

import sys
from pathlib import Path

from fontTools.ttLib import TTFont

FEATURES = ("cv05", "cv08")
FLUUX_MARK = "fluux-baked cv05 cv08"
OUT_DIR = Path(__file__).resolve().parents[2] / "apps/fluux/public/fonts"
FILES = [
    "Inter-Regular", "Inter-Medium", "Inter-SemiBold", "Inter-Bold",
    "Inter-Italic", "Inter-MediumItalic", "Inter-SemiBoldItalic", "Inter-BoldItalic",
    "InterDisplay-Medium", "InterDisplay-SemiBold", "InterDisplay-Bold",
]


def single_substitutions(font: TTFont, tag: str) -> dict:
    """glyph -> replacement for every single substitution under a GSUB feature."""
    gsub = font["GSUB"].table
    mapping = {}
    for record in gsub.FeatureList.FeatureRecord:
        if record.FeatureTag != tag:
            continue
        for index in record.Feature.LookupListIndex:
            lookup = gsub.LookupList.Lookup[index]
            for sub in lookup.SubTable:
                if lookup.LookupType == 7:
                    sub = sub.ExtSubTable
                if getattr(sub, "mapping", None):
                    mapping.update(sub.mapping)
    if not mapping:
        raise SystemExit(f"{tag} has no single substitutions")
    return mapping


def bake(source: Path, target: Path) -> int:
    font = TTFont(source)
    alternates = {}
    for tag in FEATURES:
        alternates.update(single_substitutions(font, tag))

    remapped = set()
    for table in font["cmap"].tables:
        for codepoint, glyph in list(table.cmap.items()):
            if glyph in alternates:
                table.cmap[codepoint] = alternates[glyph]
                remapped.add(codepoint)
    for required in ("I", "l"):
        if ord(required) not in remapped:
            raise SystemExit(f"{source.name}: {required!r} has no alternate")

    names = font["name"]
    for record in names.names:
        if record.nameID == 5:
            record.string = f"{record.toUnicode()}; {FLUUX_MARK}"
    font.flavor = "woff2"
    font.save(target)

    check = TTFont(target).getBestCmap()
    for required in ("I", "l"):
        expected = alternates[TTFont(source).getBestCmap()[ord(required)]]
        if check[ord(required)] != expected:
            raise SystemExit(f"{target.name}: {required!r} not baked")
    return len(remapped)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    source_dir = Path(sys.argv[1])
    for name in FILES:
        count = bake(source_dir / f"{name}.woff2", OUT_DIR / f"{name}.woff2")
        print(f"{name}: {count} characters remapped")


if __name__ == "__main__":
    main()
