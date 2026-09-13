import type { LogEvent } from '../core/types';
import type { ViewerState } from './state';

export function createTimestampFormatter(state: ViewerState) {
  let cachedFormatter: Intl.DateTimeFormat | null | undefined;

  let cachedFormatterTimezone: string | undefined;

  function timestampFormatter() {
    if (cachedFormatter !== undefined && cachedFormatterTimezone === state.displayTimezone)
      return cachedFormatter;
    const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false };
    if (state.displayTimezone === 'utc')
      options.timeZone = 'UTC';
    else if (state.displayTimezone && state.displayTimezone !== 'local')
      options.timeZone = state.displayTimezone;
    try {
      cachedFormatter = new Intl.DateTimeFormat(undefined, options);
    }
    catch {
      cachedFormatter = null;
    }
    cachedFormatterTimezone = state.displayTimezone;
    return cachedFormatter;
  }

  function formatTimestamp(event: LogEvent) {
    if (!Number.isFinite(event.timestampMs))
      return event.timestamp;
    const formatter = timestampFormatter();
    return formatter ? formatter.format(event.timestampMs!) : event.timestamp;
  }

  return formatTimestamp;
}
