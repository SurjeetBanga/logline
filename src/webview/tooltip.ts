import type { EventScope } from './event-scope';

// Long enough that moving the pointer across the panel does not flash tooltips.
const DELAY_MS = 700;
// Once one is showing, the next one along a row of icons follows quickly.
const WARM_DELAY_MS = 150;
const WARM_FOR_MS = 500;
// Tooltips describe controls; longer text belongs in the view it comes from.
const MAX_TEXT = 280;

/**
 * Quick tooltips for anything with a `title`. Native tooltips wait about a
 * second and are easy to miss on small icons, so the title is shown in a
 * styled hover box after a short pause, on pointer hover or keyboard focus.
 * The title moves to `data-tip` while shown so the native one does not also
 * appear, and to `aria-description` so screen readers still read it.
 */
export function createTooltips(scope: EventScope) {
  const body = document.body;
  if (!body) return;
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  body.append(tip);
  scope.track(() => tip.remove());
  let target: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let warmUntil = 0;

  function adopt(element: HTMLElement): string | undefined {
    if (element.title) {
      element.dataset.tip = element.title;
      if (!element.getAttribute('aria-label') && !element.textContent?.trim())
        element.setAttribute('aria-label', element.title);
      else element.setAttribute('aria-description', element.title);
      element.removeAttribute('title');
    }
    return element.dataset.tip;
  }

  function hide() {
    if (!tip.hidden) warmUntil = Date.now() + WARM_FOR_MS;
    clearTimeout(timer);
    timer = undefined;
    target = undefined;
    tip.hidden = true;
  }

  function show(element: HTMLElement) {
    if (!element.isConnected || target !== element) return;
    const text = element.dataset.tip;
    if (!text) return;
    tip.textContent = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
    tip.hidden = false;
    const anchor = element.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const margin = 6;
    const below = anchor.bottom + margin + box.height <= window.innerHeight;
    const left = Math.max(
      margin,
      Math.min(anchor.left + anchor.width / 2 - box.width / 2, window.innerWidth - box.width - margin),
    );
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? anchor.bottom + margin : Math.max(margin, anchor.top - margin - box.height)}px`;
  }

  function schedule(element: HTMLElement | null) {
    const owner = element?.closest<HTMLElement>('[title], [data-tip]') ?? undefined;
    if (owner === target) return;
    hide();
    if (!owner || !adopt(owner)) return;
    target = owner;
    timer = setTimeout(() => show(owner), Date.now() < warmUntil ? WARM_DELAY_MS : DELAY_MS);
  }

  scope.listen(document, 'pointerover', (event) => schedule(event.target as HTMLElement));
  scope.listen(document, 'focusin', (event) => {
    const element = event.target as HTMLElement;
    if (element.matches?.(':focus-visible')) schedule(element);
  });
  scope.listen(document, 'focusout', hide);
  scope.listen(document, 'pointerdown', hide);
  scope.listen(document, 'keydown', hide);
  scope.listen(document, 'scroll', hide, { capture: true });
  scope.listen(document.documentElement ?? document, 'pointerleave', hide);
}
