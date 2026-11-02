/**
 * Opens a link in the system's default browser, or in a chosen browser and profile.
 * Links here can carry a login session: they are never logged, never put in an error message,
 * and only ever passed to the browser as a single argument, never through a shell string.
 */
import { spawn } from 'node:child_process';
import { Logger } from '@salesforce/core';
import type { Browser, OpenTarget } from '../core/state.js';

export type Launch = { cmd: string; args: string[] };
/** Starts a launch command detached, with no output. Never logs its arguments. */
export type Spawner = (l: Launch) => Promise<void>;

type BrowserInfo = { name: string; darwinApp: string; linux: string; windows: string; chromium: boolean };

const BROWSERS: Record<Browser, BrowserInfo> = {
  chrome: { name: 'Google Chrome', darwinApp: 'Google Chrome', linux: 'google-chrome', windows: 'chrome', chromium: true },
  edge: { name: 'Microsoft Edge', darwinApp: 'Microsoft Edge', linux: 'microsoft-edge', windows: 'msedge', chromium: true },
  brave: { name: 'Brave Browser', darwinApp: 'Brave Browser', linux: 'brave-browser', windows: 'brave', chromium: true },
  firefox: { name: 'Firefox', darwinApp: 'Firefox', linux: 'firefox', windows: 'firefox', chromium: false },
};

/** Each Chromium browser and its macOS app name: the browsers that can open a page as its own window. */
export function darwinChromiumApps(): Array<[Browser, string]> {
  return Object.entries(BROWSERS)
    .filter(([, info]) => info.chromium)
    .map(([browser, info]) => [browser as Browser, info.darwinApp]);
}

/** Commands that hand the link to another program and exit at once, so their exit code says if it worked. */
const HAND_OFF_COMMANDS = new Set(['open', 'cmd']);

/** The browser's own arguments: profile first, then the link. App mode is a Chromium feature only. */
function browserArgs(url: string, target: OpenTarget, appMode: boolean): string[] {
  const info = BROWSERS[target.browser];
  if (!info.chromium) {
    return [...(target.profile ? ['-P', target.profile] : []), '-new-tab', url];
  }
  return [...(target.profile ? [`--profile-directory=${target.profile}`] : []), appMode ? `--app=${url}` : url];
}

/** The command and arguments that open url in target on platform. Null target means the default browser. */
export function launchCommand(url: string, target: OpenTarget | null, platform: NodeJS.Platform, appMode = false): Launch {
  if (platform === 'win32') {
    const rest = target ? [BROWSERS[target.browser].windows, ...browserArgs(url, target, appMode)] : [url];
    return { cmd: 'cmd', args: ['/c', 'start', '', ...rest] }; // '' is start's window title
  }
  if (platform === 'darwin') {
    if (!target) return { cmd: 'open', args: [url] };
    return { cmd: 'open', args: ['-na', BROWSERS[target.browser].darwinApp, '--args', ...browserArgs(url, target, appMode)] };
  }
  if (!target) return { cmd: 'xdg-open', args: [url] };
  return { cmd: BROWSERS[target.browser].linux, args: browserArgs(url, target, appMode) };
}

/** Plain words that cmd.exe reads as themselves; anything else is wrapped in double quotes. */
const CMD_PLAIN = /^[A-Za-z0-9/._-]+$/;

/**
 * Builds the argument line for `cmd` on Windows. cmd.exe reads & | < > ^ as operators unless they sit
 * inside double quotes, and Node only adds quotes around spaces, so every argument that isn't a plain
 * word is quoted here. An argument with a double quote in it can't be quoted safely and is refused.
 */
export function windowsCommandLine(l: Launch): string {
  return l.args
    .map((arg) => {
      if (CMD_PLAIN.test(arg)) return arg;
      if (arg.includes('"')) throw new Error("Couldn't open that link on Windows: it has a double quote in it.");
      return `"${arg}"`;
    })
    .join(' ');
}

/**
 * Starts a launch command detached from this process with its output ignored. For commands that hand
 * off and exit (open, cmd start), waits for the exit code; for a browser started directly, starting is enough.
 */
export function spawnDetached(l: Launch, waitForExit = HAND_OFF_COMMANDS.has(l.cmd)): Promise<void> {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32' && l.cmd === 'cmd';
    const child = windows
      ? spawn(l.cmd, [windowsCommandLine(l)], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true })
      : spawn(l.cmd, l.args, { detached: true, stdio: 'ignore' });
    // Our own errors only: Node's carry the full argument list, link included.
    child.once('error', () => reject(new Error(`could not start ${l.cmd}`)));
    if (waitForExit) {
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${l.cmd} exited with code ${String(code)}`))));
    } else {
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    }
  });
}

const defaultLog = (message: string): void => void Logger.childFromRoot('org-launcher').debug(message);

/** Only web links are opened, so a link can never be read as a browser or command option. */
function isWebLink(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Opens url in target (null: the system's default browser) on this machine. appMode opens a Chromium
 * browser's page as its own window; other browsers and the default browser open a normal tab.
 */
export async function openUrl(
  url: string,
  target: OpenTarget | null,
  spawner: Spawner = spawnDetached,
  log: (message: string) => void = defaultLog,
  appMode = false
): Promise<void> {
  if (!isWebLink(url)) throw new Error("That link isn't a web address, so it wasn't opened.");
  const browser = target ? BROWSERS[target.browser].name : 'the default browser';
  const where = target?.profile ? `${browser} (${target.profile})` : browser;
  log(`opening an org in ${where}`);
  try {
    await spawner(launchCommand(url, target, process.platform, appMode));
  } catch {
    // Never pass the original error on: it can hold the command's arguments, and so the link.
    log(`could not open ${where}`);
    throw new Error(
      target ? `Couldn't open ${browser}. Check that it's installed, then try again.` : "Couldn't open your default browser."
    );
  }
}
