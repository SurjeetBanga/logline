import type { EventScope } from './event-scope';

/** One stop of the tour: the control it spotlights, and what to say about it. */
export interface TourStep {
  target: string;
  /** Spotlighted instead while the target is hidden, such as the rail's add button when the rail is collapsed. */
  fallback?: string;
  title: string;
  text: string;
  /** Something to type or click to try it. */
  example?: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    target: 'sourceRail',
    title: 'Your sources',
    text: 'Everything Logline captures, in one list: terminals, tasks, debug sessions, OpenTelemetry, and imports. Click one to see only its logs; point at it to stop or remove it.',
  },
  {
    target: 'railAddConnection',
    fallback: 'sourceRail',
    title: 'Production, next to local',
    text: 'Press + to add Datadog, Postgres, MySQL or Aurora, MongoDB, or SQLite. Searches run read-only, and each result is a run you can compare with your own.',
  },
  {
    target: 'searchEditor',
    title: 'Search like you think',
    text: 'Type a filter and press Enter. Filters stack as chips; click one to change it.',
    example: 'level:error service:checkout',
  },
  {
    target: 'logsView',
    title: 'Every event, explained',
    text: 'Click a row for its fields, stack trace, the line of code that logged it, and the logs around it.',
  },
  {
    target: 'viewTabs',
    title: 'Other angles on the same logs',
    text: 'Analyze charts them, Compare lines production up with your runs, Traces follows requests across services, and Metrics charts numbers.',
  },
  {
    target: 'shareSplit',
    title: 'Bring your agent in',
    text: 'Share with agent lets Copilot, Claude Code, or Codex read what you choose, redacted and read-only. The arrow sets what they read and connects them.',
  },
  {
    target: 'statusBar',
    title: 'What is running',
    text: 'Turn terminal capture and the OpenTelemetry receiver on or off here, see memory use, and check that everything is working.',
  },
];

function shown(element: HTMLElement | null): element is HTMLElement {
  for (let node = element; node; node = node.parentElement) if (node.hidden) return false;
  return Boolean(element);
}

/**
 * A guided tour of the Logs panel: each stop dims the panel, spotlights one
 * control, and explains it in a card with Back, Next, and Skip. Escape skips.
 */
export function createTour(
  scope: EventScope,
  actions: {
    /** Show the Logs tab and open the rail before a stop that needs them. */
    prepare(): void;
    /** The tour ended, finished or skipped. */
    ended(finished: boolean): void;
  },
  steps: TourStep[] = TOUR_STEPS,
) {
  let index = -1;
  let layer: HTMLElement | undefined;
  let previousFocus: HTMLElement | undefined;

  function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    scope.listen(element, 'click', onClick);
    return element;
  }

  function close(finished: boolean): void {
    if (!layer) return;
    layer.remove();
    layer.replaceChildren();
    layer = undefined;
    index = -1;
    previousFocus?.focus?.();
    actions.ended(finished);
  }

  /** The last card: where to go next, and how to see the tour again. */
  function finish(): void {
    if (!layer) return;
    const card = document.createElement('div');
    card.className = 'tour-card tour-done';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'tourTitle');
    const title = document.createElement('h2');
    title.id = 'tourTitle';
    title.textContent = 'You’re set';
    const text = document.createElement('p');
    text.textContent =
      'Turn on Capture in the status bar and run your app in a terminal, and its logs show up here. See the tour again from More actions → Take the tour.';
    const row = document.createElement('div');
    row.className = 'tour-actions';
    const done = button('Done', 'tour-primary', () => close(true));
    row.append(
      button('Replay', 'tour-secondary', () => start()),
      done,
    );
    card.append(title, text, row);
    layer.replaceChildren(backdrop(), card);
    done.focus();
  }

  function backdrop(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'tour-backdrop';
    return element;
  }

  function show(next: number): void {
    if (!layer) return;
    if (next >= steps.length) {
      finish();
      return;
    }
    index = Math.max(0, next);
    actions.prepare();
    const step = steps[index];
    const target = [step.target, step.fallback].map((id) => (id ? document.getElementById(id) : null)).find(shown);
    const card = document.createElement('div');
    card.className = 'tour-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'tourTitle');
    card.setAttribute('aria-describedby', 'tourText');
    const head = document.createElement('div');
    head.className = 'tour-head';
    const counter = document.createElement('span');
    counter.className = 'tour-counter';
    counter.textContent = `${index + 1} of ${steps.length}`;
    head.append(
      counter,
      button('Skip tour', 'tour-skip', () => close(false)),
    );
    const title = document.createElement('h2');
    title.id = 'tourTitle';
    title.textContent = step.title;
    const text = document.createElement('p');
    text.id = 'tourText';
    text.textContent = step.text;
    card.append(head, title, text);
    if (step.example) {
      const example = document.createElement('p');
      example.className = 'tour-example';
      example.append(document.createTextNode('Try it: '));
      const code = document.createElement('code');
      code.textContent = step.example;
      example.append(code);
      card.append(example);
    }
    const row = document.createElement('div');
    row.className = 'tour-actions';
    const dots = document.createElement('span');
    dots.className = 'tour-dots';
    dots.setAttribute('aria-hidden', 'true');
    for (let dot = 0; dot < steps.length; dot++) {
      const item = document.createElement('span');
      item.className = dot === index ? 'tour-dot current' : dot < index ? 'tour-dot seen' : 'tour-dot';
      dots.append(item);
    }
    row.append(dots);
    if (index > 0) row.append(button('Back', 'tour-secondary', () => show(index - 1)));
    const forward = button(index === steps.length - 1 ? 'Finish' : 'Next', 'tour-primary', () => show(index + 1));
    row.append(forward);
    card.append(row);
    const children: HTMLElement[] = [];
    if (target) {
      target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      const box = target.getBoundingClientRect();
      const spot = document.createElement('div');
      spot.className = 'tour-spotlight';
      const pad = 4;
      spot.style.left = `${Math.max(0, box.left - pad)}px`;
      spot.style.top = `${Math.max(0, box.top - pad)}px`;
      spot.style.width = `${box.width + pad * 2}px`;
      spot.style.height = `${box.height + pad * 2}px`;
      children.push(spot);
      // The card sits beside the spotlight where there is room: below, else above, else inside it.
      const width = 340;
      const left = Math.min(Math.max(8, box.left), Math.max(8, window.innerWidth - width - 8));
      card.style.left = `${left}px`;
      if (box.bottom + 190 < window.innerHeight) card.style.top = `${box.bottom + 12}px`;
      else if (box.top > 200) card.style.bottom = `${window.innerHeight - box.top + 12}px`;
      else card.style.top = `${Math.max(8, box.top + 12)}px`;
    } else children.push(backdrop());
    children.push(card);
    layer.replaceChildren(...children);
    forward.focus();
  }

  function start(): void {
    previousFocus ??= document.activeElement as HTMLElement | undefined;
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'tour-layer';
      document.body.append(layer);
    }
    show(0);
  }

  scope.listen(document, 'keydown', (event) => {
    if (!layer) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close(false);
    }
  });
  // Spotlights follow the panel's layout; a resize puts the current stop back in place.
  scope.listen(window, 'resize', () => {
    if (layer && index >= 0) show(index);
  });

  return {
    start,
    active: () => Boolean(layer),
    step: () => index,
  };
}
