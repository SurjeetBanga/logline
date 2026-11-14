import * as path from 'node:path';

type Environment = Record<string, string | undefined>;

// Chrome first, since it is what most people test in; then the other Chromium browsers.
const MAC_APPS = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'Chromium.app/Contents/MacOS/Chromium',
  'Brave Browser.app/Contents/MacOS/Brave Browser',
];
const WINDOWS_APPS = [
  'Google\\Chrome\\Application\\chrome.exe',
  'Microsoft\\Edge\\Application\\msedge.exe',
  'Chromium\\Application\\chrome.exe',
  'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
];
const LINUX_COMMANDS = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'microsoft-edge-stable',
  'brave-browser',
];

/** Where Chrome, Edge, Chromium, and Brave are usually installed on this platform, most wanted first. */
export function browserCandidates(platform: string, env: Environment): string[] {
  if (platform === 'darwin') {
    const roots = ['/Applications', ...(env.HOME ? [path.posix.join(env.HOME, 'Applications')] : [])];
    return MAC_APPS.flatMap((app) => roots.map((root) => path.posix.join(root, app)));
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
      (root): root is string => !!root,
    );
    return WINDOWS_APPS.flatMap((app) => roots.map((root) => path.win32.join(root, app)));
  }
  const folders = (env.PATH ?? '').split(':').filter((folder) => path.posix.isAbsolute(folder));
  return LINUX_COMMANDS.flatMap((command) => folders.map((folder) => path.posix.join(folder, command)));
}

/**
 * The browser to launch: the configured one when it exists, else the first installed of Chrome, Edge,
 * Chromium, and Brave. A configured path that does not exist finds nothing, rather than silently
 * opening a different browser.
 */
export function locateBrowser(
  platform: string,
  env: Environment,
  exists: (file: string) => boolean,
  configured?: string,
): string | undefined {
  const chosen = configured?.trim();
  if (chosen) return exists(chosen) ? chosen : undefined;
  return browserCandidates(platform, env).find(exists);
}
