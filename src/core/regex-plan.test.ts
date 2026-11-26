import assert from 'node:assert/strict';
import test from 'node:test';
import { RE2 } from 're2-wasm';
import { planRegex } from './regex-plan';

const plan = (source: string, flags = '') => planRegex(source, `${flags}u`);

test('a pattern of bounded length runs natively, with the answers RE2 gives', () => {
  for (const source of [
    'request\\s4\\d{3}\\b',
    '(?:GET|POST) \\/api',
    'HTTP\\/1\\.[01]" 5\\d\\d',
    'ERR\\d{1,4}',
    'timeout',
  ]) {
    const { native, prefilter } = plan(source);
    assert.ok(native, source);
    assert.equal(prefilter, undefined, source);
  }
  assert.ok(plan('request\\s4').native?.test('{"message":"request 42"}'));
  assert.equal(plan('request\\s4').native?.test('request\u00a04'), false, 'RE2 reads \\s as ASCII space only');
  assert.equal(plan('a.b').native?.test('a\rb'), true, 'RE2 reads . as anything but \\n');
  assert.equal(plan('a.b').native?.test('a\nb'), false);
  assert.equal(plan('a.b', 's').native?.test('a\nb'), true);
  assert.equal(plan('[.]x').native?.test('.x'), true);
  // V8 starts `/[^a]$/u` one code unit before the end, inside the emoji, and finds nothing.
  assert.equal(plan('[^a]$').native?.test('\u{1f600}'), true);
  assert.equal(plan('.$').native?.test('x\u{1f600}'), true);
  // V8 tries lookarounds between an emoji's halves, so the start and end of a line are left to RE2.
  assert.equal(plan('^b', 'm').native, undefined);
  assert.ok(plan('^request.*$', 'm').prefilter);
});

test('a pattern that could backtrack far is left to RE2', () => {
  for (const source of ['\\d+x', 'a.*b', 'a{0,300}', '(a|b){10}', '(?:a{0,15}){0,15}'])
    assert.equal(plan(source).native, undefined, source);
  assert.equal(plan('\\d+x', 'y').native, undefined);
  assert.equal(plan('timeout', 'y').native, undefined, 'a sticky expression anchors where the text starts');
});

test('a pattern RE2 must read is tested first for the text its every match contains', () => {
  const status = plan('"status":5\\d+').prefilter;
  assert.ok(status);
  assert.equal(status.test('{"status":503}'), true);
  assert.equal(status.test('{"status":200}'), false);
  const either = plan('(timeout|refused).*conn').prefilter;
  assert.ok(either?.test('connect refused: conn reset'));
  assert.equal(either?.test('connection reset'), false);
  assert.ok(plan('a+b').prefilter?.test('aab'));
  assert.equal(plan('a+b').prefilter?.test('a b'), false);
  assert.ok(plan('(?<code>E\\d+)-failed.*').prefilter?.test('E1-failed'), 'a repeat starts and ends with its part');
  assert.ok(plan('Timeout.*', 'i').prefilter?.test('TIMEOUT'));
  // Too little to look for, or nothing every match contains.
  for (const source of ['\\d+x', '.*', '\\w+', 'a.*|b.*', 'x+y*']) assert.deepEqual(plan(source), {}, source);
  // Non-ASCII text under `i` folds as RE2 decides.
  assert.deepEqual(plan('café.*', 'i'), { prefilter: plan('caf.*', 'i').prefilter });
  // Too many combinations to list keeps the longest text that is still certain.
  const many = plan('(a|b|c|d|e)(f|g|h|i)-request.*').prefilter;
  assert.ok(many?.test('cg-request'));
  assert.equal(many?.test('cg-reply'), false);
  assert.ok(plan('a\\0b.*').prefilter?.test('a\0b'));
});

test('syntax the reader does not know is left to RE2', () => {
  for (const source of [
    '\\p{L}+',
    '[[:alpha:]]+x',
    '\\cA+',
    '(?i)ab.*',
    '[]a]+',
    '\\uD83D\\uDE00+',
    'a\\1+',
    '\\Qa.b\\E',
    'a\\01.*',
  ])
    assert.deepEqual(plan(source), {}, source);
  assert.deepEqual(plan('\\w+\\W', 'i'), {});
  assert.equal(plan('\\bword\\b', 'i').native, undefined, 'JavaScript folds more letters into \\w under i');
  assert.ok(plan('\\bword\\b', 'i').prefilter);
});

/** A small seeded generator, so a failure names a pattern that fails again. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// REGEX_PLAN_SEED and REGEX_PLAN_ROUNDS search further, to look for a disagreement.
test('native expressions answer as RE2 does, and prefilters keep every text RE2 matches', () => {
  const rounds = Number(process.env.REGEX_PLAN_ROUNDS ?? 1500);
  const next = random(Number(process.env.REGEX_PLAN_SEED ?? 20261126));
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)];
  const chars = [
    'a',
    'b',
    'k',
    's',
    'K',
    'A',
    '1',
    '-',
    '_',
    ' ',
    'é',
    '😀',
    '\\u212A',
    '\\u{17f}',
    '\\.',
    '\\n',
    '\\r',
    '\\x41',
  ];
  const sets = [
    '.',
    '\\d',
    '\\D',
    '\\s',
    '\\S',
    '\\w',
    '\\W',
    '[a-c]',
    '[^a]',
    '[k-s]',
    '[\\d_]',
    '[-a]',
    '[é]',
    '[.]',
    '[^\\s]',
    '[A-Z]',
  ];
  const asserts = ['^', '$', '\\b', '\\B'];
  const quantifiers = ['', '', '', '', '?', '*', '+', '{2}', '{1,3}', '{0,2}', '{2,}', '+?'];
  const inputs = [
    'a',
    'b',
    'k',
    's',
    'K',
    'S',
    'A',
    'K',
    'ſ',
    '1',
    '9',
    '-',
    '_',
    ' ',
    '\n',
    '\r',
    ' ',
    'é',
    'É',
    '.',
    '\t',
    '😀',
  ];
  const atom = (depth: number): string => {
    const roll = next();
    if (roll < 0.45) return pick(chars);
    if (roll < 0.75) return pick(sets);
    if (roll < 0.85) return pick(asserts);
    if (depth > 1) return pick(chars);
    return `${pick(['(', '(?:', '(?<g>'])}${disjunction(depth + 1)})`;
  };
  const sequence = (depth: number) => {
    let source = '';
    for (let count = 1 + Math.floor(next() * 4); count > 0; count--) {
      const part = atom(depth);
      source += part + (asserts.includes(part) ? '' : pick(quantifiers));
    }
    return source;
  };
  const disjunction = (depth: number) => Array.from({ length: next() < 0.75 ? 1 : 2 }, () => sequence(depth)).join('|');

  let natives = 0;
  let prefilters = 0;
  for (let round = 0; round < rounds; round++) {
    const source = disjunction(0);
    const flags = `${pick(['', 'i', 'm', 's', 'im', 'is', 'ms', 'ims'])}u`;
    let regex: RE2;
    try {
      regex = new RE2(source, flags);
    } catch {
      continue;
    }
    const { native, prefilter } = planRegex(source, flags);
    if (native) natives++;
    if (prefilter) prefilters++;
    for (let sample = 0; sample < 40; sample++) {
      let text = '';
      for (let length = Math.floor(next() * 8); length > 0; length--) text += pick(inputs);
      regex.lastIndex = 0;
      const expected = regex.test(text);
      const shown = `/${source}/${flags} on ${[...text].map((char) => `U+${char.codePointAt(0)!.toString(16)}`).join(' ')}`;
      if (native) assert.equal(native.test(text), expected, `native ${native}: ${shown}`);
      if (prefilter && expected) assert.ok(prefilter.test(text), `prefilter ${prefilter}: ${shown}`);
    }
  }
  assert.ok(natives > 200, `${natives} patterns ran natively`);
  assert.ok(prefilters > 50, `${prefilters} patterns had a prefilter`);
});
