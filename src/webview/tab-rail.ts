import type { Elements } from './dom';
import type { EventScope } from './event-scope';
import { NARROW_PANEL } from './search/source-rail';
import type { ViewerState } from './state';

/** A row in a tab's rail: a heading, or a filter that is chosen, or turned on and off. */
export type TabRailItem =
  | { kind: 'group'; label: string }
  | {
      kind: 'item';
      key: string;
      label: string;
      meta?: string;
      /** A color, such as a service's, shown as a swatch. */
      color?: string;
      /** A filter turned on and off, shown as a check box; otherwise one choice among the rest. */
      checked?: boolean;
      selected?: boolean;
      title?: string;
      onSelect(): void;
    };

type RailElements = Pick<Elements, 'tabRail' | 'tabRailTitle' | 'tabRailList' | 'tabRailToggle'>;

/**
 * The rail beside Compare, Traces, and Metrics: what that tab shows, such as
 * error statuses or services, the way the Sources rail scopes Logs. It shares
 * the Sources rail's collapsed state, so collapsing either collapses both.
 */
export function createTabRail(
  elements: RailElements,
  state: ViewerState,
  scope: EventScope,
  actions: { saveState(): void; collapsedChanged(): void },
) {
  const contents = new Map<string, { title: string; items: TabRailItem[] }>();
  let active = '';
  let signature = '';
  const handlers = new Map<string, () => void>();

  function collapsed(): boolean {
    return state.railCollapsed ?? window.innerWidth < NARROW_PANEL;
  }

  function applyCollapsed(): void {
    const value = collapsed();
    elements.tabRail.classList[value ? 'add' : 'remove']('collapsed');
    elements.tabRailToggle.setAttribute('aria-expanded', String(!value));
    const label = value ? 'Expand filters' : 'Collapse filters';
    elements.tabRailToggle.setAttribute('aria-label', label);
    elements.tabRailToggle.title = label;
  }

  function row(item: Extract<TabRailItem, { kind: 'item' }>): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = `rail-row${item.selected ? ' selected' : ''}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rail-select rail-focusable';
    button.dataset.railKey = item.key;
    button.title = item.title ?? `${item.label}${item.meta ? ` · ${item.meta}` : ''}`;
    if (item.checked !== undefined) button.setAttribute('aria-pressed', String(item.checked));
    else button.setAttribute('aria-current', String(Boolean(item.selected)));
    const glyph = document.createElement('span');
    glyph.className = 'rail-glyph';
    if (item.checked !== undefined) {
      const check = document.createElement('span');
      check.className = `rail-check${item.checked ? ' on' : ''}`;
      check.setAttribute('aria-hidden', 'true');
      glyph.append(check);
    } else {
      // A filter without a color still has an initial, for the collapsed rail.
      const swatch = document.createElement('span');
      swatch.className = item.color ? 'rail-swatch' : 'rail-initial';
      if (item.color) swatch.style.background = item.color;
      else
        swatch.textContent = item.label
          .replace(/[^A-Za-z0-9]/g, '')
          .slice(0, 2)
          .toUpperCase();
      glyph.append(swatch);
    }
    if (item.checked !== undefined && item.color) {
      const swatch = document.createElement('span');
      swatch.className = 'rail-swatch';
      swatch.style.background = item.color;
      glyph.append(swatch);
    }
    const text = document.createElement('span');
    text.className = 'rail-text';
    const name = document.createElement('span');
    name.className = 'rail-name';
    name.textContent = item.label;
    text.append(name);
    button.append(glyph, text);
    if (item.meta) {
      const meta = document.createElement('span');
      meta.className = 'rail-meta';
      meta.textContent = item.meta;
      button.append(meta);
    }
    handlers.set(item.key, item.onSelect);
    scope.listen(button, 'click', () => handlers.get(item.key)?.());
    wrapper.append(button);
    return wrapper;
  }

  function render(): void {
    const content = contents.get(active);
    elements.tabRail.hidden = !content;
    if (!content) return;
    // Handlers change with each render; only the rows wait for something new to show.
    for (const item of content.items) if (item.kind === 'item') handlers.set(item.key, item.onSelect);
    const next = JSON.stringify([active, content.title, content.items]);
    if (next === signature) return;
    signature = next;
    const focused = (document.activeElement as HTMLElement | undefined)?.dataset?.railKey;
    elements.tabRailTitle.textContent = content.title;
    elements.tabRailList.replaceChildren(
      ...content.items.map((item) => {
        if (item.kind === 'item') return row(item);
        const heading = document.createElement('div');
        heading.className = 'rail-group';
        const label = document.createElement('span');
        label.className = 'rail-group-label';
        label.textContent = item.label;
        heading.append(label);
        return heading;
      }),
    );
    if (focused)
      [...elements.tabRailList.querySelectorAll<HTMLElement>('.rail-focusable')]
        .find((node) => node.dataset.railKey === focused)
        ?.focus();
  }

  scope.listen(elements.tabRailToggle, 'click', () => {
    state.railCollapsed = !collapsed();
    applyCollapsed();
    actions.saveState();
    actions.collapsedChanged();
  });
  scope.listen(elements.tabRailList, 'keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...elements.tabRailList.querySelectorAll<HTMLElement>('.rail-focusable')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    items[(index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length].focus();
  });
  scope.listen(window, 'resize', () => {
    if (state.railCollapsed === undefined) applyCollapsed();
  });
  applyCollapsed();

  return {
    /** A tab's rail: shown while that tab is. */
    set(tab: string, title: string, items: TabRailItem[]): void {
      contents.set(tab, { title, items });
      if (tab === active) render();
    },
    /** The tab shown changed. */
    show(tab: string): void {
      active = tab;
      render();
    },
    applyCollapsed,
  };
}
