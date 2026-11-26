import { snapshot, spanDetail, traceDetail, traces } from './data';
import { expect, test, type Panel } from './panel';

// What the Logs panel does with real pointer, keyboard, and focus, which the unit tests' fake DOM only
// stands in for. Each test sets the panel size it needs.

const row = (panel: Panel, id: number) => panel.page.locator(`#logs tr.event-row[data-id="${id}"]`);

/** Opens event `id` by clicking its message, as the host answers with its details. */
async function openEvent(panel: Panel, id: number): Promise<void> {
  await row(panel, id).locator('.message-button').click();
  await panel.post({ type: 'details', id, target: 'main', text: '{"level":"info","msg":"x"}', exceptions: [] });
  await expect(panel.page.locator('#inspector')).toBeVisible();
}

test.describe('the inspector', () => {
  test('Up and Down on a message move between events, and Escape closes it and returns focus to the row', async ({
    openPanel,
  }) => {
    const panel = await openPanel();
    const { page } = panel;
    // The rows in the order they are shown, top to bottom.
    const ids = (
      await page
        .locator('#logs tr.event-row')
        .evaluateAll((rows) => rows.map((r) => Number((r as HTMLElement).dataset.id)))
    ).slice(0, 3);
    const [above, middle, below] = ids;
    await openEvent(panel, middle);
    await expect(row(panel, middle)).toHaveClass(/\bselected\b/);

    await page.keyboard.press('ArrowDown');
    await expect(row(panel, below), 'Down opens the event below').toHaveClass(/\bselected\b/);
    await expect(row(panel, below).locator('.message-button')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(row(panel, above), 'Up opens the event above').toHaveClass(/\bselected\b/);
    await expect(row(panel, middle)).not.toHaveClass(/\bselected\b/);

    await page.keyboard.press('Escape');
    await expect(page.locator('#inspector')).toBeHidden();
    await expect(row(panel, above)).not.toHaveClass(/\bselected\b/);
    await expect(row(panel, above).locator('.message-button'), 'focus goes back to the row').toBeFocused();
  });

  test('sits beside the list in a wide panel and below it under 900 pixels', async ({ openPanel }) => {
    const panel = await openPanel();
    const { page } = panel;
    await openEvent(panel, 20);
    const boxes = async () => ({
      table: (await page.locator('#eventsTable').boundingBox())!,
      inspector: (await page.locator('#inspector').boundingBox())!,
    });
    let { table, inspector } = await boxes();
    expect(inspector.x, 'beside the list').toBeGreaterThanOrEqual(table.x + table.width - 1);
    await expect(page.locator('#inspectorResizer')).toBeVisible();

    await page.setViewportSize({ width: 899, height: 600 });
    ({ table, inspector } = await boxes());
    expect(inspector.y, 'below the list').toBeGreaterThanOrEqual(table.y);
    expect(inspector.width, 'as wide as the list').toBeGreaterThan(table.width - 40);
    await expect(page.locator('#inspectorResizer'), 'no edge to drag below the list').toBeHidden();
  });

  test('its left edge widens it when dragged, and a double click puts it back', async ({ openPanel }) => {
    const panel = await openPanel();
    const { page } = panel;
    await openEvent(panel, 20);
    const inspector = page.locator('#inspector');
    const initial = (await inspector.boundingBox())!.width;
    const handle = (await page.locator('#inspectorResizer').boundingBox())!;
    const y = handle.y + handle.height / 2;
    await page.mouse.move(handle.x + handle.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(handle.x - 200, y, { steps: 5 });
    await page.mouse.up();
    const widened = (await inspector.boundingBox())!.width;
    expect(widened, 'dragging the edge left widens it').toBeGreaterThan(initial + 150);

    await page.locator('#inspectorResizer').dblclick();
    await expect.poll(async () => Math.round((await inspector.boundingBox())!.width)).toBe(Math.round(initial));
  });
});

test.describe('a row', () => {
  test('opens from a click anywhere in it, not only its message', async ({ openPanel }) => {
    const panel = await openPanel();
    await row(panel, 18).locator('td[data-column="base:time"]').click();
    await expect(panel.page.locator('#inspector')).toBeVisible();
    await expect(row(panel, 18)).toHaveClass(/\bselected\b/);
  });

  test('does not open when text in it is selected with a drag', async ({ openPanel }) => {
    const panel = await openPanel();
    const { page } = panel;
    const cell = (await row(panel, 18).locator('td[data-column="base:time"]').boundingBox())!;
    const y = cell.y + cell.height / 2;
    await page.mouse.move(cell.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(cell.x + cell.width - 4, y, { steps: 5 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
    await expect(page.locator('#inspector')).toBeHidden();
    await expect(row(panel, 18)).not.toHaveClass(/\bselected\b/);
  });
});

test.describe('columns in a narrowing panel', () => {
  test('Source gives way first, then field columns, then Level, and Message keeps its room', async ({ openPanel }) => {
    const panel = await openPanel({ first: { ...snapshot, columns: ['service'] } });
    const { page } = panel;
    const collapsed = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLTableColElement>('#eventColumns col')]
          .filter((col) => col.style.visibility === 'collapse')
          .map((col) => col.dataset.column!),
      );
    expect(await collapsed(), 'nothing gives way in a wide panel').toEqual([]);

    // The first width, from wide to narrow, at which each column gives way.
    const gaveWay: Record<string, number> = {};
    for (let width = 1400; width >= 220; width -= 20) {
      await page.setViewportSize({ width, height: 600 });
      await panel.post({ type: 'noop' });
      for (const key of await collapsed()) gaveWay[key] ??= width;
    }
    expect(Object.keys(gaveWay).sort()).toEqual(['base:level', 'base:source', 'field:service']);
    expect(gaveWay['base:source'], 'Source before the field').toBeGreaterThanOrEqual(gaveWay['field:service']);
    expect(gaveWay['field:service'], 'the field before Level').toBeGreaterThanOrEqual(gaveWay['base:level']);

    const { message, table } = await page.evaluate(() => ({
      message: document.querySelector('#logs td[data-column="base:message"]')?.getBoundingClientRect().width ?? 0,
      table: document.getElementById('eventsTable')!.getBoundingClientRect().width,
    }));
    expect(message, `at 220px the Message column is ${message}px of a ${table}px table`).toBeGreaterThanOrEqual(
      table / 2,
    );
  });
});

test.describe('the Connection form', () => {
  test('opens one step at a time, and a step opens only once the ones before it are done', async ({ openPanel }) => {
    const panel = await openPanel();
    const { page } = panel;
    await panel.openForm(1, 'add');
    const form = page.locator('#connectionView');
    // Type, Connect, Logs (Log table for a database), and Name.
    const steps = form.locator('.wizard-step');
    const [type, connect, logs, name] = [0, 1, 2, 3].map((index) => steps.nth(index));
    const footer = form.locator('footer');

    await expect(footer.getByRole('button', { name: 'Back' })).toBeHidden();
    await expect(steps).toHaveCount(4);
    await expect(type).toHaveClass(/\bcurrent\b/);
    await expect(connect).toBeEnabled();
    await expect(logs, 'Logs waits for a tested connection').toBeDisabled();
    await expect(name, 'Name waits for a tested connection').toBeDisabled();

    await footer.getByRole('button', { name: 'Next' }).click();
    await expect(connect).toHaveClass(/\bcurrent\b/);
    await expect(footer.getByRole('button', { name: 'Test connection' }), 'on Connect, Next is the test').toBeVisible();
    await expect(footer.locator('.footer-note')).toHaveText('Test the connection to continue.');

    await footer.getByRole('button', { name: 'Back' }).click();
    await expect(type).toHaveClass(/\bcurrent\b/);
    await expect(logs).toBeDisabled();
  });
});

test.describe('menus', () => {
  test('Add logs offers every way in, and leaves out Receive OpenTelemetry while the receiver runs', async ({
    openPanel,
  }) => {
    const items = [
      'Run a command…',
      'Follow a log file…',
      'Open a browser…',
      'Import logs…',
      'Add a connection…',
      'Receive OpenTelemetry',
    ];
    const panel = await openPanel();
    const { page } = panel;
    const menu = page.locator('#railAddMenu');
    await page.locator('#railAdd').click();
    await expect(menu.getByRole('menuitem')).toHaveText(items);

    await page.keyboard.press('Escape');
    await panel.post({
      ...snapshot,
      otlp: { running: true, endpoint: 'http://localhost:4318' },
      status: 'OpenTelemetry receiver on localhost:4318',
    });
    await page.locator('#railAdd').click();
    await expect(menu.getByRole('menuitem').filter({ visible: true })).toHaveText(items.slice(0, -1));
  });

  test('More actions offers Copy filtered results only while a filter is active', async ({ openPanel }) => {
    const panel = await openPanel();
    const { page } = panel;
    const menu = page.locator('#actionsMenu');
    await page.locator('#moreActions').click();
    await expect(menu).toBeVisible();
    await expect(menu.locator('#copyResults')).toBeHidden();
    await expect(menu.getByRole('menuitem').filter({ visible: true }).last(), 'Clear logs is last').toHaveId('clear');
    await page.keyboard.press('Escape');

    await page.locator('#search').fill('level:error');
    await page.locator('#search').press('Enter');
    await page.locator('#moreActions').click();
    await expect(menu.locator('#copyResults')).toBeVisible();
  });
});

test.describe('the trace waterfall', () => {
  async function openWaterfall(panel: Panel) {
    await panel.page.locator('#viewTabs [role=tab]', { hasText: 'Traces' }).click();
    await panel.post(traces);
    await panel.page.locator('#tracesRows tr').first().click();
    await panel.post(traceDetail);
    await expect(panel.page.locator('#traceRows tr.trace-span')).toHaveCount(6);
  }
  const spanRow = (panel: Panel, id: string) => panel.page.locator(`#traceRows tr.trace-span[data-span-id="${id}"]`);

  test('span rows take the arrow keys, and Enter opens a span’s details and closes them with focus kept on the row', async ({
    openPanel,
  }) => {
    const panel = await openPanel();
    const { page } = panel;
    await openWaterfall(panel);
    await spanRow(panel, 'a').focus();
    await expect(spanRow(panel, 'a')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(spanRow(panel, 'b'), 'Down moves to the next span').toBeFocused();
    await expect(spanRow(panel, 'b')).toHaveAttribute('tabindex', '0');
    await expect(spanRow(panel, 'a')).toHaveAttribute('tabindex', '-1');
    await page.keyboard.press('End');
    await expect(spanRow(panel, 'f')).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await expect(spanRow(panel, 'b')).toBeFocused();

    await page.keyboard.press('Enter');
    await panel.post(spanDetail);
    await expect(spanRow(panel, 'b')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#traceRows tr.trace-detail'), 'the details open under the row').toBeVisible();
    await expect(spanRow(panel, 'b'), 'focus stays on the row').toBeFocused();
    expect((await panel.posted()).filter((message) => message.type === 'span')).toEqual([
      { type: 'span', traceId: 'f1', spanId: 'b' },
    ]);

    await page.keyboard.press('Enter');
    await expect(page.locator('#traceRows tr.trace-detail')).toHaveCount(0);
    await expect(spanRow(panel, 'b')).toHaveAttribute('aria-expanded', 'false');
    await expect(spanRow(panel, 'b'), 'closing keeps focus on the row').toBeFocused();
  });
});

test.describe('the Service list', () => {
  test('narrows as you type, takes the arrow keys and Enter or a click, and is not cut off', async ({ openPanel }) => {
    const connection = { id: 'dd', sourceId: 'conn:dd', label: 'prod', type: 'datadog', mapped: true, sql: false };
    const panel = await openPanel({
      saved: { server: 'conn:dd', query: 'level:error' },
      first: {
        ...snapshot,
        events: [],
        servers: [{ id: 'conn:dd', label: 'Datadog · prod', status: 'idle', activeSessions: 0 }],
        sessions: [],
        connections: [{ ...connection, agents: false, tailing: false, watching: [] }],
      },
    });
    const { page } = panel;
    await panel.post({
      type: 'connectionServices',
      connectionId: 'dd',
      range: '1h',
      services: [
        { name: 'checkout', count: 1200 },
        { name: 'payments', count: 40 },
        { name: 'payments api', count: 4 },
      ],
    });
    const box = page.locator('#connectionService');
    const list = page.locator('#connectionServices');
    const options = list.getByRole('option');

    await box.click();
    await expect(list).toBeVisible();
    await expect(options).toHaveText(['checkout1,200 logs', 'payments40 logs', 'payments api4 logs']);
    await panel.fits('the Service list open');
    // Nothing covers the last service: a click there lands on it.
    const last = await options.last().boundingBox();
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="option"]')?.textContent,
      { x: last!.x + last!.width / 2, y: last!.y + last!.height / 2 },
    );
    expect(hit).toBe('payments api4 logs');

    await box.pressSequentially('pay');
    await expect(options).toHaveCount(2);
    await box.press('ArrowDown');
    await box.press('ArrowDown');
    await expect(box).toHaveAttribute('aria-activedescendant', 'connectionService-1');
    await box.press('Enter');
    await expect(list).toBeHidden();
    await expect(box).toHaveValue('payments api');
    await expect(page.locator('#search')).toHaveValue('level:error service:"payments api"');

    await box.press('Escape');
    await box.click();
    await options.filter({ hasText: 'checkout' }).click();
    await expect(box).toBeFocused();
    await expect(box).toHaveValue('checkout');
    await expect(page.locator('#search')).toHaveValue('level:error service:checkout');

    // A filter typed but not entered goes with the service; one that is not valid stays in the box.
    const search = page.locator('#search');
    await search.click();
    await search.fill('env:prod');
    await box.click();
    await options.filter({ hasText: 'payments api' }).click();
    await expect(page.locator('#searchChips')).toContainText('env:prod');
    await search.click();
    await search.fill('"unclosed');
    await box.click();
    await options.filter({ hasText: 'checkout' }).click();
    await expect(box).toHaveValue('checkout');
    await expect(search).toHaveValue('"unclosed');
    await expect(page.locator('#searchChips')).toContainText('checkout');
  });
});

test.describe('the search suggestions', () => {
  test('take the arrow keys and Enter or a click, and are not cut off', async ({ openPanel }) => {
    const panel = await openPanel();
    const { page } = panel;
    const box = page.locator('#search');
    const list = page.locator('#fieldSuggestions');
    const options = list.getByRole('option');
    /** Answers the panel's request for suggestions for what is typed. */
    const answer = async (fields: string[], values: { value: string; count: number }[] = []) => {
      await expect
        .poll(async () => (await panel.posted()).filter((message) => message.type === 'autocomplete').at(-1)?.input)
        .toBe(await box.inputValue());
      const asked = (await panel.posted()).filter((message) => message.type === 'autocomplete').at(-1)!;
      await panel.post({ type: 'autocomplete', input: asked.input, serverId: asked.serverId, fields, values });
    };

    await box.click();
    await box.pressSequentially('app');
    await answer(['appname', 'status']);
    await expect(options).toHaveText(['appname:', 'status:']);
    await panel.fits('the search suggestions open');
    const first = await options.first().boundingBox();
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="option"]')?.textContent,
      { x: first!.x + first!.width / 2, y: first!.y + first!.height / 2 },
    );
    expect(hit).toBe('appname:');

    // A field name picked with the keys stays to be finished, and its values are suggested.
    await box.press('ArrowDown');
    await expect(box).toHaveAttribute('aria-activedescendant', 'search-0');
    await box.press('Enter');
    await expect(box).toHaveValue('appname:');
    await expect(list).toBeHidden();
    await answer(['appname'], [{ value: 'prod', count: 3 }]);
    // A whole term picked with a click is applied, and focus stays in the box.
    await options.filter({ hasText: 'prod' }).click();
    await expect(box).toBeFocused();
    await expect(box).toHaveValue('');
    await expect(page.locator('#searchChips')).toContainText('appname');
    await expect(list).toBeHidden();
  });

  test('keep the highlighted one when they are refreshed, and stay closed when the answer comes after the box is left', async ({
    openPanel,
  }) => {
    const panel = await openPanel();
    const { page } = panel;
    const box = page.locator('#search');
    const list = page.locator('#fieldSuggestions');
    const reply = { type: 'autocomplete', input: 'app', values: [] };

    await box.click();
    await box.pressSequentially('app');
    await panel.post({ ...reply, fields: ['appname', 'status'] });
    await box.press('ArrowDown');
    await box.press('ArrowDown');
    await expect(box).toHaveAttribute('aria-activedescendant', 'search-1');
    await panel.post({ ...reply, fields: ['apptype', 'appname', 'status'] });
    await expect(box, 'the same suggestion stays highlighted').toHaveAttribute('aria-activedescendant', 'search-2');

    await page.locator('#logs').click();
    await expect(list).toBeHidden();
    await panel.post({ ...reply, fields: ['appname'] });
    await expect(list).toBeHidden();
  });
});

test.describe('the metric name suggestions', () => {
  test('narrow as you type, take the arrow keys and Enter, and are not cut off', async ({ openPanel }) => {
    const connection = { id: 'dd', sourceId: 'conn:dd', label: 'prod', type: 'datadog', mapped: true, sql: false };
    const panel = await openPanel({
      first: { ...snapshot, connections: [{ ...connection, agents: false, tailing: false, watching: [] }] },
    });
    const { page } = panel;
    await page.locator('#metrics').click();
    const box = page.locator('#metricInput');
    const list = page.locator('#metricSuggestions');
    const options = list.getByRole('option');

    await box.click();
    await box.pressSequentially('avg:trace');
    await expect
      .poll(async () => (await panel.posted()).find((message) => message.type === 'metricNames'))
      .toEqual({ type: 'metricNames', connectionId: 'dd', search: 'trace' });
    await panel.post({
      type: 'metricNames',
      connectionId: 'dd',
      search: 'trace',
      names: ['trace.http.request.duration', 'trace.http.request.hits'],
    });
    await expect(options).toHaveText(['trace.http.request.duration', 'trace.http.request.hits']);
    await panel.fits('the metric names open');
    const last = await options.last().boundingBox();
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="option"]')?.textContent,
      { x: last!.x + last!.width / 2, y: last!.y + last!.height / 2 },
    );
    expect(hit).toBe('trace.http.request.hits');

    await box.pressSequentially('.http.request.h');
    await expect(options).toHaveText(['trace.http.request.hits']);
    await box.press('ArrowDown');
    await box.press('Enter');
    await expect(box).toHaveValue('avg:trace.http.request.hits');
    await expect(list).toBeHidden();
    expect((await panel.posted()).some((message) => message.type === 'metricQuery')).toBe(false);

    // Enter with none highlighted runs the query and closes the list.
    await box.fill('avg:trace');
    await expect(options).toHaveCount(2);
    await box.press('Enter');
    await expect(list).toBeHidden();
  });
});
