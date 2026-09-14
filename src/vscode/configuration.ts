import * as vscode from 'vscode';
import { normalizeSetting, type Settings } from '../core/settings';

export class Configuration implements Settings {
  private current = vscode.workspace.getConfiguration('logline');
  private readonly cache = new Map<string, { raw: unknown; fallback: unknown; value: unknown }>();
  get<T>(key: string, fallback: T): T {
    const raw = this.current.get<unknown>(key, fallback);
    const cached = this.cache.get(key);
    if (cached && cached.raw === raw && cached.fallback === fallback) return cached.value as T;
    const value = normalizeSetting(key, raw, fallback);
    this.cache.set(key, { raw, fallback, value });
    return value as T;
  }
  refresh(): void { this.current = vscode.workspace.getConfiguration('logline'); this.cache.clear(); }
}
