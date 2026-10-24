// Chart colors for services, in the theme's palette; red is left out, so a service never reads as an error.
const COLORS = [
  'var(--vscode-charts-blue, #3794ff)',
  'var(--vscode-charts-orange, #d18616)',
  'var(--vscode-charts-green, #89d185)',
  'var(--vscode-charts-purple, #b180d7)',
  'var(--vscode-charts-yellow, #cca700)',
  'var(--vscode-terminal-ansiCyan, #4ec9b0)',
  'var(--vscode-terminal-ansiMagenta, #c586c0)',
];

/** A service's color, the same for that name everywhere: in Traces, Metrics, and their rails. */
export function serviceColor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index++) hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  return COLORS[hash % COLORS.length];
}
