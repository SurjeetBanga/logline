import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

interface Step {
  id: string;
  description: string;
  media: { markdown?: string };
  completionEvents: string[];
}

test('the Welcome page walkthrough links only commands and settings that exist, and each step has its page', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    contributes: {
      commands: { command: string }[];
      configuration: { properties: Record<string, unknown> }[];
      walkthroughs: { steps: Step[] }[];
    };
  };
  const commands = new Set(manifest.contributes.commands.map((command) => command.command));
  const settings = new Set(manifest.contributes.configuration.flatMap((category) => Object.keys(category.properties)));
  const [walkthrough] = manifest.contributes.walkthroughs;
  assert.equal(walkthrough.steps.length, 5);
  for (const step of walkthrough.steps) {
    assert.ok(step.media.markdown && existsSync(step.media.markdown), `${step.id} has its page`);
    for (const [, command] of step.description.matchAll(/\(command:([\w.]+)\)/g))
      assert.ok(commands.has(command), `${step.id} links to unknown command ${command}`);
    for (const event of step.completionEvents) {
      const [kind, name] = event.split(':');
      if (kind === 'onCommand') assert.ok(commands.has(name), `${step.id} waits for unknown command ${name}`);
      if (kind === 'onSettingChanged') assert.ok(settings.has(name), `${step.id} waits for unknown setting ${name}`);
    }
  }
});
