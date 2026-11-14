import type { AboutAction, AboutInfo } from '../protocol/messages';
import type { EventScope } from './event-scope';
import type { WebviewApi } from './types';

export interface AboutElements {
  dialog: HTMLDialogElement;
  close: HTMLButtonElement;
  version: HTMLElement;
  editor: HTMLElement;
  system: HTMLElement;
  buttons: Record<AboutAction, HTMLButtonElement>;
}

/** About Logline, as a dialog in the Logs panel: the version, who made it, and where to go next. */
export function createAboutDialog(elements: AboutElements, api: WebviewApi, scope: EventScope) {
  let info: AboutInfo | undefined;
  scope.listen(elements.close, 'click', () => elements.dialog.close());
  for (const [action, button] of Object.entries(elements.buttons) as [AboutAction, HTMLButtonElement][])
    scope.listen(button, 'click', () => {
      api.postMessage({ type: 'aboutAction', action, ...(action === 'copy' && info ? { info } : {}) });
      if (action === 'copy') {
        button.textContent = 'Copied';
        setTimeout(() => (button.textContent = 'Copy'), 1500);
      }
    });
  return {
    open(next: AboutInfo): void {
      info = next;
      elements.version.textContent = `v${next.version}`;
      elements.editor.textContent = next.editor;
      elements.system.textContent = next.system;
      if (!elements.dialog.open) elements.dialog.showModal?.();
    },
  };
}
