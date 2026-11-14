import * as os from 'node:os';
import * as vscode from 'vscode';
import type { AboutAction, AboutInfo } from '../protocol/messages';

const REPOSITORY = 'https://github.com/SurjeetBanga/logline';
const LINKS: Record<Exclude<AboutAction, 'whatsNew' | 'copy'>, string> = {
  sponsor: 'https://github.com/sponsors/SurjeetBanga',
  author: 'https://github.com/SurjeetBanga',
  github: REPOSITORY,
  issue: `${REPOSITORY}/issues/new`,
};

/** What About Logline shows: the version, the editor, and the system. */
export function aboutInfo(version: string, editor: { name: string; version: string }, system: string): AboutInfo {
  return { version: version || 'unknown', editor: `${editor.name} ${editor.version}`, system };
}

/** The details as one block that can be pasted into a bug report. */
export function aboutText(info: AboutInfo): string {
  return [`Logline ${info.version}`, info.editor, info.system].join('\n');
}

/** The About dialog's details for this editor and machine. */
export function currentAbout(version: string): AboutInfo {
  return aboutInfo(
    version,
    { name: vscode.env.appName, version: vscode.version },
    `${os.type()} ${os.arch()} ${os.release()}`,
  );
}

/** A button in the About dialog: open a link, the release notes, or copy the details. */
export async function runAboutAction(action: AboutAction, info?: AboutInfo): Promise<void> {
  if (action === 'whatsNew') await vscode.commands.executeCommand('logline.showWhatsNew');
  else if (action === 'copy') {
    if (!info) return;
    await vscode.env.clipboard.writeText(aboutText(info));
    void vscode.window.showInformationMessage('Copied Logline version details.');
  } else await vscode.env.openExternal(vscode.Uri.parse(LINKS[action]));
}
