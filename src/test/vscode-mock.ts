/** Load VS Code adapters with editor I/O replaced. Pure modules never need this. */
export function withVscode<T>(mock: unknown, load: () => T): T {
  const loader = require('node:module') as { _load: (name: string, ...args: unknown[]) => unknown; };
  const original = loader._load;
  loader._load = (name, ...args) => name === 'vscode' ? mock : original(name, ...args);
  try { return load(); } finally { loader._load = original; }
}
