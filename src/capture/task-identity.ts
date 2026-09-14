import { createHash } from 'node:crypto';
import { slugify } from '../core/server-config';

export function taskIdentity(name: string, type: string, scope?: string): string {
  const digest = createHash('sha256').update(JSON.stringify([scope ?? '', type, name])).digest('hex').slice(0, 16);
  return `task:${slugify(name)}:${digest}`;
}
