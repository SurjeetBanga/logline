import * as vscode from 'vscode';
import { normalizeSetting, type Settings } from '../core/settings';

/**
 * Settings whose default depends on where the window runs. Terminal capture is on by default on this
 * machine, where what it captures stays, and off on a remote host such as a Codespace.
 */
const HOST_DEFAULTS: Record<string, () => unknown> = {
  captureTerminals: () => !vscode.env?.remoteName,
};

export class Configuration implements Settings {
  private current = vscode.workspace.getConfiguration('logline');
  private readonly cache = new Map<string, { raw: unknown; fallback: unknown; value: unknown }>();
  get<T>(key: string, fallback: T): T {
    const hostDefault = Object.hasOwn(HOST_DEFAULTS, key) ? HOST_DEFAULTS[key] : undefined;
    const raw = hostDefault && this.isDefault(key) ? hostDefault() : this.current.get<unknown>(key, fallback);
    const cached = this.cache.get(key);
    if (cached && cached.raw === raw && cached.fallback === fallback) return cached.value as T;
    const value = normalizeSetting(key, raw, fallback);
    this.cache.set(key, { raw, fallback, value });
    return value as T;
  }
  /** Whether no user, workspace, or folder setting gives `key` a value, so its default applies. */
  isDefault(key: string): boolean {
    // Without a way to tell, the value the settings give is taken as set.
    const inspected = this.current.inspect?.(key);
    if (!inspected) return false;
    return [
      inspected.globalValue,
      inspected.workspaceValue,
      inspected.workspaceFolderValue,
      inspected.globalLanguageValue,
      inspected.workspaceLanguageValue,
      inspected.workspaceFolderLanguageValue,
    ].every((value) => value === undefined);
  }
  refresh(): void {
    this.current = vscode.workspace.getConfiguration('logline');
    this.cache.clear();
  }
}
