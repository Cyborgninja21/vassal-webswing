/**
 * Catalog tile art, drawn as inline SVG.
 *
 * These are the same three motifs as the Webswing selector icons
 * (tools/make-icons.py in the vassal-webswing repo) so the two surfaces read as
 * one platform — but drawn as vectors here, because a catalog tile has to be
 * crisp at any size and the palette has to follow the theme rather than a
 * baked-in PNG. Original artwork: no publisher box art is redistributed.
 */

type ArtProps = { className?: string };

const PALETTE = {
  shield: { top: "#4a1218", bottom: "#1a0a0d", accent: "#c9a24d", tint: "#982428" },
  globe: { top: "#111c38", bottom: "#0a0c16", accent: "#e2e8f0", tint: "#8c2426" },
  trenches: { top: "#343824", bottom: "#141610", accent: "#b0a876" },
} as const;

function Plate({
  id,
  top,
  bottom,
  accent,
  children,
}: {
  id: string;
  top: string;
  bottom: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={top} />
          <stop offset="100%" stopColor={bottom} />
        </linearGradient>
        <radialGradient id={`${id}-vig`} cx="50%" cy="42%" r="70%">
          <stop offset="55%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
        </radialGradient>
      </defs>
      <rect width="256" height="256" fill={`url(#${id}-bg)`} />
      {children}
      <rect width="256" height="256" fill={`url(#${id}-vig)`} />
      <rect
        x="9"
        y="9"
        width="238"
        height="238"
        fill="none"
        stroke={accent}
        strokeOpacity="0.55"
        strokeWidth="2"
      />
      <rect
        x="17"
        y="17"
        width="222"
        height="222"
        fill="none"
        stroke={accent}
        strokeOpacity="0.25"
        strokeWidth="1"
      />
    </>
  );
}

/** Reformation Europe: a quartered heraldic shield, cross throughout. */
function ShieldArt() {
  const p = PALETTE.shield;
  const shield =
    "M 82 62 H 174 V 150 C 174 186 148 204 128 212 C 108 204 82 186 82 150 Z";
  return (
    <svg viewBox="0 0 256 256" role="presentation" className="h-full w-full">
      <Plate id="art-shield" top={p.top} bottom={p.bottom} accent={p.accent}>
        <clipPath id="art-shield-clip">
          <path d={shield} />
        </clipPath>
        <g clipPath="url(#art-shield-clip)">
          <rect x="82" y="62" width="92" height="150" fill="#260c10" />
          <rect x="82" y="62" width="40" height="66" fill="#982428" fillOpacity="0.85" />
          <rect x="134" y="128" width="40" height="84" fill="#982428" fillOpacity="0.85" />
          <rect x="122" y="62" width="12" height="150" fill={p.accent} fillOpacity="0.9" />
          <rect x="82" y="122" width="92" height="12" fill={p.accent} fillOpacity="0.9" />
        </g>
        <path d={shield} fill="none" stroke={p.accent} strokeWidth="3" strokeOpacity="0.95" />
      </Plate>
    </svg>
  );
}

/** Cold War: a globe split by the iron curtain, a star on each side. */
function GlobeArt() {
  const p = PALETTE.globe;
  const star = (cx: number, cy: number, r: number) => {
    const pts: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rad = i % 2 === 0 ? r : r * 0.42;
      pts.push(`${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`);
    }
    return pts.join(" ");
  };
  return (
    <svg viewBox="0 0 256 256" role="presentation" className="h-full w-full">
      <Plate id="art-globe" top={p.top} bottom={p.bottom} accent={p.accent}>
        <clipPath id="art-globe-clip">
          <circle cx="128" cy="118" r="62" />
        </clipPath>
        <g clipPath="url(#art-globe-clip)">
          <rect x="66" y="56" width="62" height="124" fill="#8c2426" fillOpacity="0.85" />
          <rect x="128" y="56" width="62" height="124" fill="#2a4a8c" fillOpacity="0.85" />
          <ellipse
            cx="128"
            cy="118"
            rx="61"
            ry="26"
            fill="none"
            stroke={p.accent}
            strokeOpacity="0.3"
          />
          <ellipse
            cx="128"
            cy="118"
            rx="61"
            ry="48"
            fill="none"
            stroke={p.accent}
            strokeOpacity="0.22"
          />
        </g>
        <circle
          cx="128"
          cy="118"
          r="62"
          fill="none"
          stroke={p.accent}
          strokeWidth="3"
          strokeOpacity="0.9"
        />
        <rect x="125" y="48" width="6" height="140" fill={p.accent} fillOpacity="0.95" />
        <polygon points={star(96, 110, 14)} fill="#f2ece0" />
        <polygon points={star(160, 110, 14)} fill="#f2ece0" />
      </Plate>
    </svg>
  );
}

/** The Great War: opposing trench lines with a wire belt between them. */
function TrenchArt() {
  const p = PALETTE.trenches;
  const zig = (y: number, depth: number) => {
    const teeth = 7;
    const span = 200;
    const x0 = 28;
    const pts: string[] = [];
    for (let i = 0; i <= teeth * 2; i += 1) {
      const x = x0 + (span * i) / (teeth * 2);
      pts.push(`${x.toFixed(1)},${(y + (i % 2 ? depth : -depth)).toFixed(1)}`);
    }
    return pts.join(" ");
  };
  return (
    <svg viewBox="0 0 256 256" role="presentation" className="h-full w-full">
      <Plate id="art-trench" top={p.top} bottom={p.bottom} accent={p.accent}>
        <g fill="none" stroke={p.accent} strokeWidth="4" strokeLinejoin="round">
          <polyline points={zig(62, 7)} strokeOpacity="0.92" />
          <polyline points={zig(78, 5)} strokeOpacity="0.4" />
          <polyline points={zig(178, 5)} strokeOpacity="0.4" />
          <polyline points={zig(194, 7)} strokeOpacity="0.92" />
        </g>
        <line
          x1="28"
          y1="128"
          x2="228"
          y2="128"
          stroke={p.accent}
          strokeOpacity="0.5"
          strokeWidth="2"
        />
        <g stroke={p.accent} strokeOpacity="0.85" strokeWidth="4">
          {[0, 1, 2, 3, 4].map((i) => {
            const x = 48 + i * 40;
            return (
              <g key={i}>
                <line x1={x - 9} y1={119} x2={x + 9} y2={137} />
                <line x1={x - 9} y1={137} x2={x + 9} y2={119} />
              </g>
            );
          })}
        </g>
      </Plate>
    </svg>
  );
}

export function ModuleArt({ motif, className }: ArtProps & { motif: string }) {
  const art =
    motif === "globe" ? <GlobeArt /> : motif === "trenches" ? <TrenchArt /> : <ShieldArt />;
  return <div className={className}>{art}</div>;
}
