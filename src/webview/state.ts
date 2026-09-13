import type { ExceptionBlock } from '../core/exceptions';
export const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
export interface PersistedState {
  query?: string; levels?: string[]; server?: string; sort?: string; sortDirection?: 'asc' | 'desc';
  extraColumns?: string[]; columnWidths?: Record<string, number>; columnOrder?: string[]; hiddenColumns?: string[];
}
/** Persistent preferences and interaction state, independent of DOM rendering. */
export class ViewerState {
  paused = false;
  following: boolean;
  page = 0;
  pages = 1;
  newest = 0;
  before?: number;
  generation?: number;
  lastRows?: string;
  selected?: number;
  selectedDetailText?: string;
  selectedExceptions: ExceptionBlock[] = [];
  selectedServer: string;
  selectedSort: string;
  selectedSortDirection: 'asc' | 'desc';
  allFields: string[] = [];
  columnFields: string[] = [];
  extraColumns: string[];
  columnWidths: Record<string, number>;
  columnOrder: string[];
  hiddenColumns: Set<string>;
  checkedLevels: Set<string>;
  displayTimezone = 'local';
  constructor(saved: PersistedState = {}) {
    this.following = !saved.sort;
    this.selectedServer = saved.server ?? '';
    this.selectedSort = saved.sort ?? '';
    this.selectedSortDirection = saved.sortDirection === 'asc' ? 'asc' : 'desc';
    this.extraColumns = Array.isArray(saved.extraColumns) ? saved.extraColumns.filter(field => typeof field === 'string') : [];
    this.columnWidths = saved.columnWidths && typeof saved.columnWidths === 'object' ? saved.columnWidths : {};
    this.columnOrder = Array.isArray(saved.columnOrder) ? saved.columnOrder : [];
    this.hiddenColumns = new Set(Array.isArray(saved.hiddenColumns) ? saved.hiddenColumns : []);
    this.checkedLevels = new Set(Array.isArray(saved.levels) ? saved.levels : LEVELS);
  }
  currentLevels(): string[] | undefined { return this.checkedLevels.size === LEVELS.length ? undefined : [...this.checkedLevels]; }
  setFollowing(value: boolean): void { this.following = value; this.before = value ? undefined : this.newest; }
  filterChanged(): void { this.page = 0; this.lastRows = undefined; }
  resetSelection(): void { this.selected = undefined; this.selectedDetailText = undefined; this.selectedExceptions = []; }
  resume(): void {
    this.paused = false; this.resetSelection(); this.selectedSort = ''; this.filterChanged(); this.setFollowing(true);
  }
  inspect(id: number): boolean {
    const opening = this.selected !== id;
    this.resetSelection();
    if (opening) { this.selected = id; this.paused = true; }
    return opening;
  }
  sort(field: string): void {
    this.selectedSortDirection = this.selectedSort === field && this.selectedSortDirection === 'desc' ? 'asc' : 'desc';
    this.selectedSort = field; this.setFollowing(false); this.filterChanged();
  }
  persist(query: string): PersistedState {
    return {
      query, levels: [...this.checkedLevels], server: this.selectedServer, sort: this.selectedSort,
      sortDirection: this.selectedSortDirection, columnWidths: this.columnWidths, columnOrder: this.columnOrder,
      hiddenColumns: [...this.hiddenColumns], extraColumns: this.extraColumns
    };
  }
}
