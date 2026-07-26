#!/usr/bin/env python3
"""Generate the 256x256 module icons Webswing shows in its app-selection dialog.

Webswing's SecuredPathConfig.icon wants "Path to icon displayed in application
selection dialog. Recommended size 256x256." Without it every module renders as
the generic Java coffee-cup tile.

The art is drawn from primitives on purpose: this repo is public, so shipping
publisher box art would be a redistribution problem. Each tile is an original
period-motif plate. The palette and motif language are shared with the
vassal-portal catalog tiles so the two surfaces look like one platform.

Usage:  python3 tools/make-icons.py [--out docker/icons]
Deps:   pillow, DejaVu fonts (Debian: fonts-dejavu-core)
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SIZE = 256
SUPERSAMPLE = 4  # draw big, downscale once — cheap anti-aliasing for primitives

FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")
SERIF_BOLD = FONT_DIR / "DejaVuSerif-Bold.ttf"
SANS_BOLD = FONT_DIR / "DejaVuSans-Bold.ttf"


# --- design tokens (mirrored in the portal's catalog tiles) -------------------
PALETTES = {
    "his": {
        "top": (74, 18, 24),
        "bottom": (26, 10, 13),
        "accent": (201, 162, 77),  # leaf gold
        "ink": (240, 226, 200),
    },
    "twilight-struggle": {
        "top": (17, 28, 56),
        "bottom": (10, 12, 22),
        "accent": (226, 232, 240),
        "ink": (233, 238, 246),
    },
    "paths-of-glory": {
        "top": (52, 56, 36),
        "bottom": (20, 22, 16),
        "accent": (176, 168, 118),
        "ink": (235, 232, 214),
    },
}


def font(path: Path, px: int) -> ImageFont.FreeTypeFont:
    if not path.exists():
        raise SystemExit(f"missing font {path} — install fonts-dejavu-core")
    return ImageFont.truetype(str(path), px)


def gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    """Vertical linear gradient, drawn at full canvas size."""
    img = Image.new("RGB", (1, size))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
    return img.resize((size, size), Image.BICUBIC)


def vignette(img: Image.Image, strength: float = 0.55) -> Image.Image:
    """Darken the corners so the plate reads as a physical counter."""
    size = img.size[0]
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    inset = int(size * 0.06)
    d.ellipse([-inset, -inset, size + inset, size + inset], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(size * 0.14))
    dark = Image.new("RGB", (size, size), (0, 0, 0))
    return Image.composite(img, Image.blend(img, dark, strength), mask)


def frame(d: ImageDraw.ImageDraw, size: int, accent: tuple) -> None:
    """Double hairline border — the shared 'plate' motif across all tiles."""
    outer = int(size * 0.035)
    inner = int(size * 0.065)
    d.rectangle([outer, outer, size - outer, size - outer],
                outline=accent + (150,), width=max(1, int(size * 0.008)))
    d.rectangle([inner, inner, size - inner, size - inner],
                outline=accent + (70,), width=max(1, int(size * 0.004)))


# --- per-module motifs -------------------------------------------------------
def _shield_outline(size: int) -> tuple[list, float, float, float, float]:
    """Heraldic shield: straight shoulders, curved point. Sized to clear the label."""
    cx, cy = size / 2, size * 0.38
    w, h = size * 0.30, size * 0.34
    left, right = cx - w, cx + w
    top, bottom = cy - h * 0.78, cy + h * 0.92
    shoulder = top + h * 0.52

    pts = [(left, top), (right, top), (right, shoulder)]
    steps = 28
    for i in range(steps + 1):
        t = i / steps
        pts.append((cx + (right - cx) * math.cos(t * math.pi / 2),
                    shoulder + (bottom - shoulder) * math.sin(t * math.pi / 2)))
    for i in range(steps, -1, -1):
        t = i / steps
        pts.append((cx - (cx - left) * math.cos(t * math.pi / 2),
                    shoulder + (bottom - shoulder) * math.sin(t * math.pi / 2)))
    pts.append((left, shoulder))
    return pts, cx, cy, left, right


def motif_his(layer: Image.Image, size: int, pal: dict) -> Image.Image:
    """Reformation Europe: a quartered heraldic shield, cross throughout."""
    pts, cx, cy, left, right = _shield_outline(size)
    top = pts[0][1]
    bottom = max(p[1] for p in pts)

    # Quarter tints are painted on their own layer and masked to the silhouette,
    # so the fills follow the curve of the shield instead of overrunning it.
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)

    plate = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    p = ImageDraw.Draw(plate)
    p.polygon(pts, fill=(38, 12, 16, 255))
    bar = size * 0.024
    p.rectangle([left, top, cx - bar, cy], fill=(152, 36, 40, 210))        # quarter I
    p.rectangle([cx + bar, cy, right, bottom], fill=(152, 36, 40, 210))    # quarter IV
    p.rectangle([cx - bar, top, cx + bar, bottom], fill=pal["accent"] + (225,))
    p.rectangle([left, cy - bar * 0.8, right, cy + bar * 0.8],
                fill=pal["accent"] + (225,))
    plate.putalpha(Image.composite(plate.getchannel("A"),
                                   Image.new("L", (size, size), 0), mask))

    out = Image.alpha_composite(layer, plate)
    # Rim last, so it is never clipped by the mask.
    ImageDraw.Draw(out).polygon(pts, outline=pal["accent"] + (235,),
                                width=max(1, int(size * 0.011)))
    return out


def motif_twilight(layer: Image.Image, size: int, pal: dict) -> Image.Image:
    """Cold War: a globe split by the iron curtain, a star on each side."""
    d = ImageDraw.Draw(layer)
    cx, cy = size / 2, size * 0.40
    r = size * 0.24

    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(12, 18, 34, 255),
              outline=pal["accent"] + (225,), width=max(1, int(size * 0.012)))
    # Hemispheres: warm west, cold east.
    d.pieslice([cx - r, cy - r, cx + r, cy + r], 90, 270, fill=(140, 34, 38, 205))
    d.pieslice([cx - r, cy - r, cx + r, cy + r], 270, 90, fill=(30, 56, 116, 205))
    # Latitude arcs, clipped to the disc by drawing thin ellipses inside it.
    for f in (0.42, 0.78):
        ry = r * f
        d.ellipse([cx - r * 0.98, cy - ry, cx + r * 0.98, cy + ry],
                  outline=pal["accent"] + (70,), width=max(1, int(size * 0.005)))
    # The curtain.
    d.rectangle([cx - size * 0.008, cy - r * 1.12, cx + size * 0.008, cy + r * 1.12],
                fill=pal["accent"] + (240,))

    def star(sx: float, sy: float, sr: float) -> None:
        pts = []
        for i in range(10):
            ang = -math.pi / 2 + i * math.pi / 5
            rad = sr if i % 2 == 0 else sr * 0.42
            pts.append((sx + rad * math.cos(ang), sy + rad * math.sin(ang)))
        d.polygon(pts, fill=pal["ink"] + (235,))

    star(cx - r * 0.5, cy - r * 0.12, size * 0.052)
    star(cx + r * 0.5, cy - r * 0.12, size * 0.052)
    return layer


def motif_paths(layer: Image.Image, size: int, pal: dict) -> Image.Image:
    """The Great War: opposing trench lines and a wire belt between them."""
    d = ImageDraw.Draw(layer)
    accent = pal["accent"]
    lw = max(1, int(size * 0.014))

    def trench(y: float, teeth: int, depth: float, alpha: int) -> None:
        pts = []
        span = size * 0.78
        x0 = (size - span) / 2
        for i in range(teeth * 2 + 1):
            x = x0 + span * i / (teeth * 2)
            pts.append((x, y + (depth if i % 2 else -depth)))
        d.line(pts, fill=accent + (alpha,), width=lw, joint="curve")

    # Allied line above, Central Powers line below, wire belt between them.
    trench(size * 0.20, 7, size * 0.026, 235)
    trench(size * 0.26, 7, size * 0.018, 105)
    trench(size * 0.60, 7, size * 0.026, 235)
    trench(size * 0.54, 7, size * 0.018, 105)

    # No-man's-land wire: X-crosses strung on a slack line.
    mid = size * 0.40
    d.line([(size * 0.11, mid), (size * 0.89, mid)],
           fill=accent + (140,), width=max(1, int(size * 0.006)))
    for i in range(5):
        x = size * (0.19 + i * 0.155)
        b = size * 0.032
        d.line([(x - b, mid - b), (x + b, mid + b)], fill=accent + (220,), width=lw)
        d.line([(x - b, mid + b), (x + b, mid - b)], fill=accent + (220,), width=lw)
    return layer


MOTIFS = {
    "his": motif_his,
    "twilight-struggle": motif_twilight,
    "paths-of-glory": motif_paths,
}

# label lines + the small period stamp under them
LABELS = {
    "his": (["HERE I", "STAND"], "1517 – 1555"),
    "twilight-struggle": (["TWILIGHT", "STRUGGLE"], "1945 – 1989"),
    "paths-of-glory": (["PATHS OF", "GLORY"], "1914 – 1918"),
}


def build(slug: str) -> Image.Image:
    pal = PALETTES[slug]
    s = SIZE * SUPERSAMPLE

    base = gradient(s, pal["top"], pal["bottom"]).convert("RGBA")
    layer = MOTIFS[slug](Image.new("RGBA", (s, s), (0, 0, 0, 0)), s, pal)
    frame(ImageDraw.Draw(layer), s, pal["accent"])
    d = ImageDraw.Draw(layer)

    lines, stamp = LABELS[slug]
    title = font(SERIF_BOLD, int(s * 0.088))
    small = font(SANS_BOLD, int(s * 0.040))

    # Scrim behind the text so the motif can run underneath it.
    text_top = s * 0.70
    scrim = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(scrim).rectangle([0, text_top - s * 0.03, s, s],
                                    fill=(0, 0, 0, 130))
    scrim = scrim.filter(ImageFilter.GaussianBlur(s * 0.012))
    layer = Image.alpha_composite(layer, scrim)
    d = ImageDraw.Draw(layer)

    y = text_top
    for line in lines:
        w = d.textlength(line, font=title)
        d.text(((s - w) / 2, y), line, font=title, fill=pal["ink"] + (255,))
        y += s * 0.094
    w = d.textlength(stamp, font=small)
    d.text(((s - w) / 2, y + s * 0.012), stamp, font=small,
           fill=pal["accent"] + (225,))

    out = Image.alpha_composite(base, layer)
    out = vignette(out.convert("RGB")).convert("RGBA")
    return out.resize((SIZE, SIZE), Image.LANCZOS)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="docker/icons", type=Path)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for slug in MOTIFS:
        path = args.out / f"{slug}.png"
        build(slug).save(path, "PNG", optimize=True)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
