import { createViewer } from './viewer';

const api = acquireVsCodeApi();
// A failure in the panel's own script is counted once, by kind only: never its message or stack.
let reported = false;
const failed = () => {
  if (reported) return;
  reported = true;
  api.postMessage({ type: 'panelError' });
};
window.addEventListener('error', failed);
window.addEventListener('unhandledrejection', failed);
createViewer(api);
