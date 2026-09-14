/** Read current settings at use time, so live configuration changes apply. */
export interface Settings { get<T>(key: string, fallback: T): T; }

const LIMITS: Record<string, [number, number]> = {
  indentation: [1, 8], maxEvents: [1000, 1000000], maxMemoryMb: [10, 2048],
  refreshIntervalMs: [100, 5000], maxLineLength: [1024, 1048576], maxDiskMb: [10, 10240]
};
const INTEGERS = new Set(['indentation', 'maxEvents', 'refreshIntervalMs', 'maxLineLength']);

/** Normalize settings once at the host boundary; never mutate the source value. */
export function normalizeSetting(key: string, value: unknown, fallback: unknown): unknown {
  const limits = Object.hasOwn(LIMITS, key) ? LIMITS[key] : undefined;
  if (limits) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(limits[0], Math.min(limits[1], INTEGERS.has(key) ? Math.floor(value) : value));
  }
  if (key === 'source') return ['both', 'stdout', 'stderr'].includes(value as string) ? value : fallback;
  if (key === 'timezone') return ['local', 'utc'].includes(value as string) ? value : fallback;
  if (key === 'servers') return normalizeServers(value);
  if (key === 'columns' || key === 'redactionFields') {
    if (!Array.isArray(value)) return fallback;
    const values = [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
    return key === 'columns' ? values.slice(0, 200) : values;
  }
  return typeof value === typeof fallback ? value : fallback;
}

export function normalizeServers(value: unknown): import('./types').ServerConfig[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const { id, label, command } = item;
    if (![id, label, command].every(value => typeof value === 'string' && value.trim()) || seen.has(id)) return [];
    seen.add(id);
    return [{ id, label, command,
      cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
      env: item.env && typeof item.env === 'object' && !Array.isArray(item.env)
        ? Object.fromEntries(Object.entries(item.env).filter(([, value]) => typeof value === 'string')) as Record<string, string> : undefined,
      autoStart: item.autoStart === true, jsonOnly: item.jsonOnly === true
    }];
  });
}
