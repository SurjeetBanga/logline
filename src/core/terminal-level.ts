/** Conservative severity parsing for unstructured terminal lines. */
export function terminalLevel(text: string): string {
  const match = text.match(/^\s*(?:\[[^\]]+\]\s*)?(?:\d{4}-\d\d?-\d\d?(?:[T ][^ ]+)?\s+)?(?:\[[ ]*)?(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)(?:\s*\]|\b)/i);
  if (!match) return 'unclassified';
  const value = match[1].toLowerCase();
  return value === 'warning' ? 'warn' : value;
}
