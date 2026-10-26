import type { EventScope } from './event-scope';
import type { ViewerState } from './state';

export const RAIL_WIDTH = { min: 160, max: 560, default: 236 } as const;
const STEP = 16;

/** The widest the rail may be: its maximum, leaving the table at least 240px of the panel. */
function widest(): number {
  return Math.max(RAIL_WIDTH.min, Math.min(RAIL_WIDTH.max, (window.innerWidth || 0) - 240));
}

export function clampRailWidth(width: number): number {
  return Math.round(Math.max(RAIL_WIDTH.min, Math.min(widest(), width)));
}

/**
 * Drag handles on the right edge of the Sources rail and the tabs' rail. Both
 * rails share one width, kept with the panel's state; arrow keys move the edge
 * and a double click puts it back.
 */
export function createRailResize(
  handles: HTMLElement[],
  state: ViewerState,
  scope: EventScope,
  actions: { saveState(): void },
) {
  function apply(): void {
    const width = state.railWidth === undefined ? RAIL_WIDTH.default : clampRailWidth(state.railWidth);
    if (state.railWidth === undefined) document.body.style.removeProperty('--rail-width');
    else document.body.style.setProperty('--rail-width', `${width}px`);
    for (const handle of handles) {
      handle.setAttribute('aria-valuenow', String(width));
      handle.setAttribute('aria-valuemin', String(RAIL_WIDTH.min));
      handle.setAttribute('aria-valuemax', String(widest()));
    }
  }

  function set(width: number | undefined): void {
    state.railWidth = width === undefined ? undefined : clampRailWidth(width);
    apply();
  }

  for (const handle of handles) {
    scope.listen(handle, 'pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      handle.setPointerCapture?.(event.pointerId);
      const startX = event.clientX;
      const startWidth = state.railWidth ?? RAIL_WIDTH.default;
      handle.classList.add('dragging');
      const move = (pointer: PointerEvent) => set(startWidth + pointer.clientX - startX);
      const finish = () => {
        document.removeEventListener?.('pointermove', move);
        document.removeEventListener?.('pointerup', finish);
        document.removeEventListener?.('pointercancel', finish);
        handle.classList.remove('dragging');
        actions.saveState();
      };
      scope.listen(document, 'pointermove', move);
      scope.listen(document, 'pointerup', finish, { once: true });
      scope.listen(document, 'pointercancel', finish, { once: true });
      event.preventDefault?.();
    });
    scope.listen(handle, 'dblclick', () => {
      set(undefined);
      actions.saveState();
    });
    scope.listen(handle, 'keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const step = event.shiftKey ? STEP * 3 : STEP;
      set((state.railWidth ?? RAIL_WIDTH.default) + (event.key === 'ArrowLeft' ? -step : step));
      actions.saveState();
    });
  }
  // A width that fit a wide panel is narrowed with it, without forgetting the choice.
  scope.listen(window, 'resize', apply);
  apply();
  return { apply };
}
