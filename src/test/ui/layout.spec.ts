import { aiCallDetail, aiCalls, analysis, snapshot, spanDetail, traceDetail, traces } from './data';
import { expect, test } from './panel';

// Layout at each panel size (the projects in playwright.config.ts): the page itself must never scroll; only
// the panels inside it do. An element that escapes its scrolling panel, such as a hidden input placed
// absolutely with no positioned ancestor, makes the page taller than the panel, and focusing it scrolls the
// tabs out of view. Every control must also be in reach: inside the panel, and not cut off by a box that
// hides what overflows it.

test('every tab fits the panel without scrolling the page', async ({ openPanel }) => {
  const panel = await openPanel();
  await panel.fits('Logs');
  for (const tab of await panel.page.locator('#viewTabs [role=tab]:visible').all()) {
    const label = (await tab.textContent())?.trim() ?? '';
    await tab.click();
    await panel.fits(label);
  }
});

test("the panel runs edge to edge, without VS Code's padding at its sides", async ({ openPanel }) => {
  const { page } = await openPanel();
  const edges = await page.evaluate(() => {
    const bar = document.querySelector('.view-bar')!.getBoundingClientRect();
    const rail = document.getElementById('sourceRail')!.getBoundingClientRect();
    return { bar: [bar.left, bar.right], rail: rail.left, width: window.innerWidth };
  });
  expect(edges.bar, 'the top row spans the panel').toEqual([0, edges.width]);
  expect(edges.rail, 'the Sources rail starts at the left edge').toBe(0);
});

test("the page arrows show at their full size, not squeezed by the status bar's padding", async ({ openPanel }) => {
  const { page } = await openPanel();
  for (const id of ['newer', 'older']) {
    const icon = await page.locator(`#${id} svg`).boundingBox();
    expect(icon?.width, `the ${id} page arrow`).toBe(14);
  }
});

test('the Update button fits beside the actions', async ({ openPanel }) => {
  const panel = await openPanel();
  const { page } = panel;
  await page.evaluate(() => {
    const button = document.getElementById('updateButton') as HTMLButtonElement;
    button.hidden = false;
    button.textContent = 'Update';
  });
  await panel.fits('Update button');
  const box = await page.locator('#updateButton').boundingBox();
  const width = page.viewportSize()!.width;
  // The action bar's buttons are transparent: this one must stand out as the editor's main button.
  await expect(page.locator('#updateButton'), 'the button keeps its fill').toHaveCSS(
    'background-color',
    'rgb(14, 99, 156)',
  );
  expect(box && box.x >= 0 && box.x + box.width <= width, `the button is in reach: ${JSON.stringify(box)}`).toBe(true);
});

test('an opened rail fits, sliding over a narrow view rather than squeezing it', async ({ openPanel }) => {
  const panel = await openPanel();
  const { page } = panel;
  const width = page.viewportSize()!.width;
  const view = () => page.locator('.workspace-main').evaluate((main) => main.getBoundingClientRect().width);
  const before = await view();
  await page.locator('#railToggle').click();
  await panel.fits('Sources rail opened');
  await page.locator('#railToggle').click();
  // A wide panel makes room for the rail; a narrow one keeps the view and lays the rail over it.
  if (width < 520) {
    await page.locator('#railToggle').click();
    expect(await view(), 'the opened Sources rail squeezes the logs').toBeGreaterThanOrEqual(width - 40);
    await page.locator('#railToggle').click();
  }
  expect(await view()).toBe(before);
  await page.locator('#viewTabs [role=tab]', { hasText: 'Traces' }).click();
  await panel.post(traces);
  await page.locator('#tabRailToggle').click();
  await panel.fits('Traces filters toggled');
  if (width < 520) expect(await view(), 'the opened filters squeeze the traces').toBeGreaterThanOrEqual(width - 40);
});

test('the Connection form fits, opened again and used, without scrolling the page', async ({ openPanel }) => {
  const panel = await openPanel();
  const { page } = panel;
  await panel.openForm(1, 'add');
  await panel.fits('Add connection');
  await panel.post({ type: 'connectionForm', session: 1, update: { type: 'close' } });
  await panel.openForm(2, 'add');
  await panel.fits('a second Add connection');
  await page.locator('#connectionView footer button', { hasText: 'Next' }).click();
  await panel.fits('the Connect step');
  await page.locator('#connectionView .segment', { hasText: 'Fields' }).click();
  await panel.fits('Fields');
  await page.locator('#connectionView footer button', { hasText: 'Test connection' }).click();
  await panel.fits('Test connection with fields missing');
  await page.locator('#connectionView .wizard-step', { hasText: 'Type' }).click();
  await panel.fits('back at the Type step');
  await panel.post({ type: 'connectionForm', session: 2, update: { type: 'close' } });
  await panel.openForm(3, 'edit');
  await panel.fits('Edit connection');
});

test('what a Datadog search found is read in full', async ({ openPanel }) => {
  const datadog = {
    id: 'dd',
    sourceId: 'remote:dd',
    label: 'Datadog prod',
    type: 'datadog',
    mapped: true,
    sql: false,
    watching: [],
    agents: false,
    tailing: false,
    last: { sessionId: 's', kind: 'fetch', running: false, fetched: 1000, kept: 1000, total: 57253, elapsedMs: 1840 },
  };
  const panel = await openPanel({
    saved: { server: 'remote:dd', query: 'service:recon-app' },
    first: {
      ...snapshot,
      servers: [{ id: 'remote:dd', label: 'Datadog prod', status: 'stopped', activeSessions: 0, configured: true }],
      connections: [datadog],
    },
  });
  const result = panel.page.locator('#connectionResult');
  await expect(result).toHaveText(/^Fetched 1,000 of 57,253 logs/);
  const { shown, needs } = await result.evaluate((element) => ({
    shown: element.clientWidth,
    needs: element.scrollWidth,
  }));
  expect(needs, `the result needs ${needs}px and shows ${shown}px`).toBeLessThanOrEqual(shown);
  await panel.fits('Datadog connection selected');

  // A full page of fetched rows makes the table far taller than the panel. The table gives up that
  // height, not the connection's controls: they keep at least the height of the Run button.
  await panel.post({
    ...snapshot,
    servers: [{ id: 'remote:dd', label: 'Datadog prod', status: 'stopped', activeSessions: 0, configured: true }],
    connections: [datadog],
    newest: 1000,
    matched: 1000,
    events: Array.from({ length: 1000 }, (_, index) => ({ ...snapshot.events[0], id: 1000 - index })),
  });
  const bar = await panel.page.locator('#connectionBar').boundingBox();
  const run = await panel.page.locator('#connectionRun').boundingBox();
  expect(bar && run && bar.height >= run.height, `the bar is ${bar?.height}px tall`).toBe(true);
  await panel.fits('Datadog connection with many rows');
});

test('a log event open in the inspector fits', async ({ openPanel }) => {
  const panel = await openPanel();
  const { page } = panel;
  await page.locator('#logs tr.event-row .message-button').first().click();
  await panel.post({
    type: 'details',
    id: 20,
    target: 'main',
    text: '{"level":"error","msg":"x","service":"api"}',
    exceptions: [],
  });
  await expect(page.locator('#inspector'), 'the inspector opens for an event').toBeVisible();
  await panel.fits('an event open in the inspector');
  await page.locator('#inspectorClose').click();
  await panel.fits('the event closed again');
});

test('an event in an inspector widened by its edge fits', async ({ openPanel }) => {
  // A width saved in a wide panel, then the same state in this one.
  const panel = await openPanel({ saved: { inspectorWidth: 900 } });
  const { page } = panel;
  const size = page.viewportSize()!;
  await page.locator('#logs tr.event-row .message-button').first().click();
  await panel.post({ type: 'details', id: 20, target: 'main', text: '{"level":"error"}', exceptions: [] });
  await panel.fits('an inspector with a saved width');
  const handle = page.locator('#inspectorResizer');
  if (await handle.isVisible()) {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(-size.width, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await panel.fits('the inspector dragged as wide as it goes');
  }
  await page.setViewportSize({ width: Math.max(220, Math.round(size.width * 0.6)), height: size.height });
  await panel.post({ type: 'noop' });
  await panel.fits('the panel narrowed under a wide inspector');
});

test('the status panel fits', async ({ openPanel }) => {
  const panel = await openPanel({ first: { ...snapshot, doctor: { revision: 1, total: 2, findings: [] } } });
  const { page } = panel;
  await page.locator('#statusIcon').click();
  await expect(page.locator('#statusPanel'), 'the status panel opens').toBeVisible();
  await panel.fits('the status panel');
  await page.keyboard.press('Escape');
  await expect(page.locator('#statusPanel')).toBeHidden();
});

test('the Add logs menu fits', async ({ openPanel }) => {
  const panel = await openPanel();
  const { page } = panel;
  if (!(await page.locator('#railAdd').isVisible())) await page.locator('#railToggle').click();
  await page.locator('#railAdd').click();
  await expect(page.locator('#railAddMenu'), 'the Add logs menu opens').toBeVisible();
  await panel.fits('the Add logs menu');
});

test('the Issues view fits', async ({ openPanel }) => {
  const findings = [
    { siteId: 's1', code: 'secret', severity: 'error', message: 'Logged a bearer token', file: 'src/a.ts', line: 3 },
    { code: 'unattributed', severity: 'warning', message: 'Output no statement accounts for', source: 'api' },
  ];
  const panel = await openPanel({ first: { ...snapshot, doctor: { revision: 1, total: 2, findings } } });
  const { page } = panel;
  await page.locator('#statusIcon').click();
  await page.locator('#statusIssues').click();
  await expect(page.locator('#doctorView'), 'the Issues view opens').toBeVisible();
  await panel.fits('the Issues view');
});

test('the About dialog fits', async ({ openPanel }) => {
  const panel = await openPanel();
  const { page } = panel;
  const info = { version: '1.20.0', editor: 'Visual Studio Code 1.99.0', system: 'Darwin arm64 25.0.0' };
  await panel.post({ ...snapshot, openAbout: info });
  const dialog = page.locator('#aboutDialog');
  await expect(dialog, 'the About dialog opens').toBeVisible();
  await panel.fits('the About dialog');
  const box = (await dialog.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x >= 0 && box.x + box.width <= width, `the dialog fits across: ${JSON.stringify(box)}`).toBe(true);
  const clipped = await dialog.evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(clipped, 'nothing in the dialog is wider than the dialog').toBe(false);
});

test('a trace open in the inspector fits', async ({ openPanel }) => {
  const panel = await openPanel();
  const { page } = panel;
  await page.locator('#viewTabs [role=tab]', { hasText: 'Traces' }).click();
  await panel.post(traces);
  await page.locator('#tracesRows tr').first().click();
  await panel.post(traceDetail);
  await expect(page.locator('#inspector'), 'the inspector opens for a trace').toBeVisible();
  await expect(page.locator('#traceView')).toBeVisible();
  await panel.fits('a trace open in the inspector');
  await page.locator('#inspectorClose').click();
  await panel.fits('the trace closed again');
});

test('a populated Analyze view fits', async ({ openPanel }) => {
  const panel = await openPanel();
  const { page } = panel;
  await page.locator('#viewTabs [role=tab]', { hasText: 'Analyze' }).click();
  await panel.post(analysis);
  await expect(page.locator('#analysisContent .group-row').first(), 'the groups are drawn').toBeVisible();
  await panel.fits('a populated Analyze view');
  // The page never grows; the view scrolls inside itself, down to the last group.
  await page.locator('#analysisContent .group-row').last().scrollIntoViewIfNeeded();
  await panel.fits('Analyze scrolled to its end');
});

test('a trace with a span’s details open fits', async ({ openPanel }) => {
  const panel = await openPanel();
  const { page } = panel;
  await page.locator('#viewTabs [role=tab]', { hasText: 'Traces' }).click();
  await panel.post(traces);
  await page.locator('#tracesRows tr').first().click();
  await panel.post(traceDetail);
  // The waterfall narrows with the inspector: it never scrolls sideways, with a span open or not.
  const overflow = () =>
    page.evaluate(() => {
      const box = document.getElementById('inspectorBody')!;
      return box.scrollWidth - box.clientWidth;
    });
  expect(await overflow(), 'the waterfall fits across the inspector').toBeLessThanOrEqual(1);
  await page.locator('#traceRows tr.trace-span[data-span-id="b"]').click();
  await panel.post(spanDetail);
  const details = page.locator('#traceRows tr.trace-detail');
  await expect(details, 'the span’s details open under its row').toBeVisible();
  await expect(details.locator('.event-field')).toHaveCount(16);
  await panel.fits('a trace with a span open');
  expect(
    await overflow(),
    'a long value wraps inside the details instead of widening the inspector',
  ).toBeLessThanOrEqual(1);
  await page.locator('#traceRows tr.trace-span[data-span-id="b"]').click();
  await expect(details).toHaveCount(0);
  await panel.fits('the span closed again');
});

test('an AI call open in the inspector fits', async ({ openPanel }) => {
  const panel = await openPanel({ first: { ...snapshot, aiCalls: { calls: 2, revision: 1 } } });
  const { page } = panel;
  await page.locator('#viewTabs [role=tab]', { hasText: 'AI calls' }).click();
  await panel.post(aiCalls);
  await panel.fits('the AI calls list with its rail');
  await page.locator('#aiCallRows tr').first().click();
  await panel.post(aiCallDetail);
  await expect(page.locator('#inspector'), 'the inspector opens for a call').toBeVisible();
  await expect(page.locator('#aiCallView')).toBeVisible();
  await panel.fits('an AI call open in the inspector');
  await page.locator('#inspectorClose').click();
  await panel.fits('the call closed again');
});
