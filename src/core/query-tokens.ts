/** Split terms without altering quoted literals or whitespace inside ranges. */
export function queryTokens(input: string): string[] {
  return input.match(/(?:"(?:\\.|[^"\\])*"?|\[[^\]"\r\n]*\]|[^\s"\[]|\[)+/g) ?? [];
}
