import { splitContainerPrefix, type ContainerTag } from '../core/container-prefix';
import type { Settings } from '../core/settings';
import { StackJoiner } from './stack-joiner';

export type LineSink = (line: string, truncated: boolean, tag?: ContainerTag) => void;

export interface LinePipelineOptions {
  /** Join plain-text stack traces into one event. */
  join: boolean;
  /** Split Docker Compose and Kubernetes prefixes into per-container lines. */
  containers: boolean;
  limit?: number;
  /** Passed to StackJoiner; zero disables its flush timer. */
  flushMs?: number;
}

/** Pipeline options from the current settings. */
export function linePipelineOptions(config: Settings, limit: number, flushMs?: number): LinePipelineOptions {
  return {
    join: config.get('joinStackTraces', true),
    containers: config.get<string>('containerPrefixes', 'auto') !== 'off',
    limit,
    flushMs,
  };
}

// A runaway number of distinct prefixes is not container output; lines of
// containers beyond it are delivered without joining.
const MAX_CONTAINERS = 64;

/**
 * Frames physical lines into events for one stream. Container prefixes are
 * split off first, and each container gets its own stack-trace joiner, so a
 * trace printed by one service is not merged with lines from another that
 * arrive in between. A held line of one container can therefore be delivered
 * after a later line of another, by at most the joiner's flush delay.
 */
export class LinePipeline {
  private readonly shared?: StackJoiner;
  private readonly joiners = new Map<string, StackJoiner<ContainerTag>>();

  constructor(
    private readonly sink: LineSink,
    private readonly options: LinePipelineOptions,
  ) {
    if (options.join)
      this.shared = new StackJoiner((line, truncated) => sink(line, truncated), options.limit, options.flushMs);
  }

  write(line: string, truncated: boolean): void {
    const split = this.options.containers ? splitContainerPrefix(line) : undefined;
    if (!split) {
      // A line without a prefix never continues a container's trace, and
      // releasing held lines first keeps the two kinds in arrival order.
      for (const joiner of this.joiners.values()) joiner.flush();
      if (this.shared) this.shared.write(line, truncated);
      else this.sink(line, truncated);
      return;
    }
    this.shared?.flush();
    if (!this.options.join) {
      this.sink(split.payload, truncated, split.tag);
      return;
    }
    let joiner = this.joiners.get(split.tag.container);
    if (!joiner && this.joiners.size < MAX_CONTAINERS) {
      joiner = new StackJoiner<ContainerTag>(
        (text, cut, tag) => this.sink(text, cut, tag),
        this.options.limit,
        this.options.flushMs,
      );
      this.joiners.set(split.tag.container, joiner);
    }
    if (joiner) joiner.write(split.payload, truncated, split.tag);
    else this.sink(split.payload, truncated, split.tag);
  }

  /** Release held lines without ending the stream. */
  flush(): void {
    this.shared?.flush();
    for (const joiner of this.joiners.values()) joiner.flush();
  }

  end(): void {
    this.shared?.end();
    for (const joiner of this.joiners.values()) joiner.end();
  }
}
