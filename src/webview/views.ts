import type { EventScope } from './event-scope';

/**
 * The views of the Logs panel. The Traces tab shows either the list (`traces`)
 * or one trace (`trace`), and the AI calls tab its list (`aiCalls`) or one call (`aiCall`).
 */
export type ViewName =
  'logs' | 'analysis' | 'compare' | 'traces' | 'trace' | 'metrics' | 'aiCalls' | 'aiCall' | 'doctor';
/** A view with its own tab, which is what the panel remembers between sessions. */
export type TabName = Exclude<ViewName, 'trace' | 'aiCall'>;

// Log views (production compared with local runs among them), then request-level telemetry (traces and
// the AI calls inside them link to each other), then aggregate metrics, then the health of the logging itself.
const TABS: readonly TabName[] = ['logs', 'analysis', 'compare', 'traces', 'aiCalls', 'metrics', 'doctor'];

export function isTabName(value: unknown): value is TabName {
  return typeof value === 'string' && (TABS as readonly string[]).includes(value);
}

export function tabOf(view: ViewName): TabName {
  return view === 'trace' ? 'traces' : view === 'aiCall' ? 'aiCalls' : view;
}

/**
 * The tab strip over the Logs panel. Each tab shows one view in place of the
 * table, so a new view adds a tab rather than another toolbar button. Tabs
 * follow the ARIA tabs pattern: the selected tab is the only one in the tab
 * order, and arrow keys, Home, and End move between the visible tabs.
 *
 * @param activate Opens a view chosen from its tab, so the viewer can load its data.
 * @param changed Runs after the shown view changes.
 */
export function createViews(
  tabs: Record<TabName, HTMLElement>,
  panels: Record<ViewName, HTMLElement>,
  scope: EventScope,
  activate: (tab: TabName) => void,
  changed: (view: ViewName, previous: ViewName) => void,
) {
  let current: ViewName = 'logs';

  function show(view: ViewName, focus = false) {
    const previous = current;
    current = view;
    for (const name of Object.keys(panels) as ViewName[]) panels[name].hidden = name !== view;
    const selected = tabOf(view);
    for (const name of TABS) {
      tabs[name].setAttribute('aria-selected', String(name === selected));
      tabs[name].tabIndex = name === selected ? 0 : -1;
    }
    // Lets the stylesheet hide controls that only apply to the table, such as paging.
    if (document.body) document.body.dataset.view = selected;
    if (focus) tabs[selected].focus();
    if (view !== previous) changed(view, previous);
  }

  /** Leaves a view whose tab was hidden, such as Metrics before any metric arrived. */
  function ensureVisible() {
    if (tabs[tabOf(current)].hidden) show('logs');
  }

  for (const name of TABS) {
    scope.listen(tabs[name], 'click', () => activate(name));
    scope.listen(tabs[name], 'keydown', (event) => {
      const visible = TABS.filter((tab) => !tabs[tab].hidden);
      const index = visible.indexOf(name);
      const next =
        event.key === 'ArrowRight'
          ? visible[(index + 1) % visible.length]
          : event.key === 'ArrowLeft'
            ? visible[(index - 1 + visible.length) % visible.length]
            : event.key === 'Home'
              ? visible[0]
              : event.key === 'End'
                ? visible[visible.length - 1]
                : undefined;
      if (!next) return;
      event.preventDefault();
      activate(next);
      tabs[next].focus();
    });
  }

  return { show, ensureVisible, active: () => current, available: (tab: TabName) => !tabs[tab].hidden };
}
