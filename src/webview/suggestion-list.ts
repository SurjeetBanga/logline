import type { EventScope } from './event-scope';

export interface Suggestion {
  /** What picking it puts in the box. */
  value: string;
  /** What its row shows, the value unless given. */
  label?: string;
  /** A note at the row's end, such as how many logs it had. */
  detail?: string;
}

export interface SuggestionList {
  /**
   * Show these suggestions under the box, keeping the highlighted one if it is among them and else none; none
   * closes the list.
   */
  show(items: Suggestion[]): void;
  hide(): void;
  /** Whether the list is showing. */
  open(): boolean;
  /**
   * A key pressed in the box: the arrow keys move the highlight, Enter picks the highlighted suggestion, and
   * Escape closes the list. True when the key was used, and its default prevented.
   */
  keydown(event: KeyboardEvent): boolean;
}

const MAX_HEIGHT = 240;
const MIN_HEIGHT = 72;
const MIN_WIDTH = 280;
const GUTTER = 8;

/**
 * A box's suggestions, drawn by the panel rather than left to the browser, whose suggestion list in a VS Code
 * webview ignores the arrow keys and Enter. The list is placed in the window, under the box or above it when
 * there is more room there, so a box in a container that scrolls or clips does not cut it off.
 */
export function createSuggestionList(
  input: HTMLInputElement,
  list: HTMLElement,
  scope: EventScope,
  options: {
    /** A suggestion was clicked, or highlighted and Enter pressed. The list is closed already. */
    pick(item: Suggestion): void;
    /** An arrow key was pressed with the list closed: show what there is to choose from. */
    reveal?(): void;
    /** What the list lines up with, the box unless given. */
    anchor?: HTMLElement;
  },
): SuggestionList {
  let items: Suggestion[] = [];
  let active = -1;
  const anchor = options.anchor ?? input;
  const id = (index: number) => `${input.id}-${index}`;
  input.setAttribute('aria-expanded', 'false');

  function render(): void {
    list.replaceChildren(
      ...items.map((item, index) => {
        const row = document.createElement('li');
        row.id = id(index);
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');
        row.dataset.index = String(index);
        const label = document.createElement('span');
        label.className = 'suggestion-label';
        label.textContent = item.label ?? item.value;
        row.append(label);
        if (item.detail !== undefined) {
          const detail = document.createElement('span');
          detail.className = 'suggestion-detail';
          detail.textContent = item.detail;
          row.append(detail);
        }
        return row;
      }),
    );
    list.hidden = !items.length;
    input.setAttribute('aria-expanded', String(items.length > 0));
    if (items.length) place();
    highlight();
  }

  function highlight(): void {
    list.children[active]?.scrollIntoView({ block: 'nearest' });
    for (const [index, row] of [...list.children].entries())
      row.setAttribute('aria-selected', String(index === active));
    if (active < 0) input.removeAttribute('aria-activedescendant');
    else input.setAttribute('aria-activedescendant', id(active));
  }

  function place(): void {
    const box = anchor.getBoundingClientRect();
    const style = list.style;
    const width = Math.min(Math.max(box.width, MIN_WIDTH), window.innerWidth - 2 * GUTTER);
    const below = window.innerHeight - box.bottom - GUTTER;
    const above = box.top - GUTTER;
    const under = below >= Math.min(MAX_HEIGHT, above);
    style.left = `${Math.max(GUTTER, Math.min(box.left, window.innerWidth - width - GUTTER))}px`;
    style.width = `${width}px`;
    style.top = under ? `${box.bottom + 2}px` : '';
    style.bottom = under ? '' : `${window.innerHeight - box.top + 2}px`;
    style.maxHeight = `${Math.max(Math.min(MAX_HEIGHT, (under ? below : above) - 2), MIN_HEIGHT)}px`;
  }

  function show(next: Suggestion[]): void {
    // A refreshed list keeps the highlighted suggestion while it is still there, so a reply that lands while the
    // arrow keys are in use does not make Enter pick what was typed instead.
    const highlighted = items[active]?.value;
    items = next;
    active = highlighted === undefined ? -1 : items.findIndex((item) => item.value === highlighted);
    render();
  }

  function pick(item: Suggestion | undefined): void {
    if (!item) return;
    show([]);
    options.pick(item);
  }

  function keydown(event: KeyboardEvent): boolean {
    // A key that ends a composition belongs to the input method.
    if (event.isComposing) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!items.length) options.reveal?.();
      if (!items.length) return false;
      event.preventDefault();
      // Up from the first suggestion goes back to what was typed; Down from the last, or Up from there, wraps.
      const last = items.length - 1;
      if (event.key === 'ArrowDown') active = active >= last ? 0 : active + 1;
      else active = active === 0 ? -1 : active < 0 ? last : active - 1;
      highlight();
      return true;
    }
    if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      pick(items[active]);
      return true;
    }
    if (event.key === 'Escape' && items.length) {
      event.preventDefault();
      show([]);
      return true;
    }
    return false;
  }

  // Typing goes back to what is typed, so Enter then takes the text rather than a suggestion highlighted before.
  scope.listen(input, 'input', () => {
    active = -1;
    highlight();
  });
  // Leaving the box closes the list; the window losing focus leaves the box focused within the page, and it open.
  scope.listen(input, 'blur', () => {
    if (document.activeElement !== input) show([]);
  });
  // Pressing a suggestion keeps focus in the box, so leaving it does not close the list before the click lands.
  scope.listen(list, 'mousedown', (event) => event.preventDefault());
  scope.listen(list, 'click', (event) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="option"]');
    if (row) pick(items[Number(row.dataset.index)]);
  });
  // The list stays with the box as the panel resizes or anything holding the box scrolls.
  const follow = () => {
    if (items.length) place();
  };
  scope.listen(window, 'resize', follow);
  scope.listen(document, 'scroll', follow, { capture: true, passive: true });

  return { show, hide: () => show([]), open: () => items.length > 0, keydown };
}
