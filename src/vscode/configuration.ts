import * as vscode from 'vscode';
import type { Settings } from '../core/settings';

export class Configuration implements Settings {
  private current = vscode.workspace.getConfiguration('logline');
  get<T>(key: string, fallback: T): T { return this.current.get(key, fallback); }
  refresh(): void { this.current = vscode.workspace.getConfiguration('logline'); }
}
