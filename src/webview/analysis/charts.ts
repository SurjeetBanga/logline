import type { AnalysisResult } from '../../core/log-analysis';
import type { Elements } from '../dom';
import type { ViewerState } from '../state';

export function createAnalysis(elements: Elements, state: ViewerState) {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag: string, attrs: Record<string, string | number> = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs))
      el.setAttribute(key, String(value));
    return el;
  }

  function timeAxisFormatter(spanMs: number | undefined) {
    const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false };
    if (spanMs !== undefined && spanMs < 3 * 60 * 1000)
      options.second = '2-digit';
    if (state.displayTimezone === 'utc')
      options.timeZone = 'UTC';
    else if (state.displayTimezone && state.displayTimezone !== 'local')
      options.timeZone = state.displayTimezone;
    try {
      return new Intl.DateTimeFormat(undefined, options);
    }
    catch {
      return null;
    }
  }

  // Real clock time for a bucket, so the x-axis reads like a timeline instead of an
  // abstract 1..30 index - that's what made the previous version illegible.
  function bucketTime(range: AnalysisResult['range'], bucketCount: number, index: number) {
    if (range?.from === undefined || range?.to === undefined || !bucketCount)
      return undefined;
    const bucketSize = Math.max(1, (range.to - range.from) / bucketCount);
    return range.from + index * bucketSize;
  }

  function formatClock(ms: number, range: AnalysisResult['range']) {
    const span = range?.from !== undefined && range?.to !== undefined ? range.to - range.from : undefined;
    const formatter = timeAxisFormatter(span);
    return formatter ? formatter.format(ms) : new Date(ms).toLocaleTimeString();
  }

  function chartLegend(items: { className: string; label: string; }[]) {
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    for (const item of items) {
      const entry = document.createElement('span');
      entry.className = 'chart-legend-item';
      const swatch = document.createElement('span');
      swatch.className = `chart-legend-swatch ${item.className}`;
      entry.append(swatch, document.createTextNode(item.label));
      legend.append(entry);
    }
    return legend;
  }

  function emptySection(title: string) {
    const section = document.createElement('section');
    section.className = 'chart-section chart-wide';
    const heading = document.createElement('h3');
    heading.textContent = title;
    section.append(heading);
    const empty = document.createElement('p');
    empty.textContent = 'No data in this range.';
    section.append(empty);
    return section;
  }

  function xAxisTicks(svg: SVGElement, bucketCount: number, range: AnalysisResult['range'], xFor: (index: number) => number, height: number) {
    const tickEvery = Math.max(1, Math.round(bucketCount / 6));
    for (let index = 0; index < bucketCount; index += tickEvery) {
      const time = bucketTime(range, bucketCount, index);
      if (time === undefined)
        continue;
      const label = svgEl('text', { x: xFor(index), y: height - 4, class: 'chart-axis-label' });
      label.textContent = formatClock(time, range);
      svg.append(label);
    }
  }

  // Log volume over time with the error share stacked in red inside each bar - the
  // standard "log histogram" view from tools like Kibana/Grafana, so a spike or an
  // error-heavy period is visible at a glance instead of as two separate number lists.
  function volumeChart(rate: AnalysisResult['rate'], errors: AnalysisResult['errors'], range: AnalysisResult['range']) {
    const bucketCount = rate.length;
    if (!bucketCount || !rate.some(item => item.count > 0))
      return emptySection('Event volume');
    const section = document.createElement('section');
    section.className = 'chart-section chart-wide';
    const heading = document.createElement('h3');
    heading.textContent = 'Event volume';
    section.append(heading);
    const width = 720, height = 130, padTop = 10, padBottom = 18;
    const plotHeight = height - padTop - padBottom;
    const max = Math.max(1, ...rate.map(item => item.count));
    const barGap = 2;
    const barWidth = Math.max(1, width / bucketCount - barGap);
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'volume-chart', role: 'img', 'aria-label': 'Event volume over time, with errors highlighted' });
    const maxLabel = svgEl('text', { x: 2, y: padTop, class: 'chart-axis-label' });
    maxLabel.textContent = String(max);
    svg.append(maxLabel);
    rate.forEach((item, index) => {
      const errorCount = Math.min(item.count, errors[index]?.count ?? 0);
      const okCount = item.count - errorCount;
      const x = index * (barWidth + barGap);
      const okHeight = okCount / max * plotHeight;
      const errorHeight = errorCount / max * plotHeight;
      const anomalous = item.anomalous || errors[index]?.anomalous;
      const group = svgEl('g', { class: anomalous ? 'volume-bar anomalous' : 'volume-bar' });
      if (okHeight > 0)
        group.append(svgEl('rect', { x, width: barWidth, y: padTop + plotHeight - okHeight - errorHeight, height: okHeight, class: 'volume-bar-ok' }));
      if (errorHeight > 0)
        group.append(svgEl('rect', { x, width: barWidth, y: padTop + plotHeight - errorHeight, height: Math.max(1, errorHeight), class: 'volume-bar-error' }));
      const time = bucketTime(range, bucketCount, index);
      const title = svgEl('title');
      title.textContent = `${time !== undefined ? formatClock(time, range) + '\n' : ''}${item.count} event${item.count === 1 ? '' : 's'}${errorCount ? `, ${errorCount} error${errorCount === 1 ? '' : 's'}` : ''}`;
      group.append(title);
      if (anomalous) {
        const dot = svgEl('circle', { cx: x + barWidth / 2, cy: padTop - 5, r: 2.5, class: 'anomaly-marker' });
        const dotTitle = svgEl('title');
        dotTitle.textContent = 'Unusually high compared to the rest of this range';
        dot.append(dotTitle);
        group.append(dot);
      }
      svg.append(group);
    });
    xAxisTicks(svg, bucketCount, range, index => index * (barWidth + barGap) + barWidth / 2, height);
    section.append(svg, chartLegend([{ className: 'swatch-ok', label: 'events' }, { className: 'swatch-error', label: 'errors' }]));
    return section;
  }

  // Average + p95 latency over the same time axis as the volume chart, rather than two
  // separate bar lists - this is how APM tools (Datadog, Grafana) conventionally pair
  // a mean line with a percentile line so tail latency is visible alongside the average.
  function latencyChart(latency: AnalysisResult['latency'], range: AnalysisResult['range']) {
    const bucketCount = latency.length;
    if (!bucketCount || !latency.some(item => item.count > 0))
      return emptySection('Latency (ms)');
    const section = document.createElement('section');
    section.className = 'chart-section chart-wide';
    const heading = document.createElement('h3');
    heading.textContent = 'Latency (ms)';
    section.append(heading);
    const width = 720, height = 110, padTop = 10, padBottom = 18;
    const plotHeight = height - padTop - padBottom;
    const max = Math.max(1, ...latency.map(item => Math.max(item.average, item.p95)));
    const step = bucketCount > 1 ? width / (bucketCount - 1) : 0;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'latency-chart', role: 'img', 'aria-label': 'Average and p95 latency over time' });
    const maxLabel = svgEl('text', { x: 2, y: padTop, class: 'chart-axis-label' });
    maxLabel.textContent = `${Math.round(max)}ms`;
    svg.append(maxLabel);
    const pathFor = (key: 'average' | 'p95') => {
      let d = '';
      let drawing = false;
      latency.forEach((item, index) => {
        const x = index * step;
        if (item.count === 0) {
          drawing = false;
          return;
        }
        const y = padTop + plotHeight - item[key] / max * plotHeight;
        d += drawing ? ` L ${x} ${y}` : ` M ${x} ${y}`;
        drawing = true;
      });
      return d.trim();
    };
    svg.append(svgEl('path', { d: pathFor('p95'), class: 'latency-line latency-p95' }));
    svg.append(svgEl('path', { d: pathFor('average'), class: 'latency-line latency-average' }));
    latency.forEach((item, index) => {
      if (item.count === 0)
        return;
      const x = index * step;
      const y = padTop + plotHeight - item.average / max * plotHeight;
      const dot = svgEl('circle', { cx: x, cy: y, r: item.anomalous ? 2.5 : 1.5, class: item.anomalous ? 'latency-point anomalous' : 'latency-point' });
      const time = bucketTime(range, bucketCount, index);
      const title = svgEl('title');
      title.textContent = `${time !== undefined ? formatClock(time, range) + '\n' : ''}average ${Math.round(item.average)}ms, p95 ${Math.round(item.p95)}ms`;
      dot.append(title);
      svg.append(dot);
    });
    xAxisTicks(svg, bucketCount, range, index => index * step, height);
    section.append(svg, chartLegend([{ className: 'swatch-average', label: 'average' }, { className: 'swatch-p95', label: 'p95' }]));
    return section;
  }

  function sparkline(values: number[]) {
    const el = document.createElement('span');
    el.className = 'sparkline';
    const max = Math.max(1, ...values);
    for (const value of values) {
      const bar = document.createElement('span');
      bar.className = 'sparkline-bar';
      bar.style.height = `${Math.max(8, value / max * 100)}%`;
      el.append(bar);
    }
    return el;
  }

  function renderAnalysis(analysis: AnalysisResult) {
    if (!elements.analysisContent)
      return;
    const content = document.createDocumentFragment();
    content.append(volumeChart(analysis.rate ?? [], analysis.errors ?? [], analysis.range));
    content.append(latencyChart(analysis.latency ?? [], analysis.range));
    const status = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = 'Status codes';
    status.append(heading);
    for (const item of analysis.statusCodes ?? []) {
      const p = document.createElement('p');
      p.textContent = `${item.code}: ${item.count}`;
      status.append(p);
    }
    content.append(status);
    const patterns = document.createElement('section');
    const patternHeading = document.createElement('h3');
    patternHeading.textContent = 'Log patterns';
    patterns.append(patternHeading);
    for (const item of analysis.patterns ?? []) {
      const row = document.createElement('div');
      row.className = 'pattern-row';
      const level = document.createElement('span');
      level.className = `level ${item.level}`;
      level.textContent = item.level;
      const text = document.createElement('span');
      text.className = 'pattern-text';
      text.textContent = `${item.count} × ${item.message}`;
      text.title = item.message;
      row.append(level, text, sparkline(item.trend));
      patterns.append(row);
    }
    if (!patterns.querySelector('.pattern-row')) {
      const empty = document.createElement('p');
      empty.textContent = 'No data in this range.';
      patterns.append(empty);
    }
    content.append(patterns);
    const groups = document.createElement('section');
    const groupHeading = document.createElement('h3');
    groupHeading.textContent = 'Error groups';
    groups.append(groupHeading);
    for (const item of analysis.errorGroups ?? []) {
      const p = document.createElement('p');
      p.textContent = item.location ? `${item.count} × ${item.message} — ${item.location}` : `${item.count} × ${item.message}`;
      p.title = item.key;
      groups.append(p);
    }
    content.append(groups);
    elements.analysisContent.replaceChildren(content);
  }
  return { renderAnalysis };
}
