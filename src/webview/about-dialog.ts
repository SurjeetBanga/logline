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

const COPIED_MS = 1500;

/** About Logline, as a dialog in the Logs panel: the version, who made it, and where to go next. */
export function createAboutDialog(elements: AboutElements, api: WebviewApi, scope: EventScope) {
  // Copy reads Copied for a moment; copying again restarts the moment rather than cutting it short.
  let copied: ReturnType<typeof setTimeout> | undefined;
  scope.track(() => clearTimeout(copied));
  scope.listen(elements.close, 'click', () => elements.dialog.close());
  for (const [action, button] of Object.entries(elements.buttons) as [AboutAction, HTMLButtonElement][])
    scope.listen(button, 'click', () => {
      // The host copies the details it showed, rather than whatever the panel sends back.
      api.postMessage({ type: 'aboutAction', action });
      if (action === 'copy') {
        button.textContent = 'Copied';
        clearTimeout(copied);
        copied = setTimeout(() => {
          copied = undefined;
          button.textContent = 'Copy';
        }, COPIED_MS);
      }
    });
  return {
    open(next: AboutInfo): void {
      elements.version.textContent = `v${next.version}`;
      elements.editor.textContent = next.editor;
      elements.system.textContent = next.system;
      if (!elements.dialog.open) elements.dialog.showModal?.();
    },
  };
}
