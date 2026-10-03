import { queryTokens } from './query-tokens';

/** Validate the user-visible parts of regex query syntax without loading the
 * host-only RE2/WASM runtime into the browser bundle. */
export function queryError(input = ''): string | undefined {
  for (const token of queryTokens(input)) {
    if (token === 'OR' || token.toLowerCase() === 'or') continue;
    const value = token.startsWith('-') ? token.slice(1) : token;
    const match = value.match(/^@?[A-Za-z_][A-Za-z0-9_.]*:(\/.*\/([dgimsuvy]*))$/) ?? value.match(/^(\/.*\/([dgimsuvy]*))$/);
    if (!match) continue;
    const pattern = match[1].slice(1, match[1].lastIndexOf('/'));
    const flags = match[2];
    const unsupported = [...new Set(flags.split('').filter(flag => !'gimsuy'.includes(flag)))];
    if (unsupported.length) return `Unsupported regular expression flag${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}`;
    if (/\(\?[=!<]|\\(?:[1-9]|k<)/.test(pattern)) return 'Unsupported regular expression syntax. RE2 does not allow lookaround or backreferences.';
    try { new RegExp(pattern, flags.includes('u') ? flags : `${flags}u`); } catch { return 'Unsupported or invalid regular expression syntax.'; }
  }
  return undefined;
}
