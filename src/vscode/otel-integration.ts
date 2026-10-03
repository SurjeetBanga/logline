import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { OtlpReceiver } from '../capture/otlp-receiver';
import type { Session } from '../capture/types';
import { missingOtelVariables, otelDefaults } from '../core/otel-environment';
import type { Settings } from '../core/settings';

type Config = Settings & { refresh(): void };

/**
 * Runs the OpenTelemetry receiver to match settings and points new
 * processes, terminals and debug sessions at it while it runs.
 */
export class OtelIntegration {
  private disposed = false;
  /** Set by the Start/Stop commands for this window; the setting only decides whether it starts automatically. */
  private override?: boolean;

  constructor(private readonly config: Config, readonly receiver: OtlpReceiver, private readonly changed: () => void,
    private readonly terminalEnvironment?: vscode.EnvironmentVariableCollection) {
    if (terminalEnvironment) {
      // The receiver's port can change between windows; a persisted
      // collection would point revived terminals at a stale endpoint.
      terminalEnvironment.persistent = false;
      terminalEnvironment.clear();
    }
  }

  /** OpenTelemetry variables for a new process, or undefined when nothing should target the receiver. */
  variables(service?: string): Record<string, string> | undefined {
    if (!this.receiver.running || !this.receiver.endpoint || !this.config.get('otlp.injectEnvironment', true)) return undefined;
    return otelDefaults(this.receiver.endpoint, service);
  }

  /** Variables to add to a Logline server or task; saved ones are named after their label. */
  processEnvironment(server: Session['server'], env: Record<string, string | undefined>): Record<string, string> {
    const service = server.id === 'custom' ? undefined : (server.taskName ?? server.label).trim().slice(0, 100) || undefined;
    const defaults = this.variables(service);
    return defaults ? missingOtelVariables(env, defaults) : {};
  }

  /** Start, restart, or stop the receiver to match settings, then update the terminal environment. */
  async sync(): Promise<void> {
    if (this.disposed) return;
    const enabled = this.override ?? this.config.get('otlp.enabled', false);
    const port = this.config.get('otlp.port', 4318);
    if (!enabled || (this.receiver.running && this.receiver.requestedPort !== port)) await this.receiver.stop();
    if (enabled && !this.disposed) await this.receiver.start(port);
    if (this.disposed) { await this.receiver.stop(); return; }
    this.updateTerminalEnvironment();
    this.changed();
  }

  /** Start or stop the receiver for this window without changing settings, which may be shared with a team. */
  async toggle(enabled: boolean): Promise<void> {
    this.override = enabled;
    await this.sync();
    if (enabled && this.receiver.running) {
      void vscode.window.showInformationMessage(`Logline is receiving OpenTelemetry on ${this.receiver.endpoint}. Servers, tasks, debug sessions, and new terminals started from now on send telemetry here.`);
    } else if (enabled && this.receiver.error) void vscode.window.showWarningMessage(`Logline: ${this.receiver.error}`);
  }

  /** A changed `logline.otlp.enabled` setting takes over from the Start/Stop commands. */
  settingChanged(): void { this.override = undefined; }

  /**
   * Add the variables to every launch configuration while the receiver
   * runs. Variables in the configuration, its env file, or VS Code's
   * environment win. Variables are substituted by then, so `envFile` is a path.
   */
  registerDebugEnvironment(): vscode.Disposable[] {
    const debug = (vscode as unknown as { debug?: Partial<typeof vscode.debug> }).debug;
    if (!debug?.registerDebugConfigurationProvider) return [];
    return [debug.registerDebugConfigurationProvider('*', {
      resolveDebugConfigurationWithSubstitutedVariables: (folder: vscode.WorkspaceFolder | undefined, configuration: vscode.DebugConfiguration) => {
        const defaults = this.variables();
        if (!defaults || configuration.request === 'attach') return configuration;
        const env = configuration.env && typeof configuration.env === 'object' && !Array.isArray(configuration.env) ? configuration.env as Record<string, string> : {};
        // Debuggers give `env` precedence over the env file, so a value
        // added here would replace an exporter the file configures.
        const added = missingOtelVariables({ ...process.env, ...envFileVariables(configuration, folder?.uri.fsPath), ...env }, defaults);
        if (Object.keys(added).length) configuration.env = { ...added, ...env };
        return configuration;
      }
    })];
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.terminalEnvironment?.clear();
    await this.receiver.stop();
  }

  private updateTerminalEnvironment(): void {
    const collection = this.terminalEnvironment;
    if (!collection) return;
    collection.clear();
    const defaults = this.variables();
    if (!defaults) return;
    for (const [name, value] of Object.entries(missingOtelVariables(process.env, defaults))) collection.replace(name, value);
    collection.description = `Sends OpenTelemetry data from new terminals to Logline at ${this.receiver.endpoint}`;
  }
}

// Python debuggers read the workspace `.env` when a configuration names no env file.
const DEFAULT_ENV_FILE_TYPES = new Set(['python', 'debugpy']);

/** Variables from a launch configuration's env file(s), in dotenv syntax; unreadable files add nothing. */
export function envFileVariables(configuration: { type?: unknown; envFile?: unknown }, folder?: string): Record<string, string> {
  const named = typeof configuration.envFile === 'string' ? [configuration.envFile]
    : Array.isArray(configuration.envFile) ? configuration.envFile.filter((file): file is string => typeof file === 'string') : [];
  const files = named.length ? named
    : folder && typeof configuration.type === 'string' && DEFAULT_ENV_FILE_TYPES.has(configuration.type) ? [path.join(folder, '.env')] : [];
  const variables: Record<string, string> = {};
  for (const file of files) {
    let text: string;
    try { text = readFileSync(folder ? path.resolve(folder, file) : file, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      const value = match[2];
      variables[match[1]] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value.replace(/\s+#.*$/, '');
    }
  }
  return variables;
}
