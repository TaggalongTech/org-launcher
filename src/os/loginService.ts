/**
 * Starting the launcher's server at login: launchd on macOS, systemd on Linux, Task Scheduler on Windows.
 * Nothing is registered at install; only after a yes at the first `sf launcher` run, or `start --at-login`.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchdService } from './launchd.js';
import { schtasksService } from './schtasks.js';
import { systemdService } from './systemd.js';

/** What a registered service runs. A field is null when the service file doesn't say or can't be read. */
export type Registration = { nodePath: string | null; serverJs: string | null; home: string | null };

export type LoginService = {
  /**
   * Writes the service file for `node serverJs` (run in home) and starts it now. Replaces an earlier one.
   * When the service won't start, nothing is left registered.
   */
  register: (nodePath: string, serverJs: string, home: string) => Promise<void>;
  /** Stops the service and removes its file. */
  unregister: () => Promise<void>;
  /** What the registered service runs; null when none is registered. */
  registration: () => Promise<Registration | null>;
  /**
   * True when registration() reads node, the server and the folder back from the service file. False on
   * Windows: a scheduled task can't carry the folder, so its registration is all nulls.
   */
  readsBack: boolean;
  /** Starts the registered service now, after a stop. */
  start: () => Promise<void>;
  /** Stops the service until the next login; it stays registered. */
  stop: () => Promise<void>;
};

/** A login service failure, written for people. */
export class LoginServiceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LoginServiceError';
  }
}

export type RunResult = { code: number; stdout: string; stderr: string };
/** Runs a program with its arguments (never through a shell). Resolves with its exit code, even a failing one. */
export type Run = (cmd: string, args: string[]) => Promise<RunResult>;

/** Waits ms milliseconds. */
export type Pause = (ms: number) => Promise<void>;

/** Where the service lives, for tests: the user's home folder, user id and environment, and how to wait. */
export type ServicePlace = { userHome?: string; uid?: number; env?: NodeJS.ProcessEnv; pause?: Pause };

export const pauseFor: Pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RUN_TIMEOUT_MS = 30_000;

/** The real Run. A program that can't be started answers with exit code -1. */
export const runCommand: Run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: RUN_TIMEOUT_MS }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
  });

/** Runs a command that must work. A failure throws "<what>: <cmd> <subcommand> failed (exit n)." */
export async function mustRun(run: Run, what: string, cmd: string, args: string[]): Promise<void> {
  const { code } = await run(cmd, args);
  const subcommand = args.find((arg) => !arg.startsWith('--')) ?? '';
  if (code !== 0) throw new LoginServiceError(`${what}: ${cmd} ${subcommand} failed (exit ${code}).`);
}

/** Service files are line-based, so a line break in a path could add a line of its own. */
export function refuseLineBreaks(...paths: string[]): void {
  if (paths.some((path) => /[\r\n\0]/.test(path))) {
    throw new LoginServiceError("Can't start Org Launcher at login from a path with a line break in it.");
  }
}

/** The login service for this platform. */
export function loginServiceFor(
  platform: NodeJS.Platform = process.platform,
  run: Run = runCommand,
  place: ServicePlace = {}
): LoginService {
  const userHome = place.userHome ?? homedir();
  const env = place.env ?? process.env;
  if (platform === 'darwin') {
    return launchdService({
      run,
      userHome,
      uid: place.uid ?? process.getuid?.() ?? 0,
      path: env.PATH,
      pause: place.pause ?? pauseFor,
    });
  }
  if (platform === 'linux') {
    // An empty XDG_CONFIG_HOME counts as unset, as systemd reads it.
    const xdg = env.XDG_CONFIG_HOME;
    return systemdService({
      run,
      configHome: xdg !== undefined && xdg !== '' ? xdg : join(userHome, '.config'),
      path: env.PATH,
    });
  }
  if (platform === 'win32') return schtasksService(run);
  throw new LoginServiceError('Starting at login works on macOS, Linux and Windows.');
}
