/** Read current settings at use time, so live configuration changes apply. */
export interface Settings { get<T>(key: string, fallback: T): T; }
