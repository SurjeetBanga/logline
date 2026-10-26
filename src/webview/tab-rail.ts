import type { Elements } from './dom';
import type { EventScope } from './event-scope';
import { icon, NARROW_PANEL } from './search/source-rail';
import type { ViewerState } from './state';

/** A button on a rail row or heading, such as Edit or Remove, shown with an icon from the Sources rail. */
export interface TabRailAction {
  icon: 'add' | 'edit' | 'remove';
  label: string;
  onSelect(): void;
}

/** A row in a tab's rail: a heading, or a filter that is chosen, or turned on and off. */
export type TabRailItem =
  | { kind: 'group'; label: string; action?: TabRailAction }
  | {
      kind: 'item';
      key: string;
      label: string;
      /** A second line under the label, such as what a connection is doing. */
      status?: string;
      meta?: string;
      /** A color, such as a service's, shown as a swatch. */
      color?: string;
      /** An icon from the Sources rail, such as `all` or `database`, for a row without a color. */
      icon?: string;
      /** A filter turned on and off, shown as a check box; otherwise one choice among the rest. */
      checked?: boolean;
      selected?: boolean;
      title?: string;
      actions?: TabRailAction[];
      onSelect(): void;
    };

type RailElements = Pick<Elements, 'tabRail' | 'tabRailTitle' | 'tabRailList' | 'tabRailToggle'>;

/**
 * The rail beside Compare, Traces, Metrics, and the Connection tab: what that
 * tab shows, such as error statuses, services, or the saved connections, the
 * way the Sources rail scopes Logs. It shares
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

  /** A row's or heading's button, which finds its handler by key so a render with new handlers keeps it. */
  function actionButton(key: string, action: TabRailAction): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `rail-action rail-${action.icon}`;
    button.setAttribute('aria-label', action.label);
    button.title = action.label;
    button.append(icon(action.icon, 13));
    handlers.set(key, action.onSelect);
    scope.listen(button, 'click', (event) => {
      event.stopPropagation();
      handlers.get(key)?.();
    });
    return button;
  }

  /** Every handler of the rail's rows, headings, and their buttons, by key. */
  function setHandlers(items: TabRailItem[]): void {
    for (const item of items) {
      if (item.kind === 'group') {
        if (item.action) handlers.set(`group:${item.label}`, item.action.onSelect);
        continue;
      }
      handlers.set(item.key, item.onSelect);
      for (const action of item.actions ?? []) handlers.set(`${item.key}:${action.icon}`, action.onSelect);
    }
  }

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
    } else if (item.icon && !item.color) {
      const symbol = icon(item.icon, 13);
      symbol.classList.add('rail-item-icon');
      glyph.append(symbol);
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
    if (item.status) {
      const status = document.createElement('span');
      status.className = 'rail-status';
      status.textContent = item.status;
      text.append(status);
    }
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
    if (item.actions?.length) {
      wrapper.classList.add('has-actions');
      const group = document.createElement('span');
      group.className = 'rail-actions';
      group.append(...item.actions.map((action) => actionButton(`${item.key}:${action.icon}`, action)));
      wrapper.append(group);
    }
    return wrapper;
  }

  function render(): void {
    const content = contents.get(active);
    elements.tabRail.hidden = !content;
    if (!content) return;
    // Handlers change with each render; only the rows wait for something new to show.
    setHandlers(content.items);
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
        if (item.action) heading.append(actionButton(`group:${item.label}`, item.action));
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
