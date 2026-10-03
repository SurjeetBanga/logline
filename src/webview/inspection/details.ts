import type { ExceptionBlock } from '../../core/exceptions';
import type { DetailLinks } from '../../protocol/messages';

export function buildEventDetails(id: number, text: string | undefined, exceptions: ExceptionBlock[], links: DetailLinks = {}) {
  const container = document.createElement('div');
  container.className = 'event-details';
  const copy = document.createElement('button');
  copy.className = 'copy-button';
  copy.textContent = 'Copy event';
  copy.dataset.id = String(id);
  container.append(copy);
  const share = document.createElement('button');
  share.className = 'share-source-button';
  share.textContent = 'Share source with Agent';
  share.dataset.id = String(id);
  container.append(share);
  if (links.traceId) {
    const trace = document.createElement('button');
    trace.className = 'trace-button';
    trace.textContent = 'Show trace';
    trace.title = 'Show every span and log in this request across services';
    trace.dataset.traceId = links.traceId;
    container.append(trace);
  }
  if (links.site) {
    const site = document.createElement('button');
    site.className = 'log-site-button';
    site.textContent = `Open log statement · ${links.site}`;
    site.title = 'Open the line of code that logged this event';
    site.dataset.id = String(id);
    container.append(site);
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
