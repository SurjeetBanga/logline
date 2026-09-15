import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUIDE_RELEASES, guideStatus, latestGuideRelease } from './vscode/guide-content';

test('guide release status treats the latest curated release as unread until rendered', () => {
  assert.ok(latestGuideRelease.version);
  assert.ok(GUIDE_RELEASES.length > 0);
  assert.equal(guideStatus(undefined).unread, true);
  assert.equal(guideStatus('older-version').unread, true);
  assert.equal(guideStatus(latestGuideRelease.version).unread, false);
});
