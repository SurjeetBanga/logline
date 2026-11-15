import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutColumnWidths } from './layout';

const columns = [
  { key: 'base:time', label: 'Time' },
  { key: 'base:level', label: 'Level' },
  { key: 'base:source', label: 'Source' },
  { key: 'base:message', label: 'Message' },
];

function layout(available: number, widths: Record<string, number> = {}) {
  const elements = new Map(
    columns.map(({ key }) => [key, { style: {} as Record<string, string> } as unknown as HTMLTableColElement]),
  );
  const table = { style: {} as Record<string, string>, dataset: {} as Record<string, string> };
  layoutColumnWidths(columns, elements, widths, available, table as unknown as HTMLElement);
  const px = (key: string) => Number.parseInt(elements.get(key)!.style.width, 10);
  const visibility = (key: string) => elements.get(key)!.style.visibility;
  return { table, px, visibility };
}

test('a wide panel keeps every column and is not compact', () => {
  const { table, visibility, px } = layout(1000);
  for (const { key } of columns) assert.notEqual(visibility(key), 'collapse', key);
  assert.equal(table.dataset.compact, 'false');
  assert.equal(table.style.width, '1000px');
  assert.ok(px('base:message') >= 500);
});

test('a medium panel collapses Source but keeps Level', () => {
  const { table, visibility } = layout(450);
  assert.equal(visibility('base:source'), 'collapse');
  assert.notEqual(visibility('base:level'), 'collapse');
  assert.equal(table.dataset.compact, 'false');
});

test('a narrow panel also collapses Level, is compact, and leaves the message the most room', () => {
  const { table, visibility, px } = layout(200);
  assert.equal(visibility('base:source'), 'collapse');
  assert.equal(visibility('base:level'), 'collapse');
  assert.notEqual(visibility('base:time'), 'collapse');
  assert.equal(table.dataset.compact, 'true');
  assert.equal(px('base:time'), 72, 'the time shrinks to its compact minimum');
  assert.ok(px('base:message') >= 120, 'the message keeps its compact minimum');
  assert.ok(px('base:message') >= 100, 'the message gets at least half of the width');
});

test('a Level column the user sized is never collapsed', () => {
  const { table, visibility, px } = layout(200, { 'base:level': 90 });
  assert.notEqual(visibility('base:level'), 'collapse');
  assert.equal(table.dataset.compact, 'false');
  assert.equal(px('base:level'), 90);
});
