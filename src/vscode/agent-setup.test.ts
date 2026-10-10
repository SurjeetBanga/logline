import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { withVscode } from '../test/vscode-mock';
import type { AgentLaunch } from './agent-setup';

const launch: AgentLaunch = {
  command: '/usr/bin/code',
  args: ['/home/me/.logline/mcp.js'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};

interface Answers {
  /** The label chosen in the agent picker, or undefined to close it. */
  agent?: string;
  /** The button chosen in the confirmation dialog, or undefined to dismiss it. */
  button?: string;
}

/** Connect Agent with a VS Code that answers its picker and dialog, in a home folder of its own. */
async function connect(answers: Answers, host?: { name: string; file: string }) {
  const seen = {
    offered: [] as string[],
    clipboard: undefined as string | undefined,
    info: [] as string[],
    warnings: [] as string[],
    terminal: undefined as { name: string; sent: string[]; shown: boolean } | undefined,
  };
  const mock = {
    env: {
      shell: '/bin/zsh',
      clipboard: {
        writeText: async (text: string) => {
          seen.clipboard = text;
        },
      },
    },
    extensions: { getExtension: () => undefined },
    window: {
      showQuickPick: async (items: { label: string }[]) => {
        seen.offered = items.map((item) => item.label);
        return items.find((item) => item.label === answers.agent);
      },
      showInformationMessage: async (message: string, options?: { modal?: boolean }) => {
        if (options?.modal) return answers.button;
        seen.info.push(message);
        return undefined;
      },
      showWarningMessage: async (message: string) => {
        seen.warnings.push(message);
      },
      createTerminal: ({ name }: { name: string }) => {
        seen.terminal = { name, sent: [], shown: false };
        return {
          show: () => {
            seen.terminal!.shown = true;
          },
          sendText: (text: string) => seen.terminal!.sent.push(text),
        };
      },
    },
  };
  delete require.cache[require.resolve('./agent-setup')];
  const { connectAgent } = withVscode(mock, () => require('./agent-setup') as typeof import('./agent-setup'));
  await connectAgent(launch, host);
  return seen;
}

/** Point HOME and the Claude Code config folder at a fresh temporary folder for the duration of `run`. */
async function inHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  const home = mkdtempSync(join(tmpdir(), 'logline-connect-'));
  process.env.HOME = process.env.USERPROFILE = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  try {
    return await run(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('closing the agent picker or the confirmation changes nothing', async () => {
  await inHome(async (home) => {
    const closed = await connect({});
    assert.deepEqual(closed.offered, ['Claude Code', 'Codex', 'Other MCP client']);
    const dismissed = await connect({ agent: 'Claude Code' });
    for (const seen of [closed, dismissed]) {
      assert.equal(seen.clipboard, undefined);
      assert.equal(seen.terminal, undefined);
    }
    assert.equal(existsSync(join(home, '.claude', 'skills')), false, 'no skills before the user agrees');
  });
});

test('another MCP client gets a server entry to paste', async () => {
  const seen = await connect({ agent: 'Other MCP client' });
  assert.deepEqual(JSON.parse(seen.clipboard!).mcpServers.logline, {
    command: '/usr/bin/code',
    args: ['/home/me/.logline/mcp.js'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.match(seen.info[0], /^Copied the Logline MCP server configuration\./);
});

test('Claude Code: Copy Command copies the registration and installs the skills', async () => {
  await inHome(async (home) => {
    const seen = await connect({ agent: 'Claude Code', button: 'Copy Command' });
    assert.match(seen.clipboard!, /^claude mcp add .* logline -- /);
    assert.ok(existsSync(join(home, '.claude', 'skills', 'logline-verify', 'SKILL.md')));
    assert.match(seen.info[0], /^Copied\. Run it in a terminal to add Logline to Claude Code\./);
    assert.match(seen.info[0], /Try \/logline-\w+/, 'Claude Code starts a skill with /');
    assert.equal(seen.terminal, undefined);
  });
});

test('Codex: Run in Terminal sends the registration to a new terminal', async () => {
  await inHome(async (home) => {
    const seen = await connect({ agent: 'Codex', button: 'Run in Terminal' });
    assert.equal(seen.terminal?.name, 'Logline · Codex');
    assert.equal(seen.terminal?.shown, true);
    assert.equal(seen.terminal?.sent.length, 1);
    assert.match(seen.terminal!.sent[0], /^codex mcp add logline /);
    assert.ok(existsSync(join(home, '.agents', 'skills', 'logline-verify', 'SKILL.md')));
    assert.match(seen.info[0], /Try \$logline-\w+/, 'Codex starts a skill with $');
    assert.equal(seen.clipboard, undefined);
  });
});

test('a skills folder that cannot be written is reported, and the agent is still connected', async () => {
  await inHome(async (home) => {
    // A file where the skills folder should be.
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'skills'), '');
    const seen = await connect({ agent: 'Claude Code', button: 'Copy Command' });
    assert.match(seen.warnings[0], /^Logline could not add its skills to /);
    assert.match(seen.clipboard!, /^claude mcp add /);
    assert.doesNotMatch(seen.info[0], /Try /, 'no skill to suggest');
  });
});

test("the editor's own agent gets Logline added to its MCP file, keeping other servers", async () => {
  await inHome(async (home) => {
    const host = { name: 'Cursor', file: join(home, '.cursor', 'mcp.json') };
    const declined = await connect({ agent: 'Cursor agent' }, host);
    assert.equal(declined.offered[0], 'Cursor agent', "the editor's agent is offered first");
    assert.equal(existsSync(host.file), false, 'declining writes nothing');

    // A new file is created with the folder Cursor opened, so the server picks this window's logs.
    await connect({ agent: 'Cursor agent', button: 'Add Server' }, host);
    let config = JSON.parse(readFileSync(host.file, 'utf8'));
    assert.deepEqual(config.mcpServers.logline.args, ['/home/me/.logline/mcp.js', '--workspace', '${workspaceFolder}']);

    writeFileSync(host.file, JSON.stringify({ mcpServers: { other: { command: 'other' } }, theme: 'dark' }));
    const added = await connect({ agent: 'Cursor agent', button: 'Add Server' }, host);
    config = JSON.parse(readFileSync(host.file, 'utf8'));
    assert.deepEqual(Object.keys(config.mcpServers), ['other', 'logline']);
    assert.equal(config.theme, 'dark');
    assert.match(added.info[0], /^Added Logline to .*mcp\.json\./);
  });
});

test('an MCP file that is not a JSON object is left alone, and the entry is copied instead', async () => {
  await inHome(async (home) => {
    const host = { name: 'Kiro', file: join(home, '.kiro', 'settings', 'mcp.json') };
    mkdirSync(join(home, '.kiro', 'settings'), { recursive: true });
    writeFileSync(host.file, '[1, 2]');
    const seen = await connect({ agent: 'Kiro agent', button: 'Add Server' }, host);
    assert.equal(readFileSync(host.file, 'utf8'), '[1, 2]');
    assert.match(seen.warnings[0], /did not change .* because it is not a JSON object/);
    assert.ok(JSON.parse(seen.clipboard!).mcpServers.logline);
  });
});
