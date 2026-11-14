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
 * The inspector's width: wide enough for a stack trace, and never so wide the
 * list beside it is lost. Until one is chosen the stylesheet sizes it, so its
 * drawn width is where a drag or an arrow key starts; the default is only for
 * an inspector that is not drawn.
 */
export const INSPECTOR_WIDTH = { min: 280, max: 900, default: 440 } as const;
/** The room the list beside the inspector always keeps. */
const LIST_ROOM = 320;

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
  return createEdgeResize(
    {
      handles,
      variable: '--rail-width',
      bounds: RAIL_WIDTH,
      widest,
      grows: 1,
      get: () => state.railWidth,
      set: (width) => (state.railWidth = width),
      saveState: actions.saveState,
    },
    scope,
  );
}

/** The drag handle on the inspector's left edge; its width is kept with the panel's state like the rails'. */
export function createInspectorResize(
  handle: HTMLElement,
  inspector: HTMLElement,
  state: ViewerState,
  scope: EventScope,
  actions: { saveState(): void },
) {
  return createEdgeResize(
    {
      handles: [handle],
      variable: '--inspector-width',
      bounds: INSPECTOR_WIDTH,
      // The list beside it keeps at least 320px of the space the two share,
      // which leaves out the rails beside them.
      widest: () => {
        const shared = inspector.parentElement?.getBoundingClientRect().width || window.innerWidth || 0;
        return Math.max(INSPECTOR_WIDTH.min, Math.min(INSPECTOR_WIDTH.max, shared - LIST_ROOM));
      },
      drawn: () => (inspector.hidden ? undefined : inspector.getBoundingClientRect().width || undefined),
      grows: -1,
      get: () => state.inspectorWidth,
      set: (width) => (state.inspectorWidth = width),
      saveState: actions.saveState,
    },
    scope,
  );
}

interface EdgeResize {
  handles: HTMLElement[];
  /** The custom property on the body that carries the width. */
  variable: string;
  bounds: { min: number; max: number; default: number };
  widest(): number;
  /** The pane's drawn width, used while no width is chosen and the stylesheet sizes it. */
  drawn?(): number | undefined;
  /** 1 when dragging right widens the pane, -1 when dragging left does. */
  grows: 1 | -1;
  get(): number | undefined;
  set(width: number | undefined): void;
  saveState(): void;
}

function createEdgeResize(edge: EdgeResize, scope: EventScope) {
  const { handles, bounds } = edge;
  const clamp = (width: number) => Math.round(Math.max(bounds.min, Math.min(edge.widest(), width)));
  /** The width on screen: the chosen one, or else what the stylesheet drew. */
  const current = () => clamp(edge.get() ?? edge.drawn?.() ?? bounds.default);
  function apply(): void {
    const chosen = edge.get();
    const width = current();
    if (chosen === undefined) document.body.style.removeProperty(edge.variable);
    else document.body.style.setProperty(edge.variable, `${width}px`);
    for (const handle of handles) {
      handle.setAttribute('aria-valuenow', String(width));
      handle.setAttribute('aria-valuemin', String(bounds.min));
      handle.setAttribute('aria-valuemax', String(edge.widest()));
    }
  }

  function set(width: number | undefined): void {
    edge.set(width === undefined ? undefined : clamp(width));
    apply();
  }

  for (const handle of handles) {
    scope.listen(handle, 'pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      handle.setPointerCapture?.(event.pointerId);
      const startX = event.clientX;
      const startWidth = current();
      handle.classList.add('dragging');
      const move = (pointer: PointerEvent) => set(startWidth + (pointer.clientX - startX) * edge.grows);
      const finish = () => {
        document.removeEventListener?.('pointermove', move);
        document.removeEventListener?.('pointerup', finish);
        document.removeEventListener?.('pointercancel', finish);
        handle.classList.remove('dragging');
        edge.saveState();
      };
      scope.listen(document, 'pointermove', move);
      scope.listen(document, 'pointerup', finish, { once: true });
      scope.listen(document, 'pointercancel', finish, { once: true });
      event.preventDefault?.();
    });
    scope.listen(handle, 'dblclick', () => {
      set(undefined);
      edge.saveState();
    });
    scope.listen(handle, 'keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const step = (event.shiftKey ? STEP * 3 : STEP) * edge.grows;
      set(current() + (event.key === 'ArrowLeft' ? -step : step));
      edge.saveState();
    });
  }
  // The drawn width may have changed since the last apply, as when the pane was hidden then.
  for (const handle of handles) scope.listen(handle, 'focus', apply);
  // A width that fit a wide panel is narrowed with it, without forgetting the choice.
  scope.listen(window, 'resize', apply);
  apply();
  return { apply };
}
