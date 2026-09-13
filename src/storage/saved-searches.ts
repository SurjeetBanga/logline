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
    this.savedSearchCache = Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && typeof (item as SavedSearch).id === 'string') as SavedSearch[] : [];
    return this.savedSearchCache;
  }

  saveSearch(name: string | undefined, query: string, levels?: string[], serverId?: string): SavedSearch | undefined {
    query = query.trim().slice(0, 256);
    if (!query && !serverId) return undefined;
    const now = Date.now();
    const search: SavedSearch = { id: randomBytes(8).toString('hex'), name: (name?.trim() || query || serverId || 'Search').slice(0, 80), query, levels, serverId, createdAt: now, lastUsedAt: now };
    this.savedSearchCache = [search, ...this.savedSearches().filter(item => item.query !== query || item.serverId !== serverId)].slice(0, 50);
    this.stateUpdate('logline.savedSearches', this.savedSearchCache);
    return search;
  }

  deleteSavedSearch(id: string): void { this.savedSearchCache = this.savedSearches().filter(item => item.id !== id); this.stateUpdate('logline.savedSearches', this.savedSearchCache); }
}
