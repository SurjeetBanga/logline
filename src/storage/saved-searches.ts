import { randomBytes } from 'node:crypto';

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  levels?: string[];
  serverId?: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface SearchStorage {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void> | void;
}
export class SavedSearches {
  private savedSearchCache?: SavedSearch[];
  constructor(private readonly state: SearchStorage) { }
  private stateGet<T>(key: string, fallback: T): T {
    try { return this.state.get<T>(key, fallback); } catch { return fallback; }
  }

  private stateUpdate(key: string, value: unknown): void {
    try { void Promise.resolve(this.state.update(key, value)).catch(() => { }); } catch { /* tests and restricted hosts may have no state store */ }
  }

  savedSearches(): SavedSearch[] {
    if (this.savedSearchCache) return this.savedSearchCache;
    const value = this.stateGet<unknown>('logline.savedSearches', []);
    const valid = (item: unknown): item is SavedSearch => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const search = item as Partial<SavedSearch>;
      return typeof search.id === 'string' && typeof search.name === 'string' && typeof search.query === 'string'
        && (search.serverId === undefined || typeof search.serverId === 'string')
        && (search.levels === undefined || (Array.isArray(search.levels)
          && search.levels.every(level => ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unclassified'].includes(level))));
    };
    this.savedSearchCache = Array.isArray(value) ? value.filter(valid).slice(0, 50).map(search => ({ ...search,
      name: search.name.slice(0, 80), query: search.query.slice(0, 256),
      createdAt: Number.isFinite(search.createdAt) ? search.createdAt : 0,
      lastUsedAt: Number.isFinite(search.lastUsedAt) ? search.lastUsedAt : 0
    })) : [];
    return this.savedSearchCache;
  }

  saveSearch(name: string | undefined, query: string, levels?: string[], serverId?: string): SavedSearch | undefined {
    query = query.trim().slice(0, 256);
    if (!query && !serverId && levels === undefined) return undefined;
    const now = Date.now();
    const search: SavedSearch = { id: randomBytes(8).toString('hex'), name: (name?.trim() || query || serverId || 'Search').slice(0, 80), query, levels, serverId, createdAt: now, lastUsedAt: now };
    const levelKey = (value?: string[]) => value === undefined ? undefined : JSON.stringify([...new Set(value)].sort());
    const selectedLevels = levelKey(levels);
    this.savedSearchCache = [search, ...this.savedSearches().filter(item => item.query !== query || item.serverId !== serverId
      || levelKey(item.levels) !== selectedLevels)].slice(0, 50);
    this.stateUpdate('logline.savedSearches', this.savedSearchCache);
    return search;
  }

  deleteSavedSearch(id: string): void { this.savedSearchCache = this.savedSearches().filter(item => item.id !== id); this.stateUpdate('logline.savedSearches', this.savedSearchCache); }
}
