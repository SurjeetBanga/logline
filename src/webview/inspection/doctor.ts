import type { DoctorAction, DoctorFindingView, Snapshot } from '../../protocol/messages';
import type { EventScope } from '../event-scope';
import type { WebviewApi } from '../types';

const GROUPS: { codes: string[]; title: string; }[] = [
  { codes: ['secret'], title: 'Secrets in logs' },
  { codes: ['personal'], title: 'Personal data in logs' },
  { codes: ['missing-exception'], title: 'Errors logged without the exception' },
  { codes: ['noisy'], title: 'Noisy statements' },
  { codes: ['unstructured'], title: 'Values formatted into messages' }
];

/** A short location for a statement, `File.java:38`, with the full path kept for tooltips. */
export function siteLabel(file: string, line: number): string { return `${file.slice(file.lastIndexOf('/') + 1)}:${line}`; }

/** A button that asks the host to act on a finding. */
export function doctorButton(action: DoctorAction, label: string, title: string, siteId?: string): HTMLButtonElement {
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
  open: 'Open the log statement in the editor'
};

/**
 * The log doctor chip in the Logs toolbar and its list of findings, so what
 * log doctor reports in the Problems panel is also visible next to the logs.
 */
export function createDoctor(button: HTMLButtonElement, count: HTMLElement, panel: HTMLElement, list: HTMLElement, api: WebviewApi, scope: EventScope, closePanel: () => void) {
  // The host sends the list only when it changes; this is the revision on screen.
  let revision: number | undefined;
  let findings: DoctorFindingView[] = [];

  function receive(doctor: Snapshot['doctor']) {
    // Hidden only while log doctor is off; with nothing found it stays visible so it can be discovered.
    button.hidden = !doctor;
    if (!doctor) { revision = undefined; return; }
    const total = doctor.total;
    const changed = doctor.findings !== undefined && doctor.revision !== revision;
    if (changed) { revision = doctor.revision; findings = doctor.findings!; }
    count.hidden = !total;
    count.textContent = total.toLocaleString();
    const warnings = findings.filter(finding => finding.severity === 'warning').length;
    button.className = !total ? 'doctor-chip is-clear' : warnings ? 'doctor-chip has-warnings' : 'doctor-chip';
    button.title = total
      ? `Log doctor found ${total.toLocaleString()} problem${total === 1 ? '' : 's'} with log statements${warnings ? `, ${warnings.toLocaleString()} of them warnings` : ''}. Click to review.`
      : 'Log doctor checks what your log statements actually logged: secrets, personal data, errors without the exception, and noisy statements. Nothing found so far.';
    button.setAttribute('aria-label', `Log issues: ${total.toLocaleString()}`);
    if (changed) render(total);
  }

  function render(total: number) {
    if (!total) {
      const empty = document.createElement('p');
      empty.className = 'popover-empty';
      empty.textContent = 'No problems found so far. Log doctor needs log lenses (logline.logLenses) to match events to the log statements in your workspace; imported logs from other projects are not checked.';
      list.replaceChildren(empty);
      return;
    }
    const sections: HTMLElement[] = [];
    for (const group of GROUPS) {
      const items = findings.filter(finding => group.codes.includes(finding.code));
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
    actions.append(doctorButton('fix', 'Fix…', DOCTOR_ACTION_TITLES.fix, finding.siteId),
      doctorButton('showEvents', 'Show events', DOCTOR_ACTION_TITLES.showEvents, finding.siteId));
    row.append(location, message, actions);
    return row;
  }

  // Doctor actions also appear in expanded events, so any click on one is handled here.
  function handleAction(event: Event): boolean {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-doctor-action]');
    const action = target?.dataset.doctorAction as DoctorAction | undefined;
    if (!target || !action) return false;
    api.postMessage({ type: 'doctorAction', action, ...(target.dataset.siteId ? { siteId: target.dataset.siteId } : {}) });
    if (panel.contains(target)) closePanel();
    return true;
  }
  scope.listen(panel, 'click', handleAction);

  return { receive, handleAction, revision: () => revision };
}
