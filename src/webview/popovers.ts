import { EventScope } from './event-scope';
export interface Popover { container: HTMLElement; isOpen(): boolean; close(restoreFocus?: boolean): void; open(): void; }
export function createPopovers(scope: EventScope) {
  // A handful of toolbar buttons open a small panel (level filter, search
  // syntax help). Only one is open at a time, and clicking outside or pressing
  // Escape closes whichever is open.
  const popovers: Popover[] = [];

  function createPopover(container: HTMLElement, button: HTMLElement, panel: HTMLElement) {
    const api = {
      isOpen: () => !panel.hidden,
      close(restoreFocus = false) {
        panel.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        if (restoreFocus)
          button.focus();
      },
      open() {
        for (const other of popovers)
          if (other !== api)
            other.close();
        panel.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        // Keep menus inside the panel even when their trigger wraps to a new row.
        panel.style.left = '0px';
        panel.style.top = '';
        panel.style.bottom = '';
        panel.style.maxHeight = '';
        panel.style.position = '';
        // The search toolbar is horizontally scrollable so its controls stay
        // on one row. Any absolutely positioned menu inside that scroller is
        // clipped to the toolbar's height, which makes All levels and Saved
        // searches appear not to open. Anchor every toolbar menu to the
        // viewport so it can escape that clipping layer.
        if (panel.classList.contains('fields-panel') || panel.classList.contains('cheat-sheet')
          || panel.classList.contains('level-menu') || panel.classList.contains('saved-searches')
          || panel.classList.contains('actions-menu') || panel.classList.contains('session-menu')
          || panel.classList.contains('scope-menu')) {
          const trigger = button.getBoundingClientRect();
          const margin = 8;
          const spaceBelow = window.innerHeight - trigger.bottom - margin;
          const spaceAbove = trigger.top - margin;
          const openAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
          const maxHeight = Math.max(0, openAbove ? spaceAbove : spaceBelow);
          panel.style.position = 'fixed';
          // The syntax trigger lives at the right edge of the search input.
          // Align a wide panel to that edge so it expands back over the input
          // rather than appearing to hang from a small button. Clamp the
          // result for narrow docked panels where the preferred edge cannot
          // fit on screen.
          const panelWidth = panel.getBoundingClientRect().width;
          const maxLeft = Math.max(margin, window.innerWidth - margin - panelWidth);
          const preferredLeft = trigger.right - panelWidth;
          panel.style.left = `${Math.max(margin, Math.min(preferredLeft, maxLeft))}px`;
          panel.style.top = openAbove ? `${margin}px` : `${trigger.bottom + 4}px`;
          panel.style.bottom = openAbove ? `${window.innerHeight - trigger.top + 4}px` : '';
          panel.style.maxHeight = `${maxHeight}px`;
          return;
        }
        const bounds = panel.getBoundingClientRect();
        if (Number.isFinite(bounds.left) && Number.isFinite(window.innerWidth)) {
          panel.style.left = `${Math.max(14 - bounds.left, Math.min(0, window.innerWidth - 14 - bounds.right))}px`;
        }
        // A panel that runs past the bottom of a short viewport (e.g. a docked
        // VS Code panel) would otherwise grow the document's scroll area,
        // shrinking the viewport width and shifting the whole layout. Flip it
        // above the trigger when there's more room there, and cap its height
        // to whichever side it lands on so it always fits without scrolling
        // the page.
        const margin = 8;
        // No lower floor: the panel must always fit fully on screen (its own
        // overflow-y handles the rest), otherwise a forced minimum here would
        // push it past the opposite edge in a very short viewport.
        const cap = (value: number) => Math.max(0, Math.min(value, window.innerHeight * 0.65));
        const spaceBelow = window.innerHeight - bounds.bottom - margin;
        const spaceAbove = button.getBoundingClientRect().top - margin;
        if (spaceBelow < 80 && spaceAbove > spaceBelow) {
          panel.style.top = '';
          panel.style.bottom = 'calc(100% + 4px)';
          panel.style.maxHeight = `${cap(spaceAbove)}px`;
        }
        else {
          panel.style.maxHeight = `${cap(spaceBelow)}px`;
        }
      }
    };
    scope.listen(button, 'click', event => {
      event.stopPropagation();
      api.isOpen() ? api.close() : api.open();
    });
    popovers.push({ container, ...api });
    return api;
  }

  scope.listen(document, 'click', event => {
    for (const popover of popovers)
      if (popover.isOpen() && !popover.container.contains(event.target as Node))
        popover.close();
  });

  scope.listen(document, 'keydown', event => {
    if (event.key !== 'Escape')
      return;
    for (const popover of popovers)
      if (popover.isOpen())
        popover.close(true);
  });

  scope.listen(window, 'resize', () => {
    for (const popover of popovers)
      popover.close();
  });
  return { popovers, createPopover };
}
