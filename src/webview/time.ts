import type { LogEvent } from '../core/types';
import type { ViewerState } from './state';

/** The `timeZone` option for the display setting; `local` or none uses the machine's. */
export function timeZoneOption(displayTimezone: string): { timeZone?: string } {
  if (displayTimezone === 'utc') return { timeZone: 'UTC' };
  return displayTimezone && displayTimezone !== 'local' ? { timeZone: displayTimezone } : {};
}

/** A formatted time without its fraction, which some locales set off with a comma. */
export function withoutFraction(time: string): string {
  return time.replace(/[.,]\d+$/, '');
}

/** A formatted time down to the minute. */
export function withoutSeconds(time: string): string {
  return time.replace(/:\d\d[.,]\d+$/, '');
}

export function createTimestampFormatter(state: ViewerState) {
  let cachedFormatter: Intl.DateTimeFormat | null | undefined;

  let cachedFormatterTimezone: string | undefined;

  function timestampFormatter() {
    if (cachedFormatter !== undefined && cachedFormatterTimezone === state.displayTimezone) return cachedFormatter;
    const options: Intl.DateTimeFormatOptions = {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hourCycle: 'h23',
      ...timeZoneOption(state.displayTimezone),
    };
    try {
      cachedFormatter = new Intl.DateTimeFormat(undefined, options);
    } catch {
      cachedFormatter = null;
    }
    cachedFormatterTimezone = state.displayTimezone;
    return cachedFormatter;
  }

  function formatTimestamp(event: LogEvent) {
    if (!Number.isFinite(event.timestampMs)) return event.timestamp;
    const formatter = timestampFormatter();
    return formatter ? formatter.format(event.timestampMs!) : event.timestamp;
  }

  return formatTimestamp;
}
