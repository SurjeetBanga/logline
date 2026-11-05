import { request } from 'node:https';
import * as vscode from 'vscode';

const EXTENSION_ID = 'surjeetbanga.logline';
const STATE_KEY = 'logline.update';
const MARKETPLACE = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const OPEN_VSX = 'https://open-vsx.org/api/surjeetbanga/logline';
const LIMIT_BYTES = 256 * 1024;
/** Long enough after a start that the question never interrupts it. */
export const UPDATE_DELAY_MS = 30_000;
export const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;

interface UpdateState {
  /** When the store was last asked. */
  checked?: number;
  /** The newest version someone was told about: each is mentioned once. */
  notified?: string;
}

export type UpdateAnswer = 'accepted' | 'later' | 'dismissed' | 'failed';
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

/** Tells someone without automatic updates, once for each version, that a newer Logline is out. */
export class UpdateCheck implements vscode.Disposable {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly memento: Pick<vscode.Memento, 'get' | 'update'>,
    private readonly current: string,
    private readonly answered?: (answer: UpdateAnswer) => void,
    private readonly latest: LatestVersion = latestFromStore,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.timer = setTimeout(() => void this.check(), UPDATE_DELAY_MS);
    this.timer.unref?.();
  }

  private save(change: UpdateState): Promise<void> {
    const state = this.memento.get<UpdateState>(STATE_KEY) ?? {};
    return Promise.resolve(this.memento.update(STATE_KEY, { ...state, ...change })).catch(() => undefined);
  }

  /** Check now if it is time; returns whether it told someone about a new version. */
  async check(): Promise<boolean> {
    const extensions = vscode.workspace.getConfiguration('extensions');
    if (!wantsUpdateNotice((key) => extensions.get(key))) return false;
    const { checked, notified } = this.memento.get<UpdateState>(STATE_KEY) ?? {};
    const now = this.now();
    if (checked !== undefined && now - checked < UPDATE_EVERY_MS) return false;
    await this.save({ checked: now });
    const latest = await this.latest(vscode.env.appName);
    if (!latest || !isNewer(latest, this.current) || latest === notified) return false;
    await this.save({ notified: latest });
    const UPDATE = 'Update';
    const answer = await vscode.window.showInformationMessage(
      `Logline ${latest} is available. You have ${this.current}.`,
      UPDATE,
      'Not now',
    );
    if (answer !== UPDATE) {
      this.answered?.(answer ? 'later' : 'dismissed');
      return true;
    }
    try {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', EXTENSION_ID);
    } catch {
      this.answered?.('failed');
      void vscode.window.showWarningMessage('Logline could not update itself. Update it from the Extensions view.');
      return true;
    }
    this.answered?.('accepted');
    const RELOAD = 'Reload Window';
    const reload = await vscode.window.showInformationMessage(`Logline ${latest} is ready. Reload to use it.`, RELOAD);
    if (reload === RELOAD) await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return true;
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}
