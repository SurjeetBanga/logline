import type { ExceptionBlock } from '../core/exceptions';
import type { DetailLinks } from '../protocol/messages';
import { RANGE_CHOICES, type ConnectionType } from '../core/connections';
import { CONNECTION_KINDS } from '../core/connection-types';
export const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unclassified'];
export interface PersistedState {
  query?: string;
  levels?: string[];
  /** Says that six levels without Unclassified were chosen, rather than saved before it existed. */
  unclassifiedHidden?: boolean;
  server?: string;
  session?: string;
  sort?: string;
  sortDirection?: 'asc' | 'desc';
  extraColumns?: string[];
  columnWidths?: Record<string, number>;
  columnOrder?: string[];
  hiddenColumns?: string[];
  cellHintDismissed?: boolean;
  rowHintDismissed?: boolean;
  /** The first-run welcome is open and not yet answered. */
  welcomeOpen?: boolean;
  /** The tab the panel was left on. */
  view?: string;
  /** The time range searched on connections. */
  range?: string;
  /** A query typed in each kind of connection's own syntax, and whether Run and Tail send it. */
  native?: Partial<Record<string, { query?: string; on?: boolean }>>;
  /** What `native.datadog` was called before other connections had a syntax of their own. */
  datadogQuery?: string;
  datadogSyntax?: boolean;
  /** Whether the Sources rail was collapsed or opened by hand. */
  rail?: 'collapsed' | 'open';
  /** The rails' width in pixels when resized by hand. */
  railWidth?: number;
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
  selectedLinks: DetailLinks = {};
  selectedServer: string;
  selectedSession: string;
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
  /** Newest row at the top; the host setting arrives with each snapshot. */
  newestFirst = true;
  cellHintDismissed: boolean;
  rowHintDismissed: boolean;
  /** The first-run welcome is open and not yet answered, so a rebuilt panel can point to the tour. */
  welcomeOpen: boolean;
  /** The selected tab, kept so the panel reopens on it. */
  view: string;
  /** The time range a connection search covers, such as `1h`. */
  connectionRange: string;
  /** A query in each kind of connection's own syntax, and whether Run and Tail send it as typed. */
  native: Partial<Record<ConnectionType, { query: string; on: boolean }>> = {};
  /** The Sources rail's state when set by hand; undefined follows the panel's width. */
  railCollapsed?: boolean;
  /** The rails' width when resized by hand; undefined keeps the default. */
  railWidth?: number;
  constructor(saved: PersistedState = {}) {
    if (saved.rail === 'collapsed' || saved.rail === 'open') this.railCollapsed = saved.rail === 'collapsed';
    if (typeof saved.railWidth === 'number' && Number.isFinite(saved.railWidth) && saved.railWidth > 0)
      this.railWidth = saved.railWidth;
    this.view = typeof saved.view === 'string' ? saved.view : 'logs';
    this.connectionRange = typeof saved.range === 'string' && RANGE_CHOICES.includes(saved.range) ? saved.range : '1h';
    const native: Partial<Record<string, { query?: unknown; on?: unknown }>> = {
      datadog: { query: saved.datadogQuery, on: saved.datadogSyntax },
      ...saved.native,
    };
    for (const type of Object.keys(CONNECTION_KINDS) as ConnectionType[]) {
      const entry = native[type];
      if (!entry || typeof entry !== 'object') continue;
      const query = typeof entry.query === 'string' ? entry.query.slice(0, 2048) : '';
      if (query || entry.on === true) this.native[type] = { query, on: entry.on === true };
    }
    this.following = !saved.sort;
    this.cellHintDismissed = saved.cellHintDismissed === true;
    this.rowHintDismissed = saved.rowHintDismissed === true;
    this.welcomeOpen = saved.welcomeOpen === true;
    this.selectedServer = saved.server ?? '';
    this.selectedSession = saved.session ?? '';
    this.selectedSort = saved.sort ?? '';
    this.selectedSortDirection = saved.sortDirection === 'asc' ? 'asc' : 'desc';
    this.extraColumns = Array.isArray(saved.extraColumns)
      ? saved.extraColumns.filter((field) => typeof field === 'string')
      : [];
    this.columnWidths = saved.columnWidths && typeof saved.columnWidths === 'object' ? saved.columnWidths : {};
    this.columnOrder = Array.isArray(saved.columnOrder) ? saved.columnOrder : [];
    this.hiddenColumns = new Set(Array.isArray(saved.hiddenColumns) ? saved.hiddenColumns : []);
    const savedLevels = Array.isArray(saved.levels) ? saved.levels.filter((level) => LEVELS.includes(level)) : LEVELS;
    // A pre-1.8 persisted "all levels" preference contained six entries;
    // retain its meaning when Unclassified is added.
    this.checkedLevels = new Set(
      savedLevels.length === 6 && !savedLevels.includes('unclassified') && saved.unclassifiedHidden !== true
        ? LEVELS
        : savedLevels,
    );
  }
  currentLevels(): string[] | undefined {
    return this.checkedLevels.size === LEVELS.length ? undefined : [...this.checkedLevels];
  }
  setFollowing(value: boolean): void {
    this.following = value;
    this.before = value ? undefined : this.newest;
  }
  filterChanged(): void {
    this.page = 0;
    this.lastRows = undefined;
  }
  resetSelection(): void {
    this.selected = undefined;
    this.selectedDetailText = undefined;
    this.selectedExceptions = [];
    this.selectedLinks = {};
  }
  /** Explicit changes close inspection while keeping a fixed history boundary. */
  browseFromInspection(): void {
    if (!this.paused) return;
    this.paused = false;
    this.resetSelection();
    this.following = false;
    this.before ??= this.newest;
    this.lastRows = undefined;
  }
  resume(): void {
    this.paused = false;
    this.resetSelection();
    this.selectedSort = '';
    this.filterChanged();
    this.setFollowing(true);
  }
  inspect(id: number): boolean {
    const opening = this.selected !== id;
    this.resetSelection();
    if (opening) {
      this.selected = id;
      this.paused = true;
      this.before ??= this.newest;
    }
    return opening;
  }
  sort(field: string): void {
    this.selectedSortDirection = this.selectedSort === field && this.selectedSortDirection === 'desc' ? 'asc' : 'desc';
    this.selectedSort = field;
    if (!this.paused) this.setFollowing(false);
    this.filterChanged();
  }
  persist(query: string): PersistedState {
    return {
      query,
      levels: [...this.checkedLevels],
      ...(this.checkedLevels.size === 6 && !this.checkedLevels.has('unclassified') ? { unclassifiedHidden: true } : {}),
      server: this.selectedServer,
      ...(this.selectedSession ? { session: this.selectedSession } : {}),
      sort: this.selectedSort,
      sortDirection: this.selectedSortDirection,
      columnWidths: this.columnWidths,
      columnOrder: this.columnOrder,
      hiddenColumns: [...this.hiddenColumns],
      extraColumns: this.extraColumns,
      ...(this.cellHintDismissed ? { cellHintDismissed: true } : {}),
      ...(this.rowHintDismissed ? { rowHintDismissed: true } : {}),
      ...(this.welcomeOpen ? { welcomeOpen: true } : {}),
      ...(this.view !== 'logs' ? { view: this.view } : {}),
      ...(this.connectionRange !== '1h' ? { range: this.connectionRange } : {}),
      ...(Object.keys(this.native).length ? { native: this.persistedNative() } : {}),
      ...(this.railCollapsed !== undefined ? { rail: this.railCollapsed ? 'collapsed' : 'open' } : {}),
      ...(this.railWidth !== undefined ? { railWidth: this.railWidth } : {}),
    };
  }

  /** The query typed in a kind of connection's own syntax, and whether Run and Tail send it. */
  nativeOf(type: ConnectionType): { query: string; on: boolean } {
    return this.native[type] ?? { query: '', on: false };
  }

  setNative(type: ConnectionType, change: Partial<{ query: string; on: boolean }>): void {
    const next = { ...this.nativeOf(type), ...change };
    if (next.query || next.on) this.native[type] = next;
    else delete this.native[type];
  }

  private persistedNative(): Record<string, { query?: string; on?: boolean }> {
    return Object.fromEntries(
      Object.entries(this.native).map(([type, entry]) => [
        type,
        { ...(entry.query ? { query: entry.query } : {}), ...(entry.on ? { on: true } : {}) },
      ]),
    );
  }
}
