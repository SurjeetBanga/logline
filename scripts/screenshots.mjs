import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as data from './screenshots/fixtures.mjs';

// Regenerates the images in media/readme from the real panel (media/viewer.*), so they never have to be captured
// by hand. The panel runs in headless Chromium inside a hand-built VS Code window (scripts/screenshots/frame.html)
// and is answered by the fixtures in scripts/screenshots/fixtures.mjs, as the extension host would answer it.
//
//   node scripts/screenshots.mjs [--only logs,analyze,compare,share,demo,video,social] [--keep]
//
// Needs Chromium (`npx playwright install chromium` once) and cwebp and img2webp from the `webp` package
// (`brew install webp`, or `apt install webp`). --keep leaves the PNG frames in a folder it names.
const {
  values: { only, keep },
} = parseArgs({ options: { only: { type: 'string' }, keep: { type: 'boolean' } } });

for (const tool of ['cwebp', 'img2webp']) {
  if (spawnSync(tool, ['-version']).error) {
    console.error(
      `${tool} was not found. Install the webp package (brew install webp, or apt install webp) and run again.`,
    );
    process.exit(1);
  }
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const media = path.join(root, 'media');
const assets = path.join(root, 'scripts', 'screenshots');
const out = path.join(media, 'readme');
const origin = 'https://logline.test';

// The panel page as src/vscode/webview-html.ts fills it, with the Dark Modern colours added before its own styles.
const stylesheet = `<link rel="stylesheet" href="${origin}/viewer.css" />`;
const panelHtml = (await readFile(path.join(media, 'viewer.html'), 'utf8'))
  .replace(
    /\{\{([A-Z_]+)\}\}/g,
    (_, key) =>
      ({
        CSP_SOURCE: origin,
        NONCE: 'shot',
        STYLE_URI: `${origin}/viewer.css`,
        SCRIPT_URI: `${origin}/viewer.js`,
        GUIDE_UNREAD: 'false',
        FIRST_RUN: 'false',
      })[key] ?? '',
  )
  .replace(stylesheet, `<link rel="stylesheet" href="${origin}/theme.css" />\n    ${stylesheet}`);
if (!panelHtml.includes('/theme.css')) throw new Error('media/viewer.html no longer links viewer.css as expected.');

const scratch = await mkdtemp(path.join(tmpdir(), 'logline-shots-'));
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error}`);
};

const browser = await chromium.launch();
const settle = (page, ms = 450) => page.waitForTimeout(ms);

// The windows are drawn a little larger than the README shows them, so a full toolbar and an open inspector fit,
// and are scaled down to these sizes.
const WINDOW = { width: 1360, height: 850 };
const SIZES = { logs: [1280, 800], analyze: [1280, 800], share: [1280, 800], compare: [1440, 860], demo: [1280, 800] };

/**
 * A VS Code window holding the panel, with a stand-in for the extension host answering what the panel asks.
 * `host.snapshot(request)` builds the Logs view's snapshot; `host.share` answers a request to share.
 */
async function openWindow({ width = WINDOW.width, height = WINDOW.height, title, editor, scroll, host }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));
  await page.clock.setFixedTime(data.NOW);
  await page.route(`${origin}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === 'panel.html') return route.fulfill({ contentType: 'text/html', body: panelHtml });
    if (['frame.html', 'frame.css', 'theme.css'].includes(name))
      return route.fulfill({ path: path.join(assets, name) });
    return route.fulfill({ path: path.join(media, name) });
  });
  const panel = () => page.frames().find((frame) => frame !== page.mainFrame());
  const send = (message) => panel().evaluate((payload) => window.postMessage(payload, '*'), message);
  await page.exposeFunction('hostRequest', (request) => {
    const reply = answer(host, request);
    if (reply) setTimeout(() => send(reply).catch(() => {}), 15);
  });
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({
      getState: () => ({ rowHintDismissed: true, cellHintDismissed: true }),
      setState() {},
      postMessage: (message) => window.hostRequest(JSON.parse(JSON.stringify(message))),
    });
  });
  const query = new URLSearchParams(
    Object.entries({ title, editor, scroll }).filter(([, value]) => value !== undefined),
  );
  await page.goto(`${origin}/frame.html?${query}`);
  await panel().waitForSelector('#viewTabs');
  const window = {
    page,
    host,
    get panel() {
      return panel();
    },
    /** Sends the current snapshot, with any extras such as `applyQuery`. */
    async refresh(extra = {}) {
      await send({ ...host.snapshot(), ...extra });
      await settle(page);
    },
    async click(selector, wait) {
      await panel().locator(selector).first().click();
      await settle(page, wait);
    },
    async close() {
      await context.close();
    },
    /** A PNG of the whole window at twice its size. */
    async shoot(name) {
      const file = path.join(scratch, `${name}.png`);
      // The pointer rests on the title bar, so no row is hovered, no tooltip is open, and Live keeps adding rows.
      await page.mouse.move(700, 17);
      await settle(page, 250);
      await page.screenshot({ path: file });
      if (problems.length) console.warn(`${name}: ${problems.splice(0).join(' | ')}`);
      return file;
    },
  };
  await window.refresh();
  return window;
}

/** What the panel asks the host for, and the reply the fixtures give. */
function answer(host, request) {
  switch (request.type) {
    case 'snapshot':
      return { ...host.snapshot(request), requestId: request.requestId };
    case 'analysis':
      return { type: 'analysis', analysis: data.analysis() };
    case 'traces':
      return { type: 'traces', traces: data.traces };
    case 'trace':
      return { type: 'trace', trace: data.trace };
    case 'aiCalls':
      return { type: 'aiCalls', aiCalls: data.emptyAiCalls };
    case 'metrics':
      return { type: 'metrics', metrics: [] };
    case 'compare':
      return { type: 'compare', view: data.compare };
    case 'details':
      return { ...data.details(request.id), target: request.target ?? 'main' };
    case 'shareWithAgent':
      return host.share?.(request);
    default:
      return undefined;
  }
}

/** A host whose Logs view follows the search: a `level:error` filter keeps only the errors. */
function logsHost() {
  const host = {
    events: data.allEvents(),
    sharing: data.sharing(),
    share: undefined,
    snapshot(request = {}) {
      const errorsOnly = /\blevel:error\b/.test(request.query ?? '');
      const events = errorsOnly ? host.events.filter((event) => event.level === 'error') : host.events;
      return data.snapshot({ events, share: host.sharing });
    },
  };
  return host;
}

/** The failing event, selected in the inspector under a level:error filter. */
async function openFailingEvent(window) {
  await window.refresh({ applyQuery: 'level:error' });
  await window.click('#railToggle', 300);
  await selectFailingEvent(window);
}
async function selectFailingEvent(window) {
  await window.panel.locator('#logs tr.event-row', { hasText: '23:11:16.727' }).locator('.message-button').click();
  await settle(window.page, 700);
}

/** Scales a 2x capture down to the size the README shows, with the browser's own resampling. */
let resampler;
async function scaleTo(file, [width, height]) {
  resampler ??= await (await browser.newContext({ viewport: { width, height } })).newPage();
  await resampler.setViewportSize({ width, height });
  const source = (await readFile(file)).toString('base64');
  await resampler.setContent(
    `<style>html,body{margin:0}img{display:block;width:${width}px;height:${height}px}</style><img src="data:image/png;base64,${source}">`,
  );
  await resampler.waitForFunction(() => document.images[0].complete);
  const scaled = file.replace(/\.png$/, `-${width}.png`);
  await resampler.screenshot({ path: scaled });
  return scaled;
}

/** The logs scene, laid out for the social preview (2:1) and the video thumbnail (16:9). */
async function compose(layout, shot, [width, height]) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'dark' });
  const page = await context.newPage();
  await page.route(`${origin}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    const file = ['compose.html', 'compose.css'].includes(name) ? path.join(assets, name) : path.join(media, name);
    return route.fulfill({ path: file });
  });
  await page.goto(`${origin}/compose.html`);
  const source = `data:image/png;base64,${(await readFile(shot)).toString('base64')}`;
  await page.evaluate(
    ([name, image]) => {
      document.body.className = name;
      for (const element of document.querySelectorAll('[data-shot]')) element.src = image;
    },
    [layout, source],
  );
  await page.waitForFunction(() => [...document.images].every((image) => image.complete));
  await settle(page, 200);
  const file = path.join(scratch, `${layout}.png`);
  await page.screenshot({ path: file });
  await context.close();
  return file;
}

// What each scene returns: a `png` for a still, or `frames` of `{ png, ms }` for the animation.
let logsShot;
const logsScene = () =>
  (logsShot ??= (async () => {
    const window = await openWindow({ host: logsHost() });
    await openFailingEvent(window);
    const png = await window.shoot('logs');
    await window.close();
    return png;
  })());

const scenes = {
  async logs() {
    return { png: await scaleTo(await logsScene(), SIZES.logs), size: SIZES.logs };
  },
  async analyze() {
    const window = await openWindow({ host: logsHost() });
    await window.click('#analyze', 900);
    const png = await window.shoot('analyze');
    await window.close();
    return { png: await scaleTo(png, SIZES.analyze), size: SIZES.analyze };
  },
  async compare() {
    const window = await openWindow({
      width: 1440,
      height: 860,
      title: 'checkout',
      editor: 150,
      scroll: 48,
      host: logsHost(),
    });
    await window.click('#compare', 700);
    // Production is the Datadog search, not the imported file the list starts on.
    const datadog = await window.panel.locator('#compareBaseline option', { hasText: 'Datadog' }).first().textContent();
    await window.panel.locator('#compareBaseline').selectOption({ label: datadog });
    await settle(window.page, 500);
    await window.panel.locator('#compareRows tr').first().click();
    await settle(window.page, 600);
    const png = await window.shoot('compare');
    await window.close();
    return { png: await scaleTo(png, SIZES.compare), size: SIZES.compare };
  },
  async share() {
    const host = logsHost();
    host.sharing = data.sharing({ on: true, reading: ['Claude Code'] });
    // A taller panel under a shorter editor, so the whole Share panel fits.
    const window = await openWindow({ host, editor: 76, scroll: 108 });
    await openFailingEvent(window);
    await window.click('#shareMenuButton', 700);
    const png = await window.shoot('share');
    await window.close();
    return { png: await scaleTo(png, SIZES.share), size: SIZES.share };
  },
  async demo() {
    const host = logsHost();
    // A short editor above the panel leaves room for the whole Share panel when it opens.
    const window = await openWindow({ host, editor: 104, scroll: 88 });
    const frames = [];
    const frame = async (ms) =>
      frames.push({ png: await scaleTo(await window.shoot(`demo-${frames.length + 1}`), SIZES.demo), ms });
    const first = host.events;
    // Logs arriving: the view is live, and each new line lands on top.
    await window.click('#railToggle', 300);
    await frame(1200);
    for (const count of [2, 4]) {
      host.events = [...first, ...data.liveEvents(count)];
      await window.refresh();
      await frame(800);
    }
    await window.click('#analyze', 1000);
    await frame(1800);
    // Back on Logs, the search is typed and applied as a filter chip.
    await window.click('#logsTab', 400);
    await window.click('#search', 200);
    await window.page.keyboard.type('level:error', { delay: 20 });
    await settle(window.page, 400);
    await frame(1000);
    await window.page.keyboard.press('Enter');
    await settle(window.page, 800);
    await frame(1300);
    await selectFailingEvent(window);
    await frame(2000);
    await window.panel
      .locator('#inspectorBody button', { hasText: /^Trace$/ })
      .first()
      .click();
    await settle(window.page, 900);
    await frame(2200);
    await window.click('#shareMenuButton', 600);
    await frame(1500);
    host.share = () => {
      host.sharing = data.sharing({ on: true, reading: ['Claude Code'] });
      return host.snapshot();
    };
    await window.click('#shareToggle', 700);
    await window.page.keyboard.press('Escape');
    await window.panel.evaluate(() => document.activeElement?.blur());
    await settle(window.page, 500);
    await frame(2400);
    await window.close();
    return { frames, size: SIZES.demo };
  },
  async video() {
    return { png: await compose('video', await logsScene(), [1280, 720]), size: [1280, 720] };
  },
  async social() {
    return { png: await compose('social', await logsScene(), [1280, 640]), size: [1280, 640], format: 'png' };
  },
};

const kilobytes = async (file) => `${((await readFile(file)).length / 1024).toFixed(0)} KB`;

try {
  await mkdir(out, { recursive: true });
  const names = only ? only.split(',') : Object.keys(scenes);
  const unknown = names.filter((name) => !scenes[name]);
  if (unknown.length)
    throw new Error(`Unknown scene ${unknown.join(', ')}; the scenes are ${Object.keys(scenes).join(', ')}.`);
  for (const name of names) {
    const result = await scenes[name]();
    const target = path.join(out, `${name === 'social' ? 'social-preview' : name}.${result.format ?? 'webp'}`);
    if (result.frames) {
      // The animation loops forever (-loop 0), and each frame stays for its own time in milliseconds.
      const args = ['-loop', '0', '-lossy', '-q', '82', '-m', '6'];
      for (const { png, ms } of result.frames) args.push('-d', String(ms), png);
      run('img2webp', [...args, '-o', target]);
    } else if (result.format === 'png') {
      await writeFile(target, await readFile(result.png));
    } else {
      run('cwebp', ['-q', '90', '-m', '6', '-sharp_yuv', result.png, '-o', target]);
    }
    console.log(`${path.relative(root, target)}  ${result.size.join('x')}  ${await kilobytes(target)}`);
  }
  if (keep) console.log(`PNG frames kept in ${scratch}`);
} finally {
  await browser.close();
  if (!keep) await rm(scratch, { recursive: true, force: true });
}
