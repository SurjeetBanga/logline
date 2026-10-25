import type { AnalysisResult, ErrorGroup, FieldValues, LogPattern } from '../../core/log-analysis';
import type { Elements } from '../dom';
import type { EventScope } from '../event-scope';
import type { ViewerState } from '../state';

export interface AnalysisActions {
  /** Narrow the current search by a term, such as a time range or a field value. */
  drill(term: string): void;
  /** Select one source exactly, as the source picker does. */
  selectSource(id: string): void;
}

/**
 * The Analyze dialog. Every chart bar, value, pattern and error group is a
 * way into the matching logs, as in Datadog, Kibana and Grafana.
 */
export function createAnalysis(elements: Elements, state: ViewerState, actions?: AnalysisActions, scope?: EventScope) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const numberFormat = new Intl.NumberFormat();
  const count = (value: number) => numberFormat.format(value);
  scope?.listen(elements.analysisContent, 'click', (event) => {
    const target = (event.target as Element).closest?.<HTMLElement | SVGElement>('[data-term], [data-source]');
    if (!target || !actions) return;
    if (target.dataset.source !== undefined) actions.selectSource(target.dataset.source);
    else if (target.dataset.term) actions.drill(target.dataset.term);
  });
  scope?.listen(elements.analysisContent, 'keydown', (event) => {
    // Bars are SVG groups; give them the keys a button has.
    const target = event.target as SVGElement;
    if ((event.key === 'Enter' || event.key === ' ') && target.dataset?.term && target.tagName?.toLowerCase() === 'g') {
      event.preventDefault();
      actions?.drill(target.dataset.term);
    }
  });
  let formatterKey: string | undefined;
  let cachedFormatter: Intl.DateTimeFormat | null | undefined;

  function svgEl(tag: string, attrs: Record<string, string | number> = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    return el;
  }

  function timeAxisFormatter(spanMs: number | undefined) {
    const key = `${state.displayTimezone ?? 'local'}:${spanMs !== undefined && spanMs < 3 * 60 * 1000 ? 'seconds' : 'minutes'}`;
    if (key === formatterKey) return cachedFormatter;
    formatterKey = key;
    const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false };
    if (spanMs !== undefined && spanMs < 3 * 60 * 1000) options.second = '2-digit';
    if (state.displayTimezone === 'utc') options.timeZone = 'UTC';
    else if (state.displayTimezone && state.displayTimezone !== 'local') options.timeZone = state.displayTimezone;
    try {
      cachedFormatter = new Intl.DateTimeFormat(undefined, options);
    } catch {
      cachedFormatter = null;
    }
    return cachedFormatter;
  }

  // Real clock time for a bucket, so the x-axis reads like a timeline instead of an
  // abstract 1..30 index - that's what made the previous version illegible.
  function bucketTime(range: AnalysisResult['range'], bucketCount: number, index: number) {
    if (range?.from === undefined || range?.to === undefined || !bucketCount) return undefined;
    const bucketSize = Math.max(1, (range.to - range.from) / bucketCount);
    return range.from + index * bucketSize;
  }

  function formatClock(ms: number, range: AnalysisResult['range']) {
    const span = range?.from !== undefined && range?.to !== undefined ? range.to - range.from : undefined;
    const formatter = timeAxisFormatter(span);
    return formatter ? formatter.format(ms) : new Date(ms).toLocaleTimeString();
  }

  function chartLegend(items: { className: string; label: string }[]) {
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

  /**
   * Times under a chart. They are HTML placed by share of the width, not SVG text,
   * which would grow and shrink with the chart and be unreadable in a narrow panel.
   */
  function xAxisTicks(
    bucketCount: number,
    range: AnalysisResult['range'],
    xFor: (index: number) => number,
    width: number,
  ): HTMLElement {
    const axis = document.createElement('div');
    axis.className = 'chart-axis';
    axis.setAttribute('aria-hidden', 'true');
    const tickEvery = Math.max(1, Math.round(bucketCount / 6));
    for (let index = 0; index < bucketCount; index += tickEvery) {
      const time = bucketTime(range, bucketCount, index);
      if (time === undefined) continue;
      const label = document.createElement('span');
      label.className = 'chart-axis-label';
      label.style.left = `${((xFor(index) / width) * 100).toFixed(2)}%`;
      label.textContent = formatClock(time, range);
      axis.append(label);
    }
    return axis;
  }

  /** A chart's title, with its scale beside it in quieter text. */
  function chartHeading(title: string, scale: string): HTMLElement {
    const heading = document.createElement('h3');
    heading.className = 'chart-heading';
    heading.textContent = title;
    const note = document.createElement('span');
    note.className = 'chart-scale';
    note.textContent = scale;
    heading.append(note);
    return heading;
  }

  // Log volume over time, stacked by level: errors, then warnings, then the rest, so a
  // spike or an error-heavy period is visible at a glance. Dragging across the bars
  // selects a window to show in Logs; clicking one bar shows its own.
  function volumeChart(
    rate: AnalysisResult['rate'],
    errors: AnalysisResult['errors'],
    range: AnalysisResult['range'],
    warnings: NonNullable<AnalysisResult['warnings']> = [],
  ) {
    const bucketCount = rate.length;
    if (!bucketCount || !rate.some((item) => item.count > 0)) return emptySection('Volume by level');
    const section = document.createElement('section');
    section.className = 'chart-section chart-wide';
    const max = Math.max(1, ...rate.map((item) => item.count));
    section.append(chartHeading('Volume by level', `up to ${count(max)} a bar`));
    const width = 720,
      height = 116,
      padTop = 10,
      padBottom = 0;
    const plotHeight = height - padTop - padBottom;
    const barGap = 2;
    const barWidth = Math.max(1, width / bucketCount - barGap);
    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`,
      class: 'volume-chart',
      role: 'img',
      'aria-label': 'Event volume over time, with errors highlighted',
    });
    rate.forEach((item, index) => {
      const errorCount = Math.min(item.count, errors[index]?.count ?? 0);
      const warnCount = Math.min(item.count - errorCount, warnings[index]?.count ?? 0);
      const okCount = item.count - errorCount - warnCount;
      const x = index * (barWidth + barGap);
      const okHeight = (okCount / max) * plotHeight;
      const warnHeight = (warnCount / max) * plotHeight;
      const errorHeight = (errorCount / max) * plotHeight;
      const anomalous = item.anomalous || errors[index]?.anomalous;
      const group = svgEl('g', { class: anomalous ? 'volume-bar anomalous' : 'volume-bar' });
      const time = bucketTime(range, bucketCount, index);
      if (time !== undefined && item.count && range.to !== undefined && range.from !== undefined) {
        const end = time + Math.max(1, (range.to - range.from) / bucketCount);
        group.dataset.term = `timestamp:[${new Date(time).toISOString()} TO ${new Date(end).toISOString()}]`;
        group.setAttribute('tabindex', '0');
        group.setAttribute('role', 'button');
        // The whole column is the target, not just the visible bar.
        group.append(
          svgEl('rect', { x, width: barWidth + barGap, y: 0, height: padTop + plotHeight, class: 'volume-hit' }),
        );
      }
      if (okHeight > 0)
        group.append(
          svgEl('rect', {
            x,
            width: barWidth,
            y: padTop + plotHeight - okHeight - warnHeight - errorHeight,
            height: okHeight,
            class: 'volume-bar-ok',
          }),
        );
      if (warnHeight > 0)
        group.append(
          svgEl('rect', {
            x,
            width: barWidth,
            y: padTop + plotHeight - warnHeight - errorHeight,
            height: Math.max(1, warnHeight),
            class: 'volume-bar-warn',
          }),
        );
      if (errorHeight > 0)
        group.append(
          svgEl('rect', {
            x,
            width: barWidth,
            y: padTop + plotHeight - errorHeight,
            height: Math.max(1, errorHeight),
            class: 'volume-bar-error',
          }),
        );
      const title = svgEl('title');
      title.textContent = `${time !== undefined ? formatClock(time, range) + '\n' : ''}${count(item.count)} event${item.count === 1 ? '' : 's'}${errorCount ? `, ${count(errorCount)} error${errorCount === 1 ? '' : 's'}` : ''}${warnCount ? `, ${count(warnCount)} warning${warnCount === 1 ? '' : 's'}` : ''}${group.dataset.term ? '\nClick to show these events, or drag across bars to choose a window' : ''}`;
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
    const axis = xAxisTicks(bucketCount, range, (index) => index * (barWidth + barGap) + barWidth / 2, width);
    const selection = document.createElement('div');
    selection.className = 'volume-selection-bar';
    selection.hidden = true;
    brush(svg, selection, { rate, errors, range, barWidth, barGap, plotBottom: padTop + plotHeight });
    section.append(
      svg,
      axis,
      chartLegend([
        { className: 'swatch-ok', label: 'info and others' },
        { className: 'swatch-warn', label: 'warnings' },
        { className: 'swatch-error', label: 'errors' },
      ]),
      selection,
    );
    return section;
  }

  /** Drag across volume bars to choose a window: it is outlined, and the bar below offers it to Logs. */
  function brush(
    svg: SVGElement,
    bar: HTMLElement,
    chart: {
      rate: AnalysisResult['rate'];
      errors: AnalysisResult['errors'];
      range: AnalysisResult['range'];
      barWidth: number;
      barGap: number;
      plotBottom: number;
    },
  ) {
    const { rate, range } = chart;
    const bucketCount = rate.length;
    if (range.from === undefined || range.to === undefined || !scope) return;
    const step = chart.barWidth + chart.barGap;
    const outline = svgEl('rect', { y: 0, height: chart.plotBottom, class: 'volume-selection', visibility: 'hidden' });
    svg.append(outline);
    let start: number | undefined;
    let dragged = false;
    const bucketAt = (event: PointerEvent) => {
      const box = svg.getBoundingClientRect();
      const share = box.width ? (event.clientX - box.left) / box.width : 0;
      return Math.max(0, Math.min(bucketCount - 1, Math.floor(share * bucketCount)));
    };
    const show = (first: number, last: number) => {
      const low = Math.min(first, last);
      const high = Math.max(first, last);
      outline.setAttribute('x', String(low * step));
      outline.setAttribute('width', String((high - low + 1) * step));
      outline.setAttribute('visibility', 'visible');
      return [low, high] as const;
    };
    scope.listen(svg, 'pointerdown', (event) => {
      if (event.button !== 0) return;
      start = bucketAt(event);
      dragged = false;
      // The release then reaches the chart even past its edge, ending the drag there.
      svg.setPointerCapture?.(event.pointerId);
    });
    scope.listen(svg, 'pointercancel', () => {
      if (start === undefined) return;
      start = undefined;
      if (dragged && bar.hidden) outline.setAttribute('visibility', 'hidden');
    });
    scope.listen(svg, 'pointermove', (event) => {
      if (start === undefined) return;
      const here = bucketAt(event);
      if (here !== start) dragged = true;
      if (dragged) show(start, here);
    });
    scope.listen(svg, 'pointerup', (event) => {
      if (start === undefined) return;
      const first = start;
      start = undefined;
      if (!dragged) return;
      const [low, high] = show(first, bucketAt(event));
      const from = bucketTime(range, bucketCount, low)!;
      const to = bucketTime(range, bucketCount, high + 1)!;
      const logs = rate.slice(low, high + 1).reduce((sum, item) => sum + item.count, 0);
      const errorCount = chart.errors.slice(low, high + 1).reduce((sum, item) => sum + item.count, 0);
      const text = document.createElement('span');
      text.textContent = `${formatClock(from, range)} – ${formatClock(to, range)} selected · ${count(logs)} log${logs === 1 ? '' : 's'}${errorCount ? `, ${count(errorCount)} error${errorCount === 1 ? '' : 's'}` : ''}`;
      const showLogs = document.createElement('button');
      showLogs.type = 'button';
      showLogs.textContent = 'Show in Logs';
      showLogs.dataset.term = `timestamp:[${new Date(from).toISOString()} TO ${new Date(to).toISOString()}]`;
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.textContent = 'Clear';
      scope.listen(clear, 'click', () => {
        bar.hidden = true;
        outline.setAttribute('visibility', 'hidden');
      });
      bar.replaceChildren(text, showLogs, clear);
      bar.hidden = false;
    });
    // A drag ends with a click on the bar it ended on, which must not filter to that one bar.
    scope.listen(
      svg,
      'click',
      (event) => {
        if (!dragged) return;
        dragged = false;
        event.stopPropagation();
      },
      { capture: true },
    );
  }

  // Average + p95 latency over the same time axis as the volume chart, rather than two
  // separate bar lists - this is how APM tools (Datadog, Grafana) conventionally pair
  // a mean line with a percentile line so tail latency is visible alongside the average.
  function latencyChart(latency: AnalysisResult['latency'], range: AnalysisResult['range']) {
    const bucketCount = latency.length;
    if (!bucketCount || !latency.some((item) => item.count > 0)) return emptySection('Latency');
    const section = document.createElement('section');
    section.className = 'chart-section chart-wide';
    const max = Math.max(1, ...latency.map((item) => Math.max(item.average, item.p95)));
    section.append(chartHeading('Latency', `up to ${count(Math.round(max))} ms`));
    // As wide as the volume chart above it, so the two share their time axis.
    const width = 720,
      height = 96,
      padTop = 6,
      padBottom = 4;
    const plotHeight = height - padTop - padBottom;
    const step = bucketCount > 1 ? width / (bucketCount - 1) : 0;
    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`,
      class: 'latency-chart',
      role: 'img',
      'aria-label': 'Average and p95 latency over time',
    });
    const pathFor = (key: 'average' | 'p95') => {
      let d = '';
      let drawing = false;
      latency.forEach((item, index) => {
        const x = index * step;
        if (item.count === 0) {
          drawing = false;
          return;
        }
        const y = padTop + plotHeight - (item[key] / max) * plotHeight;
        d += drawing ? ` L ${x} ${y}` : ` M ${x} ${y}`;
        drawing = true;
      });
      return d.trim();
    };
    svg.append(svgEl('path', { d: pathFor('p95'), class: 'latency-line latency-p95' }));
    svg.append(svgEl('path', { d: pathFor('average'), class: 'latency-line latency-average' }));
    latency.forEach((item, index) => {
      if (item.count === 0) return;
      const x = index * step;
      const y = padTop + plotHeight - (item.average / max) * plotHeight;
      const dot = svgEl('circle', {
        cx: x,
        cy: y,
        r: item.anomalous ? 2.5 : 1.5,
        class: item.anomalous ? 'latency-point anomalous' : 'latency-point',
      });
      const time = bucketTime(range, bucketCount, index);
      const title = svgEl('title');
      title.textContent = `${time !== undefined ? formatClock(time, range) + '\n' : ''}average ${count(Math.round(item.average))} ms, p95 ${count(Math.round(item.p95))} ms`;
      dot.append(title);
      svg.append(dot);
    });
    const axis = xAxisTicks(bucketCount, range, (index) => index * step, width);
    section.append(
      svg,
      axis,
      chartLegend([
        { className: 'swatch-average', label: 'average' },
        { className: 'swatch-p95', label: 'p95' },
      ]),
    );
    return section;
  }

  function sparkline(values: number[]) {
    const el = document.createElement('span');
    el.className = 'sparkline';
    el.setAttribute('aria-hidden', 'true');
    const max = Math.max(1, ...values);
    for (const value of values) {
      const bar = document.createElement('span');
      bar.className = value ? 'sparkline-bar' : 'sparkline-bar empty';
      bar.style.height = `${Math.max(8, (value / max) * 100)}%`;
      el.append(bar);
    }
    return el;
  }

  function section(title: string, className = 'chart-section') {
    const element = document.createElement('section');
    element.className = className;
    const heading = document.createElement('h3');
    heading.textContent = title;
    element.append(heading);
    return element;
  }

  function empty(text: string) {
    const element = document.createElement('p');
    element.className = 'analysis-empty';
    element.textContent = text;
    return element;
  }

  function tile(label: string, value: string, detail?: string, tone?: 'error') {
    const element = document.createElement('div');
    element.className = tone ? `analysis-tile tone-${tone}` : 'analysis-tile';
    const name = document.createElement('span');
    name.className = 'tile-label';
    name.textContent = label;
    const number = document.createElement('strong');
    number.className = 'tile-value';
    number.textContent = value;
    element.append(name, number);
    if (detail) {
      const note = document.createElement('span');
      note.className = 'tile-detail';
      note.textContent = detail;
      element.append(note);
    }
    return element;
  }

  function percent(part: number, whole: number) {
    if (!whole || !part) return '0%';
    const share = (part / whole) * 100;
    return share < 0.1 ? '<0.1%' : share < 10 ? `${share.toFixed(1)}%` : `${Math.round(share)}%`;
  }

  function duration(ms: number) {
    return ms >= 10000 ? `${(ms / 1000).toFixed(ms >= 100000 ? 0 : 1)} s` : `${count(Math.round(ms))} ms`;
  }

  function span(range: AnalysisResult['range']) {
    if (range.from === undefined || range.to === undefined) return undefined;
    const ms = range.to - range.from;
    const minutes = ms / 60000;
    const length =
      minutes < 1
        ? `${Math.max(1, Math.round(ms / 1000))} s`
        : minutes < 120
          ? `${Math.round(minutes)} min`
          : `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)} h`;
    return `${formatClock(range.from, range)} – ${formatClock(range.to, range)} · ${length}`;
  }

  function summaryTiles(analysis: AnalysisResult) {
    const summary = analysis.summary;
    const tiles = document.createElement('div');
    tiles.className = 'analysis-tiles chart-wide';
    if (!summary) return tiles;
    tiles.append(tile('Logs', count(summary.events), span(analysis.range)));
    tiles.append(
      tile(
        'Errors',
        count(summary.errors),
        `${percent(summary.errors, summary.events)} of logs`,
        summary.errors ? 'error' : undefined,
      ),
    );
    if (summary.latency) {
      // The slowest bucket, so a spike in tail latency has a time to look at.
      const peak = (analysis.latency ?? []).reduce<AnalysisResult['latency'][number] | undefined>(
        (worst, item) => (item.count && (!worst || item.p95 > worst.p95) ? item : worst),
        undefined,
      );
      const peakTime = peak && bucketTime(analysis.range, analysis.latency.length, peak.bucket);
      tiles.append(
        tile(
          'p95 latency',
          duration(summary.latency.p95),
          peak && peakTime !== undefined && peak.p95 > summary.latency.p95
            ? `peak ${duration(peak.p95)} at ${formatClock(peakTime, analysis.range)}`
            : `p50 ${duration(summary.latency.p50)} · p99 ${duration(summary.latency.p99)}`,
        ),
      );
    }
    const groups = analysis.errorGroups ?? [];
    const fresh = groups.filter((group) => group.isNew).length;
    tiles.append(
      tile(
        'Error groups',
        count(groups.length),
        fresh ? `${count(fresh)} new in this range` : groups.length ? 'none new' : undefined,
      ),
    );
    if (summary.sources > 1) tiles.append(tile('Sources', count(summary.sources)));
    return tiles;
  }

  /** A clickable row with a proportional bar, for status codes and field values. */
  function barRow(
    label: string,
    value: number,
    total: number,
    max: number,
    target: { term?: string; source?: string },
    tone = '',
  ) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'bar-row';
    if (target.source !== undefined) row.dataset.source = target.source;
    else if (target.term) row.dataset.term = target.term;
    row.title = `${label}: ${count(value)} (${percent(value, total)}). Click to show these events.`;
    const name = document.createElement('span');
    name.className = 'bar-label';
    name.textContent = label;
    const track = document.createElement('span');
    track.className = 'bar-track';
    const fill = document.createElement('span');
    fill.className = `bar-fill${tone ? ` ${tone}` : ''}`;
    fill.style.width = `${Math.max(1, (value / Math.max(1, max)) * 100)}%`;
    track.append(fill);
    const amount = document.createElement('span');
    amount.className = 'bar-count';
    amount.textContent = count(value);
    row.append(name, track, amount);
    return row;
  }

  function statusSection(statusCodes: AnalysisResult['statusCodes']) {
    const element = section('Status codes');
    if (!statusCodes.length) {
      element.append(empty('No status codes in these logs.'));
      return element;
    }
    const total = statusCodes.reduce((sum, item) => sum + item.count, 0);
    const max = Math.max(...statusCodes.map((item) => item.count));
    for (const item of statusCodes.slice(0, 8)) {
      const tone = item.code.startsWith('5') ? 'tone-error' : item.code.startsWith('4') ? 'tone-warn' : '';
      element.append(
        barRow(
          item.code,
          item.count,
          total,
          max,
          { term: /^\d{3}$/.test(item.code) ? `status:${item.code}` : undefined },
          tone,
        ),
      );
    }
    return element;
  }

  function facetSection(facet: FieldValues) {
    const element = section(facet.label === facet.field ? `Top ${facet.label}` : `Top ${facet.label.toLowerCase()}s`);
    const max = Math.max(1, ...facet.values.map((item) => item.count));
    for (const item of facet.values) {
      const target =
        facet.field === 'serverId'
          ? { source: item.value }
          : /^[A-Za-z_][A-Za-z0-9_.]*$/.test(facet.field)
            ? { term: `${facet.field}:${JSON.stringify(item.value)}` }
            : {};
      element.append(barRow(item.label ?? item.value, item.count, facet.total, max, target));
    }
    return element;
  }

  function newBadge() {
    const badge = document.createElement('span');
    badge.className = 'new-pattern';
    badge.textContent = 'New';
    badge.title = 'First seen in the last quarter of this range';
    return badge;
  }

  /** One pattern or error group: share, text, trend, and a way to its events. */
  function groupRow(
    item: LogPattern | ErrorGroup,
    total: number,
    max: number,
    extra: { level?: string; detail?: string },
  ) {
    const row = document.createElement(item.query ? 'button' : 'div');
    if (item.query) (row as HTMLButtonElement).type = 'button';
    row.className = item.query ? 'group-row' : 'group-row static';
    if (item.query) row.dataset.term = item.query;
    row.title = `${item.pattern && item.pattern !== item.message ? `Example: ${item.message}` : item.message}${item.query ? '\nClick to show these events' : ''}`;
    if (extra.level) {
      const level = document.createElement('span');
      level.className = `level ${extra.level}`;
      level.textContent = extra.level;
      row.append(level);
    }
    const amount = document.createElement('span');
    amount.className = 'group-count';
    amount.textContent = count(item.count);
    const share = document.createElement('span');
    share.className = 'group-share';
    share.textContent = percent(item.count, total);
    const shareBar = document.createElement('span');
    shareBar.className = 'group-share-bar';
    shareBar.style.width = `${Math.max(2, (item.count / Math.max(1, max)) * 100)}%`;
    share.append(shareBar);
    const body = document.createElement('span');
    body.className = 'group-body';
    const text = document.createElement('span');
    text.className = 'group-text';
    text.textContent = item.pattern ?? item.message;
    body.append(text);
    if (extra.detail) {
      const detail = document.createElement('span');
      detail.className = 'group-detail';
      detail.textContent = extra.detail;
      body.append(detail);
    }
    row.append(amount, share, body);
    if (item.isNew) row.append(newBadge());
    row.append(sparkline(item.trend ?? []));
    return row;
  }

  function seen(group: ErrorGroup, range: AnalysisResult['range']) {
    const parts = [group.location];
    if (group.first !== undefined && group.last !== undefined)
      parts.push(
        group.first === group.last
          ? `at ${formatClock(group.first, range)}`
          : `${formatClock(group.first, range)} – ${formatClock(group.last, range)}`,
      );
    return parts.filter(Boolean).join(' · ');
  }

  function renderAnalysis(analysis: AnalysisResult) {
    if (!elements.analysisContent) return;
    const content = document.createDocumentFragment();
    const total = analysis.summary?.events ?? analysis.rate.reduce((sum, item) => sum + item.count, 0);
    content.append(summaryTiles(analysis));
    if (analysis.summary?.outside) {
      const note = empty(
        `${count(analysis.summary.outside)} event${analysis.summary.outside === 1 ? ' has a timestamp' : 's have timestamps'} far from the rest, so the charts leave ${analysis.summary.outside === 1 ? 'it' : 'them'} out. Everything else counts ${analysis.summary.outside === 1 ? 'it' : 'them'}.`,
      );
      note.classList.add('chart-wide');
      content.append(note);
    }
    // Volume and latency share one time axis, one under the other, so a spike lines up in both.
    content.append(
      volumeChart(analysis.rate ?? [], analysis.errors ?? [], analysis.range, analysis.warnings),
      latencyChart(analysis.latency ?? [], analysis.range),
    );
    const errorGroups = analysis.errorGroups ?? [];
    const groups = section(
      `Error groups${errorGroups.length ? ` · ${count(errorGroups.length)}` : ''}`,
      'chart-section chart-wide',
    );
    const errorTotal = errorGroups.reduce((sum, item) => sum + item.count, 0);
    const errorMax = Math.max(1, ...errorGroups.map((item) => item.count));
    for (const item of errorGroups.slice(0, 20))
      groups.append(groupRow(item, errorTotal, errorMax, { detail: seen(item, analysis.range) }));
    if (!errorGroups.length) groups.append(empty('No errors in these logs.'));
    content.append(groups);
    const breakdowns = document.createElement('div');
    breakdowns.className = 'analysis-breakdowns chart-wide';
    breakdowns.append(statusSection(analysis.statusCodes ?? []), ...(analysis.topValues ?? []).map(facetSection));
    content.append(breakdowns);
    const patterns = section('Log patterns', 'chart-section chart-wide');
    const patternMax = Math.max(1, ...(analysis.patterns ?? []).map((item) => item.count));
    for (const item of analysis.patterns ?? [])
      patterns.append(groupRow(item, total, patternMax, { level: item.level }));
    if (!analysis.patterns?.length) patterns.append(empty('No data in this range.'));
    content.append(patterns);
    elements.analysisContent.replaceChildren(content);
  }
  return { renderAnalysis };
}
