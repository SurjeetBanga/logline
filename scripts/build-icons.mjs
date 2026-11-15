// Builds media/logline-icons.woff, the icon font for the status bar, and lists its glyphs under
// `contributes.icons` in package.json. Run `npm run build:icons` after changing a shape here, and
// commit both files.
//
// The status bar takes text and icon glyphs only, so the pie that shows how much of a plan limit is
// used is a glyph: one per 5%, with the exact percentage written beside it.
import { readFileSync, writeFileSync } from 'node:fs';
import svg2ttf from 'svg2ttf';
import ttf2woff from 'ttf2woff';

const FONT = 'media/logline-icons.woff';
/** Glyphs are drawn on a 1000-unit square, y up, and sit on the baseline like the editor's own icons. */
const EM = 1000;
const CENTER = EM / 2;
const FIRST_CODE = 0xe900;
export const PIE_STEP = 5;

const round = (value) => Math.round(value * 10) / 10;
const at = ([x, y]) => `${round(x)} ${round(y)}`;

/** A point on a circle, with the angle measured clockwise from the top. */
const onCircle = (cx, cy, r, angle) => [cx + r * Math.sin(angle), cy + r * Math.cos(angle)];

/** Quadratic segments along an arc, which TrueType stores as they are. */
function arc(cx, cy, r, from, to) {
  const steps = Math.max(1, Math.ceil(Math.abs(to - from) / (Math.PI / 8)));
  const step = (to - from) / steps;
  let d = '';
  for (let index = 1; index <= steps; index++) {
    const end = from + step * index;
    const control = onCircle(cx, cy, r / Math.cos(step / 2), end - step / 2);
    d += `Q${at(control)} ${at(onCircle(cx, cy, r, end))}`;
  }
  return d;
}

/** A filled circle, or a hole when drawn the other way round. */
function circle(cx, cy, r, hole = false) {
  const turn = hole ? -2 * Math.PI : 2 * Math.PI;
  return `M${at(onCircle(cx, cy, r, 0))}${arc(cx, cy, r, 0, turn)}Z`;
}

/** A ring with a slice filled clockwise from the top. */
function pie(percent) {
  const radius = 440;
  if (percent >= 100) return circle(CENTER, CENTER, radius);
  const ring = circle(CENTER, CENTER, radius) + circle(CENTER, CENTER, radius - 80, true);
  if (percent <= 0) return ring;
  const sweep = (percent / 100) * 2 * Math.PI;
  return `${ring}M${CENTER} ${CENTER}L${at(onCircle(CENTER, CENTER, radius, 0))}${arc(CENTER, CENTER, radius, 0, sweep)}Z`;
}

/** Points along a path of lines and cubic curves, given as `[x, y]` and `[c1, c2, end]` steps. */
function sample(start, steps) {
  const points = [start];
  let from = start;
  for (const step of steps) {
    if (step.length === 2) points.push(step);
    else {
      const [c1, c2, end] = step;
      for (let index = 1; index <= 16; index++) {
        const t = index / 16;
        const u = 1 - t;
        points.push(
          [0, 1].map(
            (axis) => u ** 3 * from[axis] + 3 * u * u * t * c1[axis] + 3 * u * t * t * c2[axis] + t ** 3 * end[axis],
          ),
        );
      }
    }
    from = points[points.length - 1];
  }
  return points;
}

/** The outline of a line drawn along the points with round ends, wound the same way as `circle`. */
function stroke(points, width) {
  const half = width / 2;
  const tangent = (index) => {
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 1)];
    const length = Math.hypot(after[0] - before[0], after[1] - before[1]);
    return [(after[0] - before[0]) / length, (after[1] - before[1]) / length];
  };
  const offset = (index, side) => {
    const [tx, ty] = tangent(index);
    return [points[index][0] - ty * half * side, points[index][1] + tx * half * side];
  };
  const cap = (index, direction) => {
    const [tx, ty] = tangent(index);
    const turned = [];
    for (let step = 1; step < 8; step++) {
      const angle = (step / 8) * Math.PI;
      const across = Math.cos(angle) * direction;
      const along = Math.sin(angle) * direction;
      turned.push([
        points[index][0] + half * (-ty * across + tx * along),
        points[index][1] + half * (tx * across + ty * along),
      ]);
    }
    return turned;
  };
  const last = points.length - 1;
  const outline = [
    ...points.map((_, index) => offset(index, 1)),
    ...cap(last, 1),
    ...points.map((_, index) => offset(last - index, -1)),
    ...cap(0, -1),
  ];
  // Twice the signed area: positive when the outline runs anticlockwise with y up.
  let area = 0;
  for (let index = 0; index < outline.length; index++) {
    const next = outline[(index + 1) % outline.length];
    area += outline[index][0] * next[1] - next[0] * outline[index][1];
  }
  if (area > 0) outline.reverse();
  return `M${outline.map(at).join('L')}Z`;
}

/** The Logline mark from media/icon.svg, in one colour: two braces around three dots. */
function mark() {
  const scale = 9.5;
  // The artwork is 128 units square with y down; `side` mirrors the left brace into the right one.
  const place =
    (side) =>
    ([x, y]) => [CENTER + (x - 64) * scale * side, CENTER - (y - 64) * scale];
  let d = '';
  for (const side of [1, -1]) {
    const to = place(side);
    // Each brace is two strokes that meet at its point, so no outline has to turn back on itself.
    const upper = sample(to([44, 30]), [
      [to([35, 30]), to([33, 35]), to([33, 42])],
      to([33, 52]),
      [to([33, 59]), to([30, 64]), to([22, 64])],
    ]);
    const lower = sample(to([22, 64]), [
      [to([30, 64]), to([33, 69]), to([33, 76])],
      to([33, 86]),
      [to([33, 93]), to([35, 98]), to([44, 98])],
    ]);
    d += stroke(upper, 7.5 * scale) + stroke(lower, 7.5 * scale);
  }
  for (const x of [48, 64, 80]) d += circle(CENTER + (x - 64) * scale, CENTER, 5.2 * scale);
  return d;
}

const glyphs = [{ name: 'logline-mark', description: 'Logline', d: mark() }];
for (let percent = 0; percent <= 100; percent += PIE_STEP)
  glyphs.push({ name: `logline-pie-${percent}`, description: `${percent}% used`, d: pie(percent) });

const svg = `<?xml version="1.0" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg"><defs>
<font id="logline-icons" horiz-adv-x="${EM}">
<font-face font-family="logline-icons" units-per-em="${EM}" ascent="${EM}" descent="0"/>
<missing-glyph horiz-adv-x="0"/>
${glyphs.map((glyph, index) => `<glyph glyph-name="${glyph.name}" unicode="&#x${(FIRST_CODE + index).toString(16)};" horiz-adv-x="${EM}" d="${glyph.d}"/>`).join('\n')}
</font></defs></svg>`;

// A fixed timestamp, so the same shapes always give the same file.
const ttf = svg2ttf(svg, { ts: 0, version: '1.0', description: 'Logline status bar icons', url: '' });
writeFileSync(FONT, Buffer.from(ttf2woff(ttf.buffer)));

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
manifest.contributes.icons = Object.fromEntries(
  glyphs.map((glyph, index) => [
    glyph.name,
    {
      description: glyph.description,
      default: { fontPath: FONT, fontCharacter: `\\${(FIRST_CODE + index).toString(16).toUpperCase()}` },
    },
  ]),
);
const text = `${JSON.stringify(manifest, null, 2)}\n`;
if (text !== readFileSync('package.json', 'utf8')) writeFileSync('package.json', text);
console.log(`${FONT}: ${glyphs.length} glyphs`);
