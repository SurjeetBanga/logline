import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BrowserCapture } from '../capture/browser-capture';
import { locateBrowser } from '../capture/browser-locate';
import { browserSource, browserUrl } from '../core/browser-events';
import type { Settings } from '../core/settings';
import type { NudgeStep } from '../core/usage-events';

/** The address last opened in this workspace, offered again next time. */
export const BROWSER_URL_KEY = 'logline.browser.lastUrl';
/** Set once this workspace was offered the browser. */
export const BROWSER_OFFER_WORKSPACE_KEY = 'logline.browserOffer.asked';
/** How many workspaces were offered it, and whether to stop offering. */
export const BROWSER_OFFER_KEY = 'logline.browserOffer';
/** Offered in this many workspaces without a yes, Logline stops offering. */
export const BROWSER_OFFER_LIMIT = 3;
/** How long after a run starts its output is read for an address, in turn. */
export const BROWSER_OFFER_DELAYS_MS = [4000, 15_000];

const FALLBACK_URL = 'http://localhost:3000';
const REMOTE =
  'Logline runs on a remote machine in this window, where it has no browser to open. Browser capture works in a window on your own machine.';

type Memento = Pick<vscode.Memento, 'get' | 'update'>;

export interface BrowserLauncherOptions {
  capture: BrowserCapture;
  config: Settings;
  /** The extension's storage folder; each workspace's browser profile is kept under it. */
  storagePath: string;
  workspace: Memento;
  /** The newest local address a captured run printed, such as a dev server's. */
  recentUrl: () => string | undefined;
  /** Show the browser's source in the Logs panel. */
  show: (serverId: string) => unknown;
  exists?: (file: string) => boolean;
  /** Whether a running browser holds a profile folder. */
  inUse?: (profileDir: string) => boolean;
}

/** Whether a running Chromium holds the profile: its lock is a link on macOS and Linux, a file on Windows. */
export function profileInUse(profileDir: string): boolean {
  try {
    // The link points at no file, so only looking at the link itself finds it.
    lstatSync(path.join(profileDir, 'SingletonLock'));
    return true;
  } catch {
    return existsSync(path.join(profileDir, 'lockfile'));
  }
}

/** Opens the browser Logline captures: finds it, asks for the address, and keeps a profile per workspace. */
export class BrowserLauncher {
  constructor(private readonly options: BrowserLauncherOptions) {}

  /** The browser that would be opened, or undefined when none is installed or the configured one is missing. */
  executable(): string | undefined {
    return locateBrowser(
      process.platform,
      process.env,
      this.options.exists ?? existsSync,
      this.options.config.get('browser.executable', ''),
    );
  }

  /** Why a browser cannot be opened from this window, if it cannot. */
  unavailable(): string | undefined {
    if (vscode.env?.remoteName) return REMOTE;
    if (!vscode.workspace.isTrusted) return 'Trust this workspace before opening a browser from it.';
    return undefined;
  }

  /**
   * The workspace's profile folder. A browser of another window on the same folder may be using it,
   * and a second browser cannot: it would hand its tab to the first and exit. This window then gets a
   * profile of its own, without the sign-ins of the shared one.
   */
  private profileDir(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? '';
    const name = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
    const shared = path.join(this.options.storagePath, 'browser-profiles', name(folder));
    if (!(this.options.inUse ?? profileInUse)(shared)) return shared;
    return `${shared}-${name(vscode.env?.sessionId ?? String(process.pid))}`;
  }

  /** Open `url`, or ask for one; returns whether a browser was opened. */
  async open(url?: string): Promise<boolean> {
    const { capture, workspace } = this.options;
    const blocked = this.unavailable();
    if (blocked) {
      void vscode.window.showWarningMessage(blocked);
      return false;
    }
    const executable = this.executable();
    if (!executable) {
      const configured = this.options.config.get('browser.executable', '').trim();
      const SETTINGS = 'Open Settings';
      const answer = await vscode.window.showWarningMessage(
        configured
          ? `Logline found no browser at ${configured}. Change logline.browser.executable, or clear it to use an installed Chrome, Edge, Chromium, or Brave.`
          : 'Logline found no Chrome, Edge, Chromium, or Brave to open. Set logline.browser.executable to the browser to use.',
        SETTINGS,
      );
      if (answer === SETTINGS)
        await vscode.commands.executeCommand('workbench.action.openSettings', 'logline.browser.executable');
      return false;
    }
    let target = url && browserUrl(url);
    if (!target) {
      const typed = await vscode.window.showInputBox({
        title: 'Open browser with capture',
        prompt: 'Address of your app. Its console, errors, and requests appear in the Logs panel.',
        // What was opened here before is the likeliest; a dev server's printed address is a guess.
        value: workspace.get<string>(BROWSER_URL_KEY) ?? this.options.recentUrl() ?? FALLBACK_URL,
        ignoreFocusOut: true,
        validateInput: (value) => (browserUrl(value) ? undefined : 'Enter an http or https address.'),
      });
      target = typed === undefined ? undefined : browserUrl(typed);
      if (!target) return false;
    }
    try {
      const profileDir = this.profileDir();
      await mkdir(profileDir, { recursive: true });
      await capture.open(target, { executable, profileDir });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Logline could not open the browser: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    void Promise.resolve(workspace.update(BROWSER_URL_KEY, target)).catch(() => undefined);
    await this.options.show(browserSource(target).serverId);
    return true;
  }
}

interface OfferState {
  asked?: number;
  done?: boolean;
}

export interface BrowserOfferOptions {
  workspace: Memento;
  global: Memento;
  enabled: () => boolean;
  /** Whether a browser could be opened here, and none is open yet. */
  available: () => boolean;
  open: (url: string) => Promise<boolean>;
  record?: (step: NudgeStep) => void;
}

const OPEN = 'Open Browser';
const NOT_NOW = 'Not Now';
const NEVER = "Don't Ask Again";

/**
 * Offers the captured browser when a run prints a local address, such as a dev server's: once per
 * workspace, and in a few workspaces at most.
 */
export class BrowserOffer {
  private asking = false;
  /** Asked in this window already, whether or not it was answered. */
  private asked = false;

  constructor(private readonly options: BrowserOfferOptions) {}

  /** Whether an address found now would be offered; cheap enough to check before looking for one. */
  canAsk(): boolean {
    const { workspace, global } = this.options;
    if (this.asking || this.asked || !this.options.enabled()) return false;
    const state = global.get<OfferState>(BROWSER_OFFER_KEY) ?? {};
    if (state.done || (state.asked ?? 0) >= BROWSER_OFFER_LIMIT || workspace.get<boolean>(BROWSER_OFFER_WORKSPACE_KEY))
      return false;
    return this.options.available();
  }

  /** A dev server printed `url`; returns whether it asked. */
  async found(url: string): Promise<boolean> {
    const { workspace, global, record } = this.options;
    if (!this.canAsk()) return false;
    const state = global.get<OfferState>(BROWSER_OFFER_KEY) ?? {};
    this.asking = true;
    this.asked = true;
    try {
      // What cannot be remembered is asked again; that is no reason to fail.
      const put = (memento: Memento, key: string, value: unknown) =>
        Promise.resolve(memento.update(key, value)).catch(() => undefined);
      await put(global, BROWSER_OFFER_KEY, { ...state, asked: (state.asked ?? 0) + 1 });
      record?.('shown');
      const answer = await vscode.window.showInformationMessage(
        `Your app is at ${url}. Open it in a browser Logline captures, to see its console and requests beside these logs?`,
        OPEN,
        NOT_NOW,
        NEVER,
      );
      // A notification that went away unanswered may never have been seen: the workspace is asked
      // again in a later session, within the limit. An answer settles it for the workspace.
      if (answer) await put(workspace, BROWSER_OFFER_WORKSPACE_KEY, true);
      // Other windows may have asked, or been answered, while this one waited.
      const latest = () => global.get<OfferState>(BROWSER_OFFER_KEY) ?? {};
      if (answer === NEVER) {
        record?.('never');
        await put(global, BROWSER_OFFER_KEY, { ...latest(), done: true });
      } else if (answer === OPEN) {
        record?.('accepted');
        // Someone who has opened it knows it is there.
        if (await this.options.open(url)) await put(global, BROWSER_OFFER_KEY, { ...latest(), done: true });
      } else record?.('dismissed');
      return true;
    } finally {
      this.asking = false;
    }
  }
}
