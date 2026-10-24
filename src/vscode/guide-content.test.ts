import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUIDE_RELEASES, guideStatus, latestGuideRelease } from './guide-content';

test('guide release status treats the latest curated release as unread until rendered', () => {
  assert.ok(latestGuideRelease.version);
  assert.ok(GUIDE_RELEASES.length > 0);
  assert.equal(guideStatus(undefined).unread, true);
  assert.equal(guideStatus('older-version').unread, true);
  assert.equal(guideStatus(latestGuideRelease.version).unread, false);
});

test('every guide card points at something that exists, so the guide cannot go stale', () => {
  const { GUIDE_CARDS, GUIDE_SECTIONS } = require('./guide-content') as typeof import('./guide-content');
  const { readFileSync, readdirSync } = require('node:fs') as typeof import('node:fs');
  const html = readFileSync('media/viewer.html', 'utf8');
  // Controls the webview creates, such as the rail's add button, are named where they are made.
  const scripts = readdirSync('src/webview', { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => readFileSync(`src/webview/${name}`, 'utf8'))
    .join('\n');
  const controlExists = (id: string) => html.includes(`id="${id}"`) || scripts.includes(`.id = '${id}'`);
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    contributes: { commands: { command: string }[]; configuration: { properties: Record<string, unknown> }[] };
  };
  const commands = new Set(manifest.contributes.commands.map((command) => command.command));
  const settings = new Set(manifest.contributes.configuration.flatMap((category) => Object.keys(category.properties)));
  // GitHub's heading anchors: lower case, punctuation dropped, spaces as hyphens.
  const anchors = new Set(
    readFileSync('docs/usage.md', 'utf8')
      .split('\n')
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) =>
        line
          .replace(/^#+ /, '')
          .toLowerCase()
          .replace(/[^\w\- ]/g, '')
          .replace(/ /g, '-'),
      ),
  );
  const sections = new Set(GUIDE_SECTIONS.map((section) => section.id));
  for (const card of GUIDE_CARDS) {
    assert.ok(sections.has(card.section), `${card.title}: unknown section ${card.section}`);
    assert.ok(card.where.length && card.text, `${card.title} says where it is and what it does`);
    if (card.target)
      assert.ok(controlExists(card.target), `${card.title}: no control ${card.target} in the Logs panel`);
    if (card.fallback) assert.ok(controlExists(card.fallback), `${card.title}: no control ${card.fallback}`);
    if (card.command) assert.ok(commands.has(card.command), `${card.title}: no command ${card.command}`);
    if (card.setting) assert.ok(settings.has(card.setting), `${card.title}: no setting ${card.setting}`);
    if (card.docs) assert.ok(anchors.has(card.docs), `${card.title}: no heading #${card.docs} in docs/usage.md`);
  }
  for (const section of GUIDE_SECTIONS)
    assert.ok(
      GUIDE_CARDS.some((card) => card.section === section.id),
      `${section.title} has cards`,
    );
});
