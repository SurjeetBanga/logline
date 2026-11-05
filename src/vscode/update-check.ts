import { request } from 'node:https';
import * as vscode from 'vscode';
import type { UpdateStatus } from '../protocol/messages';

const EXTENSION_ID = 'surjeetbanga.logline';
const STATE_KEY = 'logline.update';
const MARKETPLACE = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const OPEN_VSX = 'https://open-vsx.org/api/surjeetbanga/logline';
const LIMIT_BYTES = 256 * 1024;
/** Long enough after a start that the question never interrupts it. */
export const UPDATE_DELAY_MS = 30_000;
export const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
/** How often an open window looks at whether a check is due; the store is asked only when one is. */
export const UPDATE_POLL_MS = 60 * 60 * 1000;

interface UpdateState {
  /** When the store was last asked. */
  checked?: number;
  /** The newest version found, so the button is back after a restart without asking again. */
  available?: string;
  /** The version last installed from the button. If the editor could not move to it, it is not offered again. */
  tried?: string;
}

export type UpdateAnswer = 'accepted' | 'failed';
/** The newest version in the store, or nothing when it cannot be told. */
export type LatestVersion = (appName: string | undefined) => Promise<string | undefined>;

/** Whether `candidate` is a later `major.minor.patch` than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (version: string) => version.split('.').map(Number);
  const [next, now] = [parts(candidate), parts(current)];
  if (next.length !== 3 || now.length !== 3 || [...next, ...now].some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < 3; index++) if (next[index] !== now[index]) return next[index] > now[index];
  return false;
}

/**
 * Only for someone whose editor will not update Logline by itself, and who has
 * not turned off checking for updates: everyone else needs no notice, and a
 * person who turned checks off should not get one from Logline instead.
 */
export function wantsUpdateNotice(setting: (key: string) => unknown): boolean {
  const auto = setting('autoUpdate');
  // The editor's own test for "off", from old values to current ones: anything else, even a future value, gets no notice.
  const off = auto === 'off' || auto === false || auto === 'onlySelectedExtensions';
  return off && setting('autoCheckUpdates') !== false;
}

function fetchText(url: string, body?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    // node:https, not fetch: the extension host routes it through the editor's proxy settings.
    const req = request(
      url,
      {
        method: body ? 'POST' : 'GET',
        timeout: 5000,
        headers: {
          accept: 'application/json;api-version=7.2-preview.1',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
          if (text.length > LIMIT_BYTES) req.destroy();
        });
        res.on('end', () => resolve((res.statusCode ?? 0) < 300 ? text : undefined));
        res.on('error', () => resolve(undefined));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(undefined));
    req.end(body);
  });
}

/** Reads the version from a store's answer; anything unexpected gives nothing. */
export function storeVersion(text: string | undefined, marketplace: boolean): string | undefined {
  try {
    const data = JSON.parse(text ?? '') as {
      version?: unknown;
      results?: { extensions?: { versions?: { version?: unknown }[] }[] }[];
    };
    const version = marketplace ? data.results?.[0]?.extensions?.[0]?.versions?.[0]?.version : data.version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Asks the store this editor installs from, naming only the extension. */
const latestFromStore: LatestVersion = async (appName) => {
  const marketplace = /visual studio code/i.test(appName ?? '');
  const query = {
    filters: [{ criteria: [{ filterType: 7, value: EXTENSION_ID }] }],
    // Versions, and only the latest.
    flags: 513,
  };
  return storeVersion(
    await (marketplace ? fetchText(MARKETPLACE, JSON.stringify(query)) : fetchText(OPEN_VSX)),
    marketplace,
  );
};

/**
 * Keeps an Update button in the Logs panel for someone without automatic updates
 * while a newer Logline is out: Update, then Updating, then Reload.
 */
export class UpdateCheck implements vscode.Disposable {
  private timer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private shown?: UpdateStatus;

  constructor(
    private readonly memento: Pick<vscode.Memento, 'get' | 'update'>,
    private readonly current: string,
    /** Told that the button changed, so the panel can show it. */
    private readonly changed: () => void,
    private readonly answered?: (answer: UpdateAnswer) => void,
    private readonly latest: LatestVersion = latestFromStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** What the button shows; nothing while there is no update to offer. */
  status(): UpdateStatus | undefined {
    return this.shown;
  }

  private get wanted(): boolean {
    const extensions = vscode.workspace.getConfiguration('extensions');
    return wantsUpdateNotice((key) => extensions.get(key));
  }

  private get state(): UpdateState {
    return this.memento.get<UpdateState>(STATE_KEY) ?? {};
  }

  private save(change: UpdateState): Promise<void> {
    return Promise.resolve(this.memento.update(STATE_KEY, { ...this.state, ...change })).catch(() => undefined);
  }

  private show(status: UpdateStatus | undefined): void {
    this.shown = status;
    this.changed();
  }

  /** Offer a version already found, without asking the store; one that was tried and did not take is not offered again. */
  private offer(version: string | undefined): boolean {
    if (!version || !isNewer(version, this.current) || version === this.state.tried) return false;
    this.show({ version, state: 'available' });
    return true;
  }

  start(): void {
    if (this.wanted) this.offer(this.state.available);
    this.timer = setTimeout(() => {
      void this.check();
      this.poll = setInterval(() => void this.check(), UPDATE_POLL_MS);
      this.poll.unref?.();
    }, UPDATE_DELAY_MS);
    this.timer.unref?.();
  }

  /** Ask the store if it is time; returns whether there is an update to offer. */
  async check(): Promise<boolean> {
    if (!this.wanted) return false;
    const { checked } = this.state;
    const now = this.now();
    if (checked !== undefined && now - checked < UPDATE_EVERY_MS) return false;
    const latest = await this.latest(vscode.env.appName);
    // No answer does not use up the day: the next poll asks again.
    if (!latest) return false;
    await this.save({ checked: now });
    if (!isNewer(latest, this.current)) return false;
    await this.save({ available: latest });
    return this.shown?.state === 'available' || this.shown?.state === undefined ? this.offer(latest) : false;
  }

  /** The button was pressed: install the update, or reload once it is installed. */
  async press(): Promise<void> {
    const status = this.shown;
    if (!status || status.state === 'installing') return;
    if (status.state === 'ready') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    }
    this.show({ ...status, state: 'installing' });
    await this.save({ tried: status.version });
    try {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', EXTENSION_ID);
    } catch {
      await this.save({ tried: undefined });
      this.answered?.('failed');
      this.show({ ...status, state: 'available' });
      void vscode.window.showWarningMessage('Logline could not update itself. Update it from the Extensions view.');
      return;
    }
    this.answered?.('accepted');
    this.show({ ...status, state: 'ready' });
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearInterval(this.poll);
  }
}
