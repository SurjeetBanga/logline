import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { emptyDraft } from '../core/connection-form';

// The Logs panel in a real browser, to catch what the fake DOM of the unit tests cannot: layout. The page
// itself must never scroll; only the panels inside it do. An element that escapes its scrolling panel, such
// as a hidden input placed absolutely with no positioned ancestor, makes the page taller than the panel,
// and focusing it scrolls the tabs out of view. Every control must also be in reach: inside the panel, and
// not cut off by a box that hides what overflows it. Run with `npm run test:layout`.

const media = join(__dirname, '..', '..', 'media');
const origin = 'https://logline.test';
const nonce = 'layout';
// Filled as src/vscode/webview-html.ts fills it, Content Security Policy included.
const html = readFileSync(join(media, 'viewer.html'), 'utf8').replace(
  /\{\{([A-Z_]+)\}\}/g,
  (_, key: string) =>
    ({
      CSP_SOURCE: origin,
      NONCE: nonce,
      STYLE_URI: `${origin}/viewer.css`,
      SCRIPT_URI: `${origin}/viewer.js`,
    })[key] ?? '',
);

// A short panel docked under the editor, a narrow one in the side bar, and the narrowest side bar.
const SIZES = [
  { width: 2000, height: 330 },
  { width: 420, height: 300 },
  { width: 220, height: 600 },
];

const snapshot = {
  type: 'snapshot',
  generation: 1,
  newest: 20,
  total: 600,
  retained: 600,
  discarded: 0,
  bytes: 60000,
  maxBytes: 262144000,
  truncated: 0,
  columns: [],
  columnFields: [],
  fields: ['service'],
  // More than one page, so the pager's arrows are in use.
  page: 0,
  pages: 3,
  matched: 600,
  events: Array.from({ length: 20 }, (_, index) => ({
    id: 20 - index,
    message: `GET /api/items/${index} 200`,
    level: index % 5 ? 'info' : 'error',
    timestamp: '12:00:00',
    stream: 'stdout',
    serverId: 'api',
    sessionId: 'run',
    fields: { service: 'api' },
  })),
  servers: [{ id: 'api', label: 'API', status: 'running', activeSessions: 1, configured: true, canStop: true }],
  sessions: [{ id: 'run', serverId: 'api', server: 'API', command: 'npm start', status: 'running', startedAt: 1 }],
  connections: [{ id: 'app', label: 'App DB', type: 'postgres' }],
};

const traces = {
  type: 'traces',
  traces: [
    {
      traceId: 'f1',
      name: 'POST /checkout',
      service: 'api',
      services: ['api', 'payments'],
      startMs: 1000,
      durationMs: 120,
      spans: 3,
      logs: 4,
      errors: 1,
    },
  ],
};

let browser: Browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function open(size: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport: size });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route(`${origin}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === '') return route.fulfill({ contentType: 'text/html', body: html });
    return route.fulfill({ path: join(media, name) });
  });
  await page.addInitScript(() => {
    Object.assign(window, {
      acquireVsCodeApi: () => ({ getState: () => undefined, setState() {}, postMessage() {} }),
    });
  });
  await page.goto(`${origin}/`);
  await post(page, snapshot);
  assert.deepEqual(errors, []);
  return page;
}

async function post(page: Page, message: unknown): Promise<void> {
  await page.evaluate((data) => window.postMessage(data, '*'), message);
  // Messages are handled, and focus moved, on the frames after they arrive.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function openForm(page: Page, session: number, mode: 'add' | 'edit'): Promise<void> {
  const connectionId = mode === 'edit' ? 'app' : undefined;
  await post(page, { ...snapshot, openConnectionForm: { session, title: 'Add connection', connectionId } });
  const draft = { ...emptyDraft(), label: mode === 'edit' ? 'App DB' : '' };
  await post(page, {
    type: 'connectionForm',
    session,
    update: { type: 'init', mode, draft, secret: false, profiles: [], sites: [] },
  });
}

async function assertPageFits(page: Page, step: string): Promise<void> {
  const { scrollTop, scrollHeight, clientHeight, scrollWidth, clientWidth } = await page.evaluate(() => {
    const { scrollTop, scrollHeight, clientHeight, scrollWidth, clientWidth } = document.scrollingElement!;
    return { scrollTop, scrollHeight, clientHeight, scrollWidth, clientWidth };
  });
  assert.equal(scrollTop, 0, `${step}: the page scrolled, moving the tabs out of view`);
  assert.ok(scrollHeight <= clientHeight, `${step}: the page is ${scrollHeight}px tall in a ${clientHeight}px panel`);
  assert.ok(scrollWidth <= clientWidth, `${step}: the page is ${scrollWidth}px wide in a ${clientWidth}px panel`);
  const unreachable = await page.evaluate(() => {
    const out: string[] = [];
    const outside = (inner: DOMRect, outer: { left: number; top: number; right: number; bottom: number }) =>
      inner.left < outer.left - 1 ||
      inner.top < outer.top - 1 ||
      inner.right > outer.right + 1 ||
      inner.bottom > outer.bottom + 1;
    for (const control of document.querySelectorAll<HTMLElement>('button, input, select, [role=tab]')) {
      const rect = control.getBoundingClientRect();
      const style = getComputedStyle(control);
      if (!rect.width || !rect.height || style.visibility === 'hidden' || style.opacity === '0') continue;
      const name = control.id || control.getAttribute('aria-label') || control.textContent!.trim().slice(0, 30);
      // A control a scrolling box holds can be scrolled to; one cut off by a box that hides its overflow cannot.
      let scrolls = false;
      for (let box = control.parentElement; box && box !== document.body; box = box.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(box);
        if (/auto|scroll/.test(overflowX + overflowY)) {
          scrolls = true;
          break;
        }
        // A collapsed rail hides its rows' names and buttons on purpose; its tooltips name them.
        if (/hidden|clip/.test(overflowX + overflowY) && !box.classList.contains('collapsed')) {
          if (outside(rect, box.getBoundingClientRect())) out.push(`${name} is cut off by ${box.id || box.className}`);
        }
      }
      if (!scrolls && outside(rect, { left: 0, top: 0, right: innerWidth, bottom: innerHeight }))
        out.push(`${name} is outside the panel`);
    }
    return out;
  });
  assert.deepEqual(unreachable, [], `${step}: controls out of reach`);
}

for (const size of SIZES) {
  const name = `${size.width}×${size.height}`;

  test(`every tab fits a ${name} panel without scrolling the page`, async () => {
    const page = await open(size);
    try {
      await assertPageFits(page, 'Logs');
      for (const tab of await page.locator('#viewTabs [role=tab]:visible').all()) {
        const label = (await tab.textContent())?.trim() ?? '';
        await tab.click();
        await assertPageFits(page, label);
      }
    } finally {
      await page.close();
    }
  });

  test(`an opened rail fits a ${name} panel, sliding over a narrow view rather than squeezing it`, async () => {
    const page = await open(size);
    try {
      const view = () => page.locator('.workspace-main').evaluate((main) => main.getBoundingClientRect().width);
      const before = await view();
      await page.locator('#railToggle').click();
      await assertPageFits(page, 'Sources rail opened');
      await page.locator('#railToggle').click();
      // A wide panel makes room for the rail; a narrow one keeps the view and lays the rail over it.
      if (size.width < 520) {
        await page.locator('#railToggle').click();
        assert.ok((await view()) >= size.width - 40, 'the opened Sources rail squeezes the logs');
        await page.locator('#railToggle').click();
      }
      assert.equal(await view(), before);
      await page.locator('#viewTabs [role=tab]', { hasText: 'Traces' }).click();
      await post(page, traces);
      await page.locator('#tabRailToggle').click();
      await assertPageFits(page, 'Traces filters toggled');
      if (size.width < 520) assert.ok((await view()) >= size.width - 40, 'the opened filters squeeze the traces');
    } finally {
      await page.close();
    }
  });

  test(`the Connection form fits a ${name} panel, opened again and used, without scrolling the page`, async () => {
    const page = await open(size);
    try {
      await openForm(page, 1, 'add');
      await assertPageFits(page, 'Add connection');
      await post(page, { type: 'connectionForm', session: 1, update: { type: 'close' } });
      await openForm(page, 2, 'add');
      await assertPageFits(page, 'a second Add connection');
      await page.locator('#connectionView .segment', { hasText: 'Fields' }).click();
      await assertPageFits(page, 'Fields');
      await page.locator('#connectionView button', { hasText: 'Test connection' }).click();
      await assertPageFits(page, 'Test connection with fields missing');
      await post(page, { type: 'connectionForm', session: 2, update: { type: 'close' } });
      await openForm(page, 3, 'edit');
      await assertPageFits(page, 'Edit connection');
    } finally {
      await page.close();
    }
  });
}
