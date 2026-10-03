import { stripAnsi } from './log-event';

/** Where a prefixed line came from: a Docker Compose service or a Kubernetes container. */
export interface ContainerTag {
  /** The source name: the Compose service without its replica number, or the Kubernetes container. */
  service: string;
  /** The full container label as printed, such as `api-1` or `pod/api-7d9f/api`. */
  container: string;
  pod?: string;
  /** The timestamp Docker printed before the payload (`--timestamps`), in epoch ms. */
  time?: number;
}

// `docker compose up` / `docker compose logs`: the container name padded to a
// shared column, then `|`. Compose v2 prints `api-1`, v1 `project_api_1`. The
// replica number is required so ordinary text such as `a | b` is left alone.
const COMPOSE = /^([A-Za-z0-9][\w.-]{0,127}) +\| ?/;
const REPLICA = /[-_](\d{1,4})$/;
// `kubectl logs --prefix` (and `--all-containers`): `[pod/<pod>/<container>] `.
const KUBERNETES = /^\[pod\/([^/\]\s]{1,253})\/([^\]\s]{1,63})\] ?/;
// `--timestamps` puts an RFC 3339 time with up to nanosecond precision first.
const DOCKER_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}) /;

/**
 * Split a container log prefix from a line, so the payload can be parsed as
 * JSON, logfmt or text like any other line. Returns undefined for lines
 * without a recognized prefix.
 */
export function splitContainerPrefix(line: string): { tag: ContainerTag; payload: string } | undefined {
  // Only the prefix region needs to be free of color codes; parsing strips the rest.
  const text = line.includes('\x1b') ? stripAnsi(line) : line;
  let tag: ContainerTag;
  let rest: string;
  const kubernetes = KUBERNETES.exec(text);
  if (kubernetes) {
    tag = { service: kubernetes[2], container: `pod/${kubernetes[1]}/${kubernetes[2]}`, pod: kubernetes[1] };
    rest = text.slice(kubernetes[0].length);
  } else {
    const compose = COMPOSE.exec(text);
    if (!compose || !REPLICA.test(compose[1])) return undefined;
    const container = compose[1];
    let service = container.replace(REPLICA, '');
    // Compose v1 names containers `<project>_<service>_<n>`.
    if (container.includes('_') && !container.includes('-')) service = service.slice(service.indexOf('_') + 1) || service;
    tag = { service, container };
    rest = text.slice(compose[0].length);
  }
  const time = DOCKER_TIME.exec(rest);
  if (time) {
    // Date parses at most millisecond precision.
    const parsed = Date.parse(`${time[1]}.${(time[2] ?? '').padEnd(3, '0').slice(0, 3)}${time[3]}`);
    if (Number.isFinite(parsed)) { tag.time = parsed; rest = rest.slice(time[0].length); }
  }
  return { tag, payload: rest };
}
