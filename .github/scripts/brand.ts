// Draws the brand from one mark, a fleet in formation: the source in front, in green, and the same skill on every
// machine behind it. It makes the logo, the favicons, the icons a phone and a shared link show, and the README banner,
// in .github/assets.
// Usage: node --no-warnings .github/scripts/brand.ts (needs sharp)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import sharp from "sharp";

// Picked in oklch and written as hex, because librsvg, which renders the PNGs, doesn't read oklch(). Contrast is on INK.
const INK = "#081319"; // oklch(0.18 0.02 230)
const TILE = "#182429"; // oklch(0.25 0.02 230), 1.2:1, a cell with nothing in it
const PAPER = "#f5f2e9"; // oklch(0.96 0.012 90), 16.7:1
const MUTED = "#a5b4bb"; // oklch(0.76 0.02 230), 8.8:1
const FAINT = "#75838a"; // oklch(0.6 0.02 230), 4.8:1
const SYNC = "#59e1a2"; // oklch(0.82 0.15 160), 11.4:1, a skill that is current

// The mark, in a 128 box: five tiles in a V, like ships or birds in formation. The lead tile is the source, in green, and
// the four behind it are the copies it keeps current. Five tiles, not nine, so it still reads as a shape at 16 pixels.
const formation: [x: number, y: number][] = [
  [51, 15],
  [33, 51],
  [69, 51],
  [15, 87],
  [87, 87],
];
const tiles = (dx = 0, dy = 0) =>
  formation
    .map(
      ([x, y], i) =>
        `<rect x="${x + dx}" y="${y + dy}" width="26" height="26" rx="7" fill="${i === 0 ? SYNC : PAPER}"/>`,
    )
    .join("\n");
const mark = tiles();

const svg = (size: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128" role="img" aria-labelledby="t">
<title id="t">skillfleet</title>
${body}
</svg>
`;

// The logo and favicons: the mark on a rounded ink tile, so it reads on light and dark pages alike.
const logo = (size: number) =>
  svg(size, `<rect width="128" height="128" rx="28" fill="${INK}"/>\n${mark}`);
// A phone and a shared link round the corners themselves.
const tile = (size: number) => svg(size, `<rect width="128" height="128" fill="${INK}"/>\n${mark}`);

const font = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// On the right, every agent on every system holds the same skills: one green tile per pair.
const agents = ["Claude", "Codex", "Gemini", "Cursor"];
const systems = ["Linux", "macOS", "Windows"];
const grid = `<g font-family="${mono}" font-size="17" fill="${FAINT}">
${agents.map((agent, i) => `<text x="${924 + i * 76}" y="104" text-anchor="middle">${agent}</text>`).join("\n")}
${systems.map((system, i) => `<text x="868" y="${150 + i * 76}" text-anchor="end">${system}</text>`).join("\n")}
</g>
${systems
  .flatMap((_, row) =>
    agents.map(
      (_, col) =>
        `<rect x="${898 + col * 76}" y="${118 + row * 76}" width="52" height="52" rx="12" fill="${SYNC}"/>`,
    ),
  )
  .join("\n")}`;

// The name and a line on the left, the two commands under them; the grid on the right.
const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="400" viewBox="0 0 1280 400" role="img" aria-labelledby="t">
<title id="t">skillfleet: the same skills on every agent and every machine, kept current by a timer</title>
<clipPath id="frame"><rect width="1280" height="400" rx="24"/></clipPath>
<g clip-path="url(#frame)">
<rect width="1280" height="400" fill="${INK}"/>
<rect x="780" y="0" width="500" height="400" fill="${TILE}" opacity=".35"/>
${grid}
<g transform="translate(80 78) scale(.7)">\n${tiles(-15, -15)}\n</g>\n<text x="172" y="146" fill="${PAPER}" font-family="${font}" font-size="88" font-weight="700" letter-spacing="-3">skillfleet</text>
<text x="80" y="200" fill="${MUTED}" font-family="${font}" font-size="28">The same skills on every agent and every machine.</text>
<g font-family="${mono}" font-size="22">
<text x="80" y="286" fill="${FAINT}">$ <tspan fill="${PAPER}">npx skillfleet init</tspan> <tspan fill="${SYNC}">onmax/skills</tspan></text>
<text x="80" y="326" fill="${FAINT}">$ <tspan fill="${PAPER}">skillfleet fleet sync</tspan>  # every machine, over SSH</text>
</g>
</g>
</svg>
`;

const write = (file: string, content: string | Buffer) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(file);
};
const png = (source: string, size: number) =>
  sharp(Buffer.from(source), { density: 300 }).resize(size, size).png().toBuffer();

// An .ico is a directory of images, and each may be a whole PNG.
const ico = (images: [size: number, png: Buffer][]) => {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(([size, data], i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size, at);
    head.writeUInt8(size, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map(([, data]) => data)]);
};

write(".github/assets/logo.svg", logo(64));
write(".github/assets/favicon.svg", logo(32));
write(".github/assets/favicon-32.png", await png(logo(32), 32));
write(
  ".github/assets/favicon.ico",
  ico(
    await Promise.all(
      [16, 32, 48].map(async (size) => [size, await png(logo(size), size)] as const),
    ),
  ),
);
write(".github/assets/apple-touch-icon.png", await png(tile(180), 180));
write(".github/assets/logo-512.png", await png(tile(512), 512));
write(".github/assets/banner.svg", banner);
write(
  ".github/assets/banner.png",
  await sharp(Buffer.from(banner), { density: 144 }).png().toBuffer(),
);
