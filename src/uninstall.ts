/**
 * Run by VS Code as the `vscode:uninstall` script once Logline is removed, which is after the editor restarts.
 * It sends one anonymous `uninstalled` event, so someone who left can be told from someone who is only away:
 * how long ago Logline was installed and which firsts it reached, with the common properties every event has.
 *
 * It sends only what the extension left in its own folder while usage counts were on (`Usage.writeWill`), which it
 * removes while they are off; `DO_NOT_TRACK` stops it too. No VS Code API is available here.
 */
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { USAGE_HOST, WILL_FILE, sanitizeUsage, type UsageProperties } from './core/usage-events';

/** The common properties an uninstall passes on, besides the version. */
const COMMON_KEYS = ['vscode', 'host', 'ui', 'remote', 'os', 'arch', 'cpus', 'ram_gb', 'internal'] as const;

interface Will {
  id?: unknown;
  projectKey?: unknown;
  installedAt?: unknown;
  milestones?: unknown;
  common?: unknown;
}

/** The batch an uninstall sends, or undefined when there is nothing to send. */
export function uninstallBatch(will: Will, env: NodeJS.ProcessEnv, now: number): string | undefined {
  if (/^(1|true)$/i.test(env.DO_NOT_TRACK ?? '')) return undefined;
  if (typeof will.id !== 'string' || !will.id || typeof will.projectKey !== 'string' || !will.projectKey)
    return undefined;
  const common = will.common && typeof will.common === 'object' ? (will.common as Record<string, unknown>) : {};
  // Only the common properties every event has, as short plain values; the version is checked by the schema below.
  const kept: UsageProperties = {};
  for (const key of COMMON_KEYS) {
    const value = common[key];
    if ((typeof value === 'string' && value.length <= 32) || typeof value === 'boolean') kept[key] = value;
  }
  const properties = sanitizeUsage(
    'uninstalled',
    {
      ...(typeof will.installedAt === 'number' ? { age: Math.max(0, now - will.installedAt) } : {}),
      reached: Array.isArray(will.milestones) ? will.milestones : [],
      ...(typeof common.version === 'string' ? { version: common.version } : {}),
    },
    { commands: new Set(), guideSections: new Set(), settings: new Map() },
  );
  if (!properties) return undefined;
  return JSON.stringify({
    api_key: will.projectKey,
    batch: [
      {
        event: 'uninstalled',
        distinct_id: will.id,
        timestamp: new Date(Math.floor(now / 60_000) * 60_000).toISOString(),
        properties: { ...kept, ...properties, $process_person_profile: false, $geoip_disable: true },
      },
    ],
  });
}

function send(body: string): Promise<void> {
  return new Promise((resolve) => {
    const req = request(
      `${USAGE_HOST}/batch/`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 5000 },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', () => resolve());
    req.on('timeout', () => req.destroy());
    req.end(body);
  });
}

async function main(): Promise<void> {
  let will: Will;
  try {
    will = JSON.parse(readFileSync(join(__dirname, '..', WILL_FILE), 'utf8')) as Will;
  } catch {
    return;
  }
  const body = uninstallBatch(will, process.env, Date.now());
  if (body) await send(body);
}

if (require.main === module) void main();
