import type { ExceptionBlock } from '../../core/exceptions';
import type { DetailLinks } from '../../protocol/messages';
import { DOCTOR_ACTION_TITLES, doctorButton } from './doctor';

type IconPart = [tag: string, attributes: Record<string, string>];

const ICONS: Record<string, IconPart[]> = {
  context: [['path', { d: 'M4 3.5h8M2 8h12M4 12.5h8' }]],
  trace: [['path', { d: 'M2 3.5h6M5 8h7M9 12.5h5' }]],
  code: [['path', { d: 'M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5' }]],
  breakpoint: [['circle', { cx: '8', cy: '8', r: '4', fill: 'currentColor', stroke: 'none' }]],
  copy: [['rect', { x: '5.5', y: '5.5', width: '8', height: '8.5', rx: '1' }], ['path', { d: 'M3 10.5v-7a1 1 0 0 1 1-1h6' }]],
  agent: [['path', { d: 'M8 2l1.4 4.6L14 8l-4.6 1.4L8 14l-1.4-4.6L2 8l4.6-1.4z' }]],
  warning: [['path', { d: 'M8 2.5 14.5 13.5h-13zM8 6.5v3' }], ['circle', { cx: '8', cy: '11.6', r: '.4', fill: 'currentColor' }]],
  information: [['circle', { cx: '8', cy: '8', r: '6' }], ['path', { d: 'M8 7.5v4' }], ['circle', { cx: '8', cy: '5', r: '.4', fill: 'currentColor' }]],
  hint: [['path', { d: 'M6 12.5h4M6.5 14.5h3M8 1.8a4.2 4.2 0 0 0-2.5 7.6c.5.4.8 1 .8 1.6h3.4c0-.6.3-1.2.8-1.6A4.2 4.2 0 0 0 8 1.8z' }]]
};
export type IconName = keyof typeof ICONS;

// Each icon is built once and cloned after that; rows rebuild while scrolling.
const iconTemplates = new Map<IconName, Element>();

export function icon(name: IconName): Element {
  let template = iconTemplates.get(name);
  if (!template) iconTemplates.set(name, template = buildIcon(name));
  return template.cloneNode(true) as Element;
}

function buildIcon(name: IconName): Element {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 16 16', width: '14', height: '14', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
    svg.setAttribute(key, value);
  for (const [tag, attributes] of ICONS[name]) {
    const part = document.createElementNS(namespace, tag);
    for (const [key, value] of Object.entries(attributes)) part.setAttribute(key, value);
    svg.append(part);
  }
  return svg;
}

/**
 * One action on an expanded event. An action that does not apply to this
 * event stays visible but disabled, with the reason as its tooltip, so the
 * feature can be discovered from any event.
 */
export function eventAction(className: string, iconName: keyof typeof ICONS, label: string, title: string, unavailable?: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `event-action ${className}`;
  const text = document.createElement('span');
  text.className = 'event-action-label';
  text.textContent = label;
  button.append(icon(iconName), text);
  button.title = unavailable ?? title;
  if (unavailable) {
    button.dataset.unavailable = unavailable;
    button.setAttribute('aria-disabled', 'true');
  }
  return button;
}

export function buildEventDetails(id: number, text: string | undefined, exceptions: ExceptionBlock[], links: DetailLinks = {}, leadingActions: HTMLElement[] = []) {
  const container = document.createElement('div');
  container.className = 'event-details';
  const actions = document.createElement('div');
  actions.className = 'event-actions';
  const investigate = document.createElement('div');
  investigate.className = 'event-action-group';
  investigate.setAttribute('role', 'group');
  investigate.setAttribute('aria-label', 'Investigate this event');
  const output = document.createElement('div');
  output.className = 'event-action-group event-action-output';
  output.setAttribute('role', 'group');
  output.setAttribute('aria-label', 'Copy or share this event');
  actions.append(investigate, output);
  container.append(actions);
  // Links arrive with the event's text; until then nothing is known to be missing.
  const loading = text === undefined ? 'Checking this event…' : undefined;
  const trace = eventAction('trace-button', 'trace', 'Trace', 'Show every span and log in this request across services',
    links.traceId ? undefined : loading ?? 'No trace id in this event. Events that carry a traceId show their whole request across services.');
  if (links.traceId) trace.dataset.traceId = links.traceId;
  const noSite = loading ?? 'No code location found for this event. Logline links an event to code when it reports its file and line, or when a log lens matches its message.';
  const siteName = links.site?.split(/[\\/]/).pop();
  const site = eventAction('log-site-button', 'code', siteName ? `Open code · ${siteName}` : 'Open code',
    `Open ${links.site}, the line of code that logged this event`, links.site ? undefined : noSite);
  const breakpoint = eventAction('break-on-log-button', 'breakpoint', 'Break here',
    'Add a debugger breakpoint on the statement that logged this event, so the debugger stops the next time it logs', links.site ? undefined : noSite);
  site.dataset.id = breakpoint.dataset.id = String(id);
  investigate.append(...leadingActions, trace, site, breakpoint);
  const copy = eventAction('copy-button', 'copy', 'Copy', 'Copy the original event to the clipboard');
  const share = eventAction('share-source-button', 'agent', 'Share with agent', 'Share the logs of this event\'s source with Copilot, so it can read them');
  copy.dataset.id = share.dataset.id = String(id);
  output.append(copy, share);
  for (const finding of links.findings ?? []) {
    // What log doctor found on the statement behind this event, with the same actions as the toolbar list.
    const banner = document.createElement('div');
    banner.className = `event-finding severity-${finding.severity}`;
    banner.setAttribute('role', 'note');
    const message = document.createElement('p');
    const label = document.createElement('strong');
    label.textContent = 'Log doctor: ';
    message.append(label, document.createTextNode(finding.message));
    const actions = document.createElement('div');
    actions.className = 'doctor-actions';
    actions.append(doctorButton('fix', 'Fix…', DOCTOR_ACTION_TITLES.fix, finding.siteId),
      doctorButton('showEvents', 'Show events', DOCTOR_ACTION_TITLES.showEvents, finding.siteId));
    banner.append(icon(finding.severity), message, actions);
    container.append(banner);
  }
  exceptions.forEach((exception, blockIndex) => {
    const section = document.createElement('section');
    section.className = 'exception-block';
    const title = document.createElement('strong');
    title.textContent = exception.title;
    const stack = document.createElement('div');
    stack.className = 'exception-stack';
    exception.lines.forEach((line, lineIndex) => {
      const element = document.createElement(line.source ? 'button' : 'div');
      element.textContent = line.text || ' ';
      if (line.source) {
        element.className = 'source-link';
        element.dataset.id = String(id);
        element.dataset.block = String(blockIndex);
        element.dataset.line = String(lineIndex);
        element.title = `Open ${line.source.file}:${line.source.line}`;
      }
      stack.append(element);
    });
    section.append(title, stack);
    container.append(section);
  });
  const pre = document.createElement('pre');
  pre.textContent = text ?? 'Loading…';
  if (exceptions.length) {
    const raw = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Original event';
    raw.append(summary, pre);
    container.append(raw);
  }
  else
    container.append(pre);
  return container;
}
