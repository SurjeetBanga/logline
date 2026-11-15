import assert from 'node:assert/strict';
import { test } from 'node:test';

// buildEventFields only creates elements and sets their text, attributes, and classes, so a small
// document is enough to check what it builds.
class Node {
  children: Node[] = [];
  className = '';
  textContent = '';
  title = '';
  type = '';
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  append(...children: Node[]) {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  all(className: string): Node[] {
    return this.children.flatMap((child) => [
      ...(child.className.split(' ').includes(className) ? [child] : []),
      ...child.all(className),
    ]);
  }
}
(globalThis as { document?: unknown }).document = { createElement: () => new Node() };

import { buildEventFields } from './details';

const fields = (text: string | undefined) => buildEventFields(text) as unknown as Node | undefined;

test('a JSON object becomes a list of fields, each scalar with a Show only and an Exclude button', () => {
  const list = fields('{"user":"ana","count":3,"ok":false}')!;
  assert.equal(list.className, 'event-fields');
  assert.equal(list.attributes.role, 'list');
  const rows = list.all('event-field');
  assert.deepEqual(
    rows.map((row) => [row.all('event-field-name')[0].textContent, row.all('event-field-value')[0].textContent]),
    [
      ['user', 'ana'],
      ['count', '3'],
      ['ok', 'false'],
    ],
  );
  const [include, exclude] = rows[0].all('field-filter');
  assert.equal(include.textContent, '+');
  assert.equal(include.dataset.field, 'user');
  assert.equal(include.dataset.value, 'ana');
  assert.equal(include.dataset.exclude, undefined);
  assert.equal(include.attributes['aria-label'], 'Show only user: ana');
  assert.equal(exclude.dataset.exclude, 'true');
  assert.equal(exclude.attributes['aria-label'], 'Exclude user: ana');
  assert.equal(rows[1].all('field-filter')[0].dataset.value, '3');
  assert.equal(rows[2].all('field-filter')[0].dataset.value, 'false');
});

test('a nested, null, or empty value is listed without filter buttons', () => {
  const list = fields('{"nested":{"a":1},"list":[1,2],"none":null,"empty":""}')!;
  const rows = list.all('event-field');
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal(row.all('field-filter').length, 0, row.all('event-field-name')[0].textContent);
  assert.equal(rows[0].all('event-field-value')[0].textContent, '{"a":1}');
  assert.equal(rows[1].all('event-field-value')[0].textContent, '[1,2]');
  assert.equal(rows[2].all('event-field-value')[0].textContent, 'null');
});

test('text that is not a JSON object has no field list', () => {
  for (const text of [undefined, '', 'plain text', '{not json', '[1,2]', '"string"', '42', '{}', 'null'])
    assert.equal(fields(text), undefined, String(text));
});
