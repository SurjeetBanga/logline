import type { EventScope } from './event-scope';

/** What the inspector can show: a log event, a trace's waterfall, or one AI call's conversation. */
export type InspectorKind = 'event' | 'trace' | 'aiCall';

export interface InspectorElements {
  inspector: HTMLElement;
  inspectorTitle: HTMLElement;
  inspectorMeta: HTMLElement;
  inspectorNav: HTMLElement;
  inspectorBody: HTMLElement;
  inspectorClose: HTMLButtonElement;
}

export interface InspectorContent {
  title: string;
  /** One line under the title, such as an event's level, time, and source. */
  meta?: string;
  /** Controls beside the title, such as previous and next. */
  nav?: Node[];
  body: Node[];
}

/**
 * The pane beside a list that shows what is selected in it. The list stays in view and keeps
 * updating, so another row can be chosen without going back, and nothing in the list moves when
 * a selection opens.
 *
 * @param changed Runs after the pane opens, changes what it shows, or closes.
 */
export function createInspector(
  elements: InspectorElements,
  scope: EventScope,
  changed: (kind: InspectorKind | undefined) => void = () => undefined,
) {
  let current: { kind: InspectorKind; closed: () => void } | undefined;

  function fill(content: InspectorContent): void {
    elements.inspectorTitle.textContent = content.title;
    elements.inspectorTitle.title = content.title;
    elements.inspectorMeta.textContent = content.meta ?? '';
    elements.inspectorMeta.hidden = !content.meta;
    elements.inspectorNav.replaceChildren(...(content.nav ?? []));
    elements.inspectorBody.replaceChildren(...content.body);
  }

  /**
   * Shows a selection.
   *
   * @param closed Runs when the pane closes or shows another kind of selection, so the list can clear its own.
   */
  function open(kind: InspectorKind, content: InspectorContent, closed: () => void = () => undefined): void {
    const previous = current;
    current = { kind, closed };
    // Another list's selection gives way; the same list choosing another row does not count as closing.
    if (previous && previous.kind !== kind) previous.closed();
    fill(content);
    elements.inspector.hidden = false;
    if (document.body) document.body.dataset.inspector = kind;
    changed(kind);
  }

  /** Replaces what an open selection shows, such as once its details arrive; ignored after it closed. */
  function update(kind: InspectorKind, content: InspectorContent): void {
    if (current?.kind !== kind) return;
    const top = elements.inspectorBody.scrollTop;
    fill(content);
    elements.inspectorBody.scrollTop = top;
  }

  /** Closes the pane; with a kind, only while it shows that kind. */
  function close(kind?: InspectorKind): void {
    if (!current || (kind && current.kind !== kind)) return;
    const { closed } = current;
    current = undefined;
    elements.inspector.hidden = true;
    elements.inspectorNav.replaceChildren();
    elements.inspectorBody.replaceChildren();
    if (document.body) delete document.body.dataset.inspector;
    closed();
    changed(undefined);
  }

  scope.listen(elements.inspectorClose, 'click', () => close());
  scope.listen(elements.inspector, 'keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  });

  return { open, update, close, kind: () => current?.kind };
}
