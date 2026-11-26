/**
 * Faster ways to answer a search's regular expression, with the answers RE2 gives.
 *
 * Searches run their regular expressions on RE2, which never backtracks, so no pattern can stall the extension
 * host. But each call into its WebAssembly build costs microseconds, and a search over a full store makes one
 * for every event. `planRegex` reads a pattern RE2 accepted, in the JavaScript syntax the search box takes, and finds:
 *
 * - `native`: an equivalent native expression, for a pattern whose matches have a bounded length and few ways
 *   to be found. It is written from the parsed pattern with RE2's meaning of `.`, `\s`, `^`, and the rest, and
 *   its backtracking is bounded by the pattern alone, so it runs in time linear in the text.
 * - `prefilter`: otherwise, text that every match contains, as a native expression of plain literals that
 *   cannot backtrack. Text without it cannot match, so RE2 only reads the text that has it.
 *
 * A pattern with anything this reader does not know gets neither, and is left to RE2 alone.
 */

/** What a search can use before, or instead of, RE2. */
export interface RegexPlan {
  /** Gives RE2's answer for every text, in linear time. */
  native?: RegExp;
  /** Matches every text RE2 matches, and more: a text it rejects cannot match. */
  prefilter?: RegExp;
}

// The most backtracking a native expression may do from one position in the text: its number of ways to
// match times the length of its longest match.
const NATIVE_COST = 256;
// Bounds on the literal sets the prefilter tracks, so a pattern cannot make them large.
const MAX_STRINGS = 16;
const MAX_LENGTH = 64;
const MAX_REQUIRED = 32;

type Node =
  /** One character, literally. */
  | { kind: 'char'; char: string }
  /** One character of a set; `native` spells the set with RE2's meaning, when that can be done. */
  | { kind: 'set'; native?: string }
  /** A zero-width assertion, such as `^` or `\b`. */
  | { kind: 'assert'; native?: string }
  | { kind: 'group'; alternatives: Node[][] }
  | { kind: 'repeat'; node: Node; min: number; max: number };

interface Flags {
  ignoreCase: boolean;
  multiline: boolean;
  dotAll: boolean;
}

/** A pattern this reader does not know, which it leaves to RE2. */
class Unknown extends Error {}
const unknown = (): never => {
  throw new Unknown();
};

const SYNTAX = '^$\\.*+?()[]{}|/';
const HEX = /^[0-9A-Fa-f]+$/;
const isAscii = (char: string) => char.codePointAt(0)! < 0x80;
/** A code point, spelled so that it means itself in or out of a class, in Unicode mode. */
const literal = (char: string) => `\\u{${char.codePointAt(0)!.toString(16)}}`;
const SPACE = '\\t\\n\\f\\r ';
const WORD = '0-9A-Za-z_';

function parse(source: string, flags: Flags): Node[][] {
  let at = 0;

  function codePoint(): string {
    const char = String.fromCodePoint(source.codePointAt(at)!);
    at += char.length;
    return char;
  }

  function hex(length: number): string {
    const digits = source.slice(at, at + length);
    if (digits.length !== length || !HEX.test(digits)) unknown();
    at += length;
    return digits;
  }

  /** A character an escape stands for: `\u{1F600}`, `\x41`, `\n`, `\.`. */
  function escapedChar(letter: string): string | undefined {
    if (letter === 't') return '\t';
    if (letter === 'n') return '\n';
    if (letter === 'r') return '\r';
    if (letter === 'f') return '\f';
    if (letter === 'v') return '\v';
    if (letter === '0') {
      if (/[0-9]/.test(source[at] ?? '')) unknown();
      return '\0';
    }
    if (letter === 'x') return String.fromCodePoint(parseInt(hex(2), 16));
    if (letter === 'u') {
      if (source[at] === '{') {
        const end = source.indexOf('}', at);
        if (end < 0) unknown();
        const digits = source.slice(at + 1, end);
        if (!digits || !HEX.test(digits) || parseInt(digits, 16) > 0x10ffff) unknown();
        at = end + 1;
        return String.fromCodePoint(parseInt(digits, 16));
      }
      const code = parseInt(hex(4), 16);
      // A surrogate pair spelled as two escapes is one character to JavaScript and two to RE2's translation.
      if (code >= 0xd800 && code <= 0xdfff) unknown();
      return String.fromCodePoint(code);
    }
    if (SYNTAX.includes(letter)) return letter;
    return undefined;
  }

  function escape(): Node {
    const letter = source[at++];
    if (letter === undefined) unknown();
    if (letter === 'd') return { kind: 'set', native: '[0-9]' };
    if (letter === 'D') return { kind: 'set', native: '[^0-9]' };
    if (letter === 's') return { kind: 'set', native: `[${SPACE}]` };
    if (letter === 'S') return { kind: 'set', native: `[^${SPACE}]` };
    // RE2's word characters are ASCII; with `i`, JavaScript's also fold in the Kelvin sign and long s.
    if (letter === 'w') return { kind: 'set', native: flags.ignoreCase ? undefined : `[${WORD}]` };
    if (letter === 'W') return { kind: 'set', native: flags.ignoreCase ? undefined : `[^${WORD}]` };
    if (letter === 'b') return { kind: 'assert', native: flags.ignoreCase ? undefined : '\\b' };
    // RE2 reads UTF-8 bytes, and `\B` also holds between the bytes of one character outside ASCII.
    if (letter === 'B') return { kind: 'assert' };
    const char = escapedChar(letter);
    if (char === undefined) return unknown();
    return { kind: 'char', char };
  }

  function characterClass(): Node {
    const negated = source[at] === '^';
    if (negated) at++;
    // `[]` and `[^]` mean different things to JavaScript and RE2.
    if (source[at] === ']') unknown();
    const parts: string[] = [];
    const chars: string[] = [];
    let known = true;
    let ranges = 0;
    /** One member: a character, or a set such as `\d` (undefined for a set RE2 reads differently). */
    const member = (): { char: string } | { set: string | undefined } => {
      if (source[at] === '\\') {
        at++;
        const letter = source[at++];
        if (letter === undefined) unknown();
        if (letter === 'd') return { set: '0-9' };
        if (letter === 's') return { set: SPACE };
        if (letter === 'w') return { set: flags.ignoreCase ? undefined : WORD };
        if (letter === 'D' || letter === 'S' || letter === 'W') return { set: undefined };
        if (letter === 'b') return { char: '\b' };
        if (letter === '-') return { char: '-' };
        const char = escapedChar(letter);
        if (char === undefined) return unknown();
        return { char };
      }
      // RE2 reads `[[:alpha:]]` as a class of letters.
      if (source[at] === '[') unknown();
      return { char: codePoint() };
    };
    while (source[at] !== ']') {
      if (at >= source.length) unknown();
      const first = member();
      if ('set' in first) {
        if (first.set === undefined) known = false;
        else parts.push(first.set);
        if (source[at] === '-' && source[at + 1] !== ']') unknown();
        continue;
      }
      if (source[at] === '-' && source[at + 1] !== ']' && at + 1 < source.length) {
        at++;
        const last = member();
        if (!('char' in last) || first.char.codePointAt(0)! > last.char.codePointAt(0)!) return unknown();
        if (flags.ignoreCase && (!isAscii(first.char) || !isAscii(last.char))) known = false;
        parts.push(`${literal(first.char)}-${literal(last.char)}`);
        ranges++;
        continue;
      }
      if (flags.ignoreCase && !isAscii(first.char)) known = false;
      parts.push(literal(first.char));
      chars.push(first.char);
    }
    at++;
    // A class of one character, such as `[.]`, is that character.
    if (!negated && ranges === 0 && chars.length === 1 && parts.length === 1) return { kind: 'char', char: chars[0] };
    return { kind: 'set', native: known ? `[${negated ? '^' : ''}${parts.join('')}]` : undefined };
  }

  function atom(): Node {
    const char = source[at];
    // With `m`, a line's start and end are left to RE2: V8 tries lookarounds between the halves of a
    // character outside the Basic Multilingual Plane, where RE2 has no position.
    if (char === '^') {
      at++;
      return { kind: 'assert', native: flags.multiline ? undefined : '^' };
    }
    // The end of the text, spelled so V8 does not start its search one code unit before the end, which
    // misses a match ending in a character such as an emoji (`/[^a]$/u` does not match '😀').
    if (char === '$') {
      at++;
      return { kind: 'assert', native: flags.multiline ? undefined : '(?![^])' };
    }
    if (char === '.') {
      at++;
      return { kind: 'set', native: flags.dotAll ? '[^]' : '[^\\n]' };
    }
    if (char === '[') {
      at++;
      return characterClass();
    }
    if (char === '\\') {
      at++;
      return escape();
    }
    if (char === '(') {
      if (source.startsWith('(?:', at)) at += 3;
      else if (source.startsWith('(?<', at) && source[at + 3] !== '=' && source[at + 3] !== '!') {
        const name = /^\(\?<([A-Za-z_$][\w$]*)>/.exec(source.slice(at));
        if (!name) unknown();
        at += name![0].length;
      } else if (source[at + 1] === '?') unknown();
      else at++;
      const alternatives = disjunction();
      if (source[at] !== ')') unknown();
      at++;
      return { kind: 'group', alternatives };
    }
    if ('*+?{}])|'.includes(char)) unknown();
    return { kind: 'char', char: codePoint() };
  }

  function quantifier(): { min: number; max: number } | undefined {
    const char = source[at];
    let bounds: { min: number; max: number } | undefined;
    if (char === '*') bounds = { min: 0, max: Infinity };
    else if (char === '+') bounds = { min: 1, max: Infinity };
    else if (char === '?') bounds = { min: 0, max: 1 };
    if (bounds) at++;
    else if (char === '{') {
      const match = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(at));
      if (!match) unknown();
      const min = Number(match![1]);
      const max = match![2] === undefined ? min : match![3] === '' ? Infinity : Number(match![3]);
      if (max < min) unknown();
      at += match![0].length;
      bounds = { min, max };
    } else return undefined;
    // A lazy quantifier finds a match where the greedy one does.
    if (source[at] === '?') at++;
    return bounds;
  }

  function alternative(): Node[] {
    const nodes: Node[] = [];
    while (at < source.length && source[at] !== '|' && source[at] !== ')') {
      const node = atom();
      const bounds = quantifier();
      if (bounds && node.kind === 'assert') unknown();
      nodes.push(bounds ? { kind: 'repeat', node, ...bounds } : node);
    }
    return nodes;
  }

  function disjunction(): Node[][] {
    const alternatives = [alternative()];
    while (source[at] === '|') {
      at++;
      alternatives.push(alternative());
    }
    return alternatives;
  }

  const alternatives = disjunction();
  if (at !== source.length) unknown();
  return alternatives;
}

interface Native {
  source: string;
  /** Ways to match, capped just above the limit. */
  paths: number;
  /** The longest match. */
  width: number;
}

const cap = (value: number) => Math.min(value, NATIVE_COST + 1);

function nativeNode(node: Node, flags: Flags): Native | undefined {
  if (node.kind === 'char') {
    // RE2 and JavaScript fold the case of ASCII letters alike; other scripts are left to RE2.
    if (flags.ignoreCase && !isAscii(node.char)) return undefined;
    return { source: literal(node.char), paths: 1, width: 1 };
  }
  if (node.kind === 'set') return node.native === undefined ? undefined : { source: node.native, paths: 1, width: 1 };
  if (node.kind === 'assert')
    return node.native === undefined ? undefined : { source: node.native, paths: 1, width: 0 };
  if (node.kind === 'group') {
    const inner = nativeAlternatives(node.alternatives, flags);
    return inner && { ...inner, source: `(?:${inner.source})` };
  }
  if (node.max === Infinity) return undefined;
  const inner = nativeNode(node.node, flags);
  if (!inner) return undefined;
  let paths = 0;
  for (let count = node.min, power = cap(inner.paths ** node.min); count <= node.max; count++) {
    paths = cap(paths + power);
    power = cap(power * inner.paths);
    if (paths > NATIVE_COST) break;
  }
  return {
    source: `(?:${inner.source}){${node.min},${node.max}}`,
    paths,
    width: Math.min(node.max * inner.width, NATIVE_COST + 1),
  };
}

function nativeAlternatives(alternatives: Node[][], flags: Flags): Native | undefined {
  const sources: string[] = [];
  let paths = 0;
  let width = 0;
  for (const nodes of alternatives) {
    let alternativePaths = 1;
    let alternativeWidth = 0;
    let source = '';
    for (const node of nodes) {
      const native = nativeNode(node, flags);
      if (!native) return undefined;
      source += native.source;
      alternativePaths = cap(alternativePaths * native.paths);
      alternativeWidth = Math.min(alternativeWidth + native.width, NATIVE_COST + 1);
    }
    sources.push(source);
    paths = cap(paths + alternativePaths);
    width = Math.max(width, alternativeWidth);
  }
  return { source: sources.join('|'), paths, width };
}

/** What a part of a pattern says about the text it matches. */
interface Facts {
  /** Every text it can match, when they are few. */
  exact?: string[];
  /** Texts one of which every match contains. */
  required?: string[];
}

/** Every concatenation of a text from `left` with one from `right`, unless there are too many or they are too long. */
function cross(left: string[], right: string[]): string[] | undefined {
  if (left.length * right.length > MAX_STRINGS) return undefined;
  const result = new Set<string>();
  for (const a of left) for (const b of right) result.add(a + b);
  for (const text of result) if (text.length > MAX_LENGTH) return undefined;
  return [...result];
}

/** The texts to look for: the set whose shortest text is longest, so it rejects the most. */
function best(candidates: string[][]): string[] | undefined {
  let chosen: string[] | undefined;
  let chosenScore = 0;
  for (const candidate of candidates) {
    const score = Math.min(...candidate.map((text) => text.length));
    if (score > chosenScore || (score === chosenScore && chosen && candidate.length < chosen.length)) {
      chosen = candidate;
      chosenScore = score;
    }
  }
  return chosenScore > 0 ? chosen : undefined;
}

function factsOf(node: Node, flags: Flags): Facts {
  if (node.kind === 'char') {
    if (flags.ignoreCase && !isAscii(node.char)) return {};
    return { exact: [node.char], required: [node.char] };
  }
  // An assertion matches no text, so the texts on either side of it are next to each other.
  if (node.kind === 'assert') return { exact: [''] };
  if (node.kind === 'set') return {};
  if (node.kind === 'group') return alternativesFacts(node.alternatives, flags);
  const inner = factsOf(node.node, flags);
  if (node.min === node.max && inner.exact) {
    let exact: string[] | undefined = [''];
    for (let count = 0; count < node.min && exact; count++) exact = cross(exact, inner.exact);
    if (exact) return { exact, required: best([exact]) };
  }
  return node.min >= 1 ? { required: inner.required } : {};
}

function sequenceFacts(nodes: Node[], flags: Flags): Facts {
  const candidates: string[][] = [];
  // The texts the nodes since the last unknown one can match, one after another.
  let run: string[] = [''];
  let whole = true;
  const flush = () => {
    if (run.every((text) => text !== '')) candidates.push(run);
    run = [''];
    whole = false;
  };
  const extend = (exact: string[]) => {
    const longer = cross(run, exact);
    if (longer) run = longer;
    else {
      flush();
      run = exact;
    }
  };
  for (const node of nodes) {
    if (node.kind === 'repeat' && node.min >= 1 && node.min !== node.max) {
      // Matched at least once, so its match starts and ends with a match of the repeated part.
      const inner = factsOf(node.node, flags);
      if (inner.exact) {
        extend(inner.exact);
        flush();
        run = inner.exact;
      } else {
        flush();
        if (inner.required) candidates.push(inner.required);
      }
      continue;
    }
    const facts = factsOf(node, flags);
    if (facts.exact) extend(facts.exact);
    else {
      flush();
      if (facts.required) candidates.push(facts.required);
    }
  }
  const exact = whole ? run : undefined;
  flush();
  return { exact, required: best(candidates) };
}

function alternativesFacts(alternatives: Node[][], flags: Flags): Facts {
  const facts = alternatives.map((nodes) => sequenceFacts(nodes, flags));
  let exact: string[] | undefined = [];
  let required: string[] | undefined = [];
  for (const fact of facts) {
    exact = exact && fact.exact ? [...new Set([...exact, ...fact.exact])] : undefined;
    required = required && fact.required ? [...new Set([...required, ...fact.required])] : undefined;
  }
  if (exact && exact.length > MAX_STRINGS) exact = undefined;
  if (required && required.length > MAX_REQUIRED) required = undefined;
  return { exact, required };
}

/**
 * The native expressions a search can use for an RE2 pattern, given in JavaScript syntax with its flags.
 * Call it only for a pattern RE2 accepted: one RE2 rejects may get a plan it should not.
 */
export function planRegex(source: string, flags: string): RegexPlan {
  const read: Flags = { ignoreCase: flags.includes('i'), multiline: flags.includes('m'), dotAll: flags.includes('s') };
  const nativeFlags = read.ignoreCase ? 'iu' : 'u';
  try {
    const alternatives = parse(source, read);
    // A sticky expression matches only where the text starts, which `test` does not say natively here.
    const native = flags.includes('y') ? undefined : nativeAlternatives(alternatives, read);
    if (native && native.paths * Math.max(native.width, 1) <= NATIVE_COST)
      return { native: new RegExp(native.source, nativeFlags) };
    const required = alternativesFacts(alternatives, read).required;
    // One character rejects too little text to be worth testing first.
    if (!required || required.some((text) => [...text].length < 2)) return {};
    return { prefilter: new RegExp(required.map((text) => [...text].map(literal).join('')).join('|'), nativeFlags) };
  } catch {
    return {};
  }
}
