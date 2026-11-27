import { testFailures } from '../core/ci-log';
import type { LogStore } from '../core/log-store';
import type { SessionSummary } from '../core/types';
import { looksLikeTestRun } from './dev-command';
import type { Ingestion } from './ingestion';
import type { SessionRegistry } from './session-registry';

/** The tests a finished local run failed, and those an earlier run of the same command failed that it passed. */
export interface TestRunResult {
  record: SessionSummary;
  command: string;
  failed: string[];
  fixed: string[];
}

// Most lines of a run read for its failures, newest kept: a huge suite's start says nothing about what failed.
const MAX_LINES = 50_000;
// Most commands whose failures are remembered between runs.
const MAX_COMMANDS = 100;

/**
 * Reads each finished run of a test command, in a terminal or a task, for the tests its runner
 * says failed, and records each as a `kind:test-failure` event in that run, which marks the test's line in the
 * editor. Remembers what each command failed, so a later run says which of those it passed.
 */
export class TestRuns {
  private readonly read = new Set<string>();
  private readonly failing = new Map<string, Set<string>>();

  constructor(
    private readonly registry: Pick<SessionRegistry, 'records'>,
    private readonly store: Pick<LogStore, 'exportEvents'>,
    private readonly ingestion: Pick<Ingestion, 'accept'>,
  ) {}

  /** Read the test runs that finished since the last check. */
  check(): TestRunResult[] {
    const results: TestRunResult[] = [];
    for (const record of this.registry.records.values()) {
      if (this.read.has(record.id) || !finished(record)) continue;
      this.read.add(record.id);
      const command = record.command?.trim();
      if (!command || !looksLikeTestRun(command)) continue;
      results.push(this.readRun(record, command));
    }
    // Runs that are gone from the registry need not be remembered.
    if (this.read.size > this.registry.records.size * 2 + 100)
      for (const id of this.read) if (!this.registry.records.has(id)) this.read.delete(id);
    return results;
  }

  /** Forget what was read, as when logs are cleared. */
  reset(): void {
    this.failing.clear();
    for (const id of this.registry.records.keys()) this.read.add(id);
  }

  private readRun(record: SessionSummary, command: string): TestRunResult {
    const lines: string[] = [];
    for (const event of this.store.exportEvents({ serverId: record.serverId, sessionId: record.id })) {
      if (event.fields?.kind === 'test-failure') continue;
      for (const line of String(event.message ?? event.raw ?? '').split('\n')) lines.push(line);
    }
    const failures = testFailures(lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines);
    for (const failure of failures)
      this.ingestion.accept(
        JSON.stringify({
          level: 'error',
          message: `Test failed: ${failure.test}`,
          kind: 'test-failure',
          scope: 'local',
          test: failure.test,
          framework: failure.framework,
          command,
          ...(failure.file ? { file: failure.file } : {}),
          ...(failure.line ? { line: failure.line } : {}),
        }),
        'test',
        { serverId: record.serverId, server: record.server, sessionId: record.id },
      );
    const key = `${record.serverId}\0${command}`;
    const before = this.failing.get(key) ?? new Set<string>();
    const failed = failures.map((failure) => failure.test);
    const now = new Set(failed);
    this.failing.delete(key);
    this.failing.set(key, now);
    if (this.failing.size > MAX_COMMANDS) this.failing.delete(this.failing.keys().next().value!);
    return { record, command, failed, fixed: [...before].filter((test) => !now.has(test)) };
  }
}

function finished(record: SessionSummary): boolean {
  return (record.status === 'exited' || record.status === 'failed') && record.captureComplete !== false;
}
