import type { DoctorAction, DoctorFindingView, Snapshot } from '../../protocol/messages';
import type { EventScope } from '../event-scope';
import type { WebviewApi } from '../types';

const GROUPS: { codes: string[]; title: string }[] = [
  { codes: ['secret'], title: 'Secrets in logs' },
  { codes: ['personal'], title: 'Personal data in logs' },
  { codes: ['quiet-failure'], title: 'Failures logged below warning' },
  { codes: ['missing-exception'], title: 'Errors logged without the exception' },
  { codes: ['contextless'], title: 'Errors without a request or trace id' },
  { codes: ['noisy'], title: 'Noisy statements' },
  { codes: ['oversized'], title: 'Oversized events' },
  { codes: ['unstructured'], title: 'Values formatted into messages' },
  {
    codes: ['unnamed-service', 'span-name-ids', 'unmarked-error', 'missing-route', 'old-attributes', 'unit-in-name'],
    title: 'OpenTelemetry conventions',
  },
];

/** A short location for a statement, `File.java:38`, with the full path kept for tooltips. */
export function siteLabel(file: string, line: number): string {
  return `${file.slice(file.lastIndexOf('/') + 1)}:${line}`;
}

/** What a finding's buttons do; `example` is handled in the panel, the rest by the host. */
type PanelAction = DoctorAction | 'example' | 'trace';

/** A button that acts on a finding. */
export function doctorButton(action: PanelAction, label: string, title: string, siteId?: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'doctor-action';
  button.textContent = label;
  button.title = title;
  button.dataset.doctorAction = action;
  if (siteId !== undefined) button.dataset.siteId = siteId;
  return button;
}

export const DOCTOR_ACTION_TITLES = {
  fix: 'Open the statement and show its quick fixes: lower the level, pass the exception, ignore the finding, or fix it with Copilot',
  showEvents: 'Filter the Logs panel to the events this statement logged',
  open: 'Open the log statement in the editor',
};

/**
 * The log doctor chip in the Logs toolbar and its list of findings, so what
 * log doctor reports in the Problems panel is also visible next to the logs.
 */
export function createDoctor(
  button: HTMLButtonElement,
  count: HTMLElement,
  panel: HTMLElement,
  list: HTMLElement,
  api: WebviewApi,
  scope: EventScope,
  closePanel: () => void,
  showExample: (id: number) => void = () => undefined,
  showTrace: (traceId: string) => void = () => undefined,
) {
  // The host sends the list only when it changes; this is the revision on screen.
  let revision: number | undefined;
  let findings: DoctorFindingView[] = [];

  function receive(doctor: Snapshot['doctor']) {
    // Hidden only while log doctor is off; with nothing found it stays visible so it can be discovered.
    button.hidden = !doctor;
    if (!doctor) {
      revision = undefined;
      return;
    }
    const total = doctor.total;
    const changed = doctor.findings !== undefined && doctor.revision !== revision;
    if (changed) {
      revision = doctor.revision;
      findings = doctor.findings!;
    }
    count.hidden = !total;
    count.textContent = total.toLocaleString();
    const warnings = findings.filter((finding) => finding.severity === 'warning').length;
    button.className = !total ? 'doctor-chip is-clear' : warnings ? 'doctor-chip has-warnings' : 'doctor-chip';
    button.title = total
      ? `Log doctor found ${total.toLocaleString()} problem${total === 1 ? '' : 's'} with log statements${warnings ? `, ${warnings.toLocaleString()} of them warnings` : ''}. Click to review.`
      : 'Log doctor checks what your logs actually contain: secrets and personal data in any source; on matched log statements, failures logged below warning, errors without the exception or a request id, and noisy or oversized statements; and OpenTelemetry spans and metrics against the semantic conventions. Nothing found so far.';
    button.setAttribute('aria-label', `Log issues: ${total.toLocaleString()}`);
    if (changed) render(total);
  }

  function render(total: number) {
    if (!total) {
      const empty = document.createElement('p');
      empty.className = 'popover-empty';
      empty.textContent =
        'No problems found so far. Secrets and personal data are checked in every source. Checks on log statements need log lenses (logline.logLenses) to match events to the statements in your workspace.';
      list.replaceChildren(empty);
      return;
    }
    const sections: HTMLElement[] = [];
    for (const group of GROUPS) {
      const items = findings.filter((finding) => group.codes.includes(finding.code));
      if (!items.length) continue;
      const section = document.createElement('section');
      section.className = 'doctor-group';
      const heading = document.createElement('h4');
      heading.textContent = `${group.title} · ${items.length.toLocaleString()}`;
      section.append(heading, ...items.map(item));
      sections.push(section);
    }
    if (total > findings.length) {
      const more = document.createElement('p');
      more.className = 'popover-description';
      more.textContent = `Showing the first ${findings.length.toLocaleString()} of ${total.toLocaleString()} findings. The health report lists them all.`;
      sections.push(more);
    }
    list.replaceChildren(...sections);
  }

  function item(finding: DoctorFindingView): HTMLElement {
    const row = document.createElement('div');
    row.className = `doctor-item severity-${finding.severity}`;
    if (finding.file === undefined || finding.line === undefined || finding.siteId === undefined)
      return sourceItem(finding, row);
    const location = document.createElement('button');
    location.type = 'button';
    location.className = 'doctor-location';
    location.textContent = siteLabel(finding.file, finding.line);
    location.title = `Open ${finding.file}:${finding.line}`;
    location.dataset.doctorAction = 'open';
    location.dataset.siteId = finding.siteId;
    const message = document.createElement('p');
    message.className = 'doctor-message';
    message.textContent = finding.message;
    const actions = document.createElement('div');
    actions.className = 'doctor-actions';
    actions.append(
      doctorButton('fix', 'Fix…', DOCTOR_ACTION_TITLES.fix, finding.siteId),
      doctorButton('showEvents', 'Show events', DOCTOR_ACTION_TITLES.showEvents, finding.siteId),
    );
    row.append(location, message, actions);
    return row;
  }

  // No statement to open or fix: name the source and offer the latest event that carried the value.
  function sourceItem(finding: DoctorFindingView, row: HTMLElement): HTMLElement {
    const location = document.createElement('span');
    location.className = 'doctor-location doctor-source';
    location.textContent = finding.source ?? 'Unknown source';
    const message = document.createElement('p');
    message.className = 'doctor-message';
    message.textContent = finding.message;
    const actions = document.createElement('div');
    actions.className = 'doctor-actions';
    if (finding.eventId !== undefined) {
      const example = doctorButton(
        'example',
        'Show example',
        'Show the latest event that carried it, with the logs around it',
      );
      example.dataset.eventId = String(finding.eventId);
      actions.append(example);
    }
    if (finding.traceId !== undefined) {
      const trace = doctorButton('trace', 'Show trace', 'Open a trace that shows it');
      trace.dataset.traceId = finding.traceId;
      actions.append(trace);
    }
    row.append(location, message, actions);
    return row;
  }

  // Doctor actions also appear in expanded events, so any click on one is handled here.
  function handleAction(event: Event): boolean {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-doctor-action]');
    const action = target?.dataset.doctorAction as PanelAction | undefined;
    if (!target || !action) return false;
    if (action === 'example') {
      if (panel.contains(target)) closePanel();
      showExample(Number(target.dataset.eventId));
      return true;
    }
    if (action === 'trace') {
      if (panel.contains(target)) closePanel();
      showTrace(target.dataset.traceId!);
      return true;
    }
    api.postMessage({
      type: 'doctorAction',
      action,
      ...(target.dataset.siteId ? { siteId: target.dataset.siteId } : {}),
    });
    if (panel.contains(target)) closePanel();
    return true;
  }
  scope.listen(panel, 'click', handleAction);

  return { receive, handleAction, revision: () => revision };
}
