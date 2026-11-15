import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';
import { emptyDraft } from '../../core/connection-form';
import { snapshot } from './data';

// The Logs panel in a real browser, to catch what the fake DOM of the unit tests cannot: layout, focus, and
// real pointer and keyboard input. The page is media/viewer.html filled as src/vscode/webview-html.ts fills
// it, Content Security Policy included, with a stand-in for the VS Code webview API that records what the
// panel posts to the extension host.

const media = join(__dirname, '..', '..', '..', 'media');
const origin = 'https://logline.test';
// VS Code puts its own default styles ahead of the page's, the body's side padding among them.
const VSCODE_DEFAULTS = 'body { margin: 0; padding: 0 20px; }';
const html = readFileSync(join(media, 'viewer.html'), 'utf8')
  .replace('<head>', `<head><link rel="stylesheet" href="${origin}/vscode-defaults.css" />`)
  .replace(
    /\{\{([A-Z_]+)\}\}/g,
    (_, key: string) =>
      ({
        CSP_SOURCE: origin,
        NONCE: 'layout',
        STYLE_URI: `${origin}/viewer.css`,
        SCRIPT_URI: `${origin}/viewer.js`,
      })[key] ?? '',
  );

export interface Panel {
  page: Page;
  /** Sends the panel a message from the host, and waits the frames it takes to handle it. */
  post(message: unknown): Promise<void>;
  /** What the panel has posted to the host so far. */
  posted(): Promise<{ type: string; [key: string]: unknown }[]>;
  /** Fails when the page itself scrolls or any control is out of reach. */
  fits(step: string): Promise<void>;
  /** Opens the Connection form, to add a connection or edit the `app` one. */
  openForm(session: number, mode: 'add' | 'edit'): Promise<void>;
}

export interface OpenOptions {
  /** The panel's saved state, such as the selected source or the inspector's width. */
  saved?: Record<string, unknown>;
  /** The first message the host sends, a snapshot by default. */
  first?: unknown;
}

export const test = base.extend<{ openPanel: (options?: OpenOptions) => Promise<Panel> }>({
  openPanel: async ({ page }, use) => {
    // Any script error or console error fails the test, after whatever it was checking.
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.route(`${origin}/**`, (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (name === '') return route.fulfill({ contentType: 'text/html', body: html });
      if (name === 'vscode-defaults.css') return route.fulfill({ contentType: 'text/css', body: VSCODE_DEFAULTS });
      return route.fulfill({ path: join(media, name) });
    });
    const panel: Panel = {
      page,
      post: async (message) => {
        await page.evaluate((data) => window.postMessage(data, '*'), message);
        // Messages are handled, and focus moved, on the frames after they arrive.
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
      },
      posted: () => page.evaluate(() => (window as unknown as { posted: { type: string }[] }).posted),
      fits: (step) => assertPageFits(page, step),
      openForm: async (session, mode) => {
        const connectionId = mode === 'edit' ? 'app' : undefined;
        await panel.post({ ...snapshot, openConnectionForm: { session, title: 'Add connection', connectionId } });
        const draft = { ...emptyDraft(), label: mode === 'edit' ? 'App DB' : '' };
        await panel.post({
          type: 'connectionForm',
          session,
          update: { type: 'init', mode, draft, secret: false, profiles: [], sites: [] },
        });
      },
    };
    await use(async ({ saved, first = snapshot } = {}) => {
      await page.addInitScript((state) => {
        const posted: unknown[] = [];
        Object.assign(window, {
          posted,
          acquireVsCodeApi: () => ({
            getState: () => state,
            setState() {},
            postMessage: (message: unknown) => posted.push(message),
          }),
        });
      }, saved);
      await page.goto(`${origin}/`);
      await panel.post(first);
      return panel;
    });
    expect(errors, 'errors in the panel').toEqual([]);
  },
});

export { expect };

async function assertPageFits(page: Page, step: string): Promise<void> {
  const { scrollTop, scrollHeight, clientHeight, scrollWidth, clientWidth } = await page.evaluate(() => {
    const { scrollTop, scrollHeight, clientHeight, scrollWidth, clientWidth } = document.scrollingElement!;
    return { scrollTop, scrollHeight, clientHeight, scrollWidth, clientWidth };
  });
  expect(scrollTop, `${step}: the page scrolled, moving the tabs out of view`).toBe(0);
  expect(scrollHeight, `${step}: the page is ${scrollHeight}px tall in a ${clientHeight}px panel`).toBeLessThanOrEqual(
    clientHeight,
  );
  expect(scrollWidth, `${step}: the page is ${scrollWidth}px wide in a ${clientWidth}px panel`).toBeLessThanOrEqual(
    clientWidth,
  );
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
  expect(unreachable, `${step}: controls out of reach`).toEqual([]);
}
