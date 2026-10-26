import type { FormUpdate } from '../core/connection-form';
import type { ConnectionView } from '../protocol/messages';
import { createConnectionForm } from './connection-form/form';
import type { Elements } from './dom';
import { connectionStatus } from './search/source-rail';
import type { TabRailItem } from './tab-rail';
import type { WebviewApi } from './types';
import { tabOf, type TabName, type ViewName } from './views';

type TabElements = Pick<Elements, 'connectionTab' | 'connectionTabLabel' | 'connectionView'>;

/**
 * The Connection form as a tab of the Logs panel. The tab appears when the
 * extension opens a form, to add a connection or edit one, and goes once the
 * form is saved or cancelled; other tabs can be visited meanwhile without
 * losing what was typed. Its rail lists every connection, to edit or remove
 * another one.
 */
export function createConnectionTab(
  elements: TabElements,
  api: WebviewApi,
  views: {
    show(view: ViewName): void;
    active(): ViewName;
    /** Go back to a tab, loading what it shows, or to Logs if that tab is gone. */
    back(tab: TabName): void;
  },
  rail: (title: string, items: TabRailItem[]) => void,
) {
  const numbers = new Intl.NumberFormat();
  let connections: ConnectionView[] = [];
  /** The connection the open form edits; none while one is added. */
  let editing: string | undefined;
  /** The open form's session, which every message to and from it carries; 0 while none is open. */
  let session = 0;
  let form: ReturnType<typeof createConnectionForm> | undefined;
  /** The tab to go back to when the form closes. */
  let previous: TabName = 'logs';
  // The tab shows only while a form is open.
  elements.connectionTab.hidden = true;

  function open(next: { session: number; title: string; connectionId?: string }): void {
    if (next.session !== session || !form) {
      session = next.session;
      const root = document.createElement('div');
      elements.connectionView.replaceChildren(root);
      form = createConnectionForm(
        { postMessage: (request) => api.postMessage({ type: 'connectionForm', session: next.session, request }) },
        root,
      );
      api.postMessage({ type: 'connectionForm', session, request: { type: 'ready' } });
    }
    elements.connectionTabLabel.textContent = next.title;
    elements.connectionTab.hidden = false;
    editing = next.connectionId;
    renderRail();
    const current = tabOf(views.active());
    if (current !== 'connection') previous = current;
    views.show('connection');
  }

  function renderRail(): void {
    const add = {
      icon: 'add' as const,
      label: 'Add connection',
      onSelect: () => api.postMessage({ type: 'addConnection' }),
    };
    const items: TabRailItem[] = [{ kind: 'group', label: 'Connections', action: add }];
    // The connection being added has no row of its own yet; it shows as New connection until saved.
    if (session && !editing)
      items.push({ kind: 'item', key: '', label: 'New connection', icon: 'add', selected: true, onSelect: () => {} });
    for (const connection of connections) {
      const edit = () => api.postMessage({ type: 'editConnection', connectionId: connection.id });
      items.push({
        kind: 'item',
        key: connection.id,
        label: connection.label,
        status: connectionStatus(connection, (value) => numbers.format(value)),
        icon: connection.type === 'datadog' ? 'cloud' : 'database',
        selected: connection.id === editing,
        title: `Edit ${connection.label}`,
        actions: [
          { icon: 'edit', label: `Edit connection ${connection.label}…`, onSelect: edit },
          {
            icon: 'remove',
            label: `Remove connection ${connection.label}…`,
            onSelect: () => api.postMessage({ type: 'removeConnection', connectionId: connection.id }),
          },
        ],
        onSelect: edit,
      });
    }
    rail('Connections', items);
  }

  function close(): void {
    session = 0;
    editing = undefined;
    form = undefined;
    elements.connectionView.replaceChildren();
    elements.connectionTab.hidden = true;
    if (views.active() === 'connection') views.back(previous);
    renderRail();
  }

  return {
    open,
    /** The saved connections, from each snapshot, for the rail. */
    setConnections(next: ConnectionView[]): void {
      connections = next;
      renderRail();
    },
    /** Ask for a form left open before this view started, which then comes back as its tab. */
    resume(): void {
      api.postMessage({ type: 'connectionForm', session: 0, request: { type: 'resume' } });
    },
    /** An answer for the form; one meant for an earlier form is dropped. */
    receive(message: { session: number; update: FormUpdate }): void {
      if (message.session !== session || !form) return;
      if (message.update.type === 'close') close();
      else form.receive(message.update);
    },
  };
}
