import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';

// The layers in ARCHITECTURE.md and the layers each one may load at runtime. Type-only imports are free:
// they disappear from the compiled output. The extension host (vscode, extension.ts) may load any host layer.
const ALLOWED: Record<string, string[]> = {
  core: ['core'],
  capture: ['capture', 'core'],
  storage: ['storage', 'core'],
  transfer: ['transfer', 'core'],
  protocol: ['protocol', 'core'],
  // Bundled alone into out/mcp.js and run outside the editor.
  mcp: ['mcp', 'protocol'],
  // Bundled for the browser: only DOM-free core helpers cross over.
  webview: ['webview', 'core'],
  vscode: ['vscode', 'core', 'capture', 'storage', 'transfer', 'protocol'],
  'extension.ts': ['vscode', 'core', 'capture', 'storage', 'transfer', 'protocol'],
};

const src = join(__dirname, '..', 'src');
const layerOf = (file: string) => relative(src, file).split(sep)[0];

function runtimeImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  for (const match of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) {
    if (!match[1]) specifiers.push(match[2]);
  }
  return specifiers;
}

const sources = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
  .map(name => join(src, name))
  .filter(file => layerOf(file) !== 'test');

test('every source file belongs to a layer in ARCHITECTURE.md', () => {
  const unknown = sources.filter(file => !(layerOf(file) in ALLOWED)).map(file => relative(src, file));
  assert.deepEqual(unknown, [], 'add the new layer to ALLOWED and to ARCHITECTURE.md');
});

test('layers load only the layers below them, and only the editor host loads vscode', () => {
  const violations: string[] = [];
  for (const file of sources) {
    const layer = layerOf(file);
    for (const specifier of runtimeImports(file)) {
      const name = relative(src, file);
      if (specifier === 'vscode') {
        if (layer !== 'vscode' && layer !== 'extension.ts') violations.push(`${name} loads vscode`);
      } else if (specifier.startsWith('.')) {
        const target = layerOf(resolve(dirname(file), specifier));
        if (!ALLOWED[layer]?.includes(target)) violations.push(`${name} loads ${target} (${specifier})`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
