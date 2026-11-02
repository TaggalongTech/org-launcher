/**
 * What the `sf launcher` commands share: the outside effects they use (swapped for fakes in tests),
 * and starting, waiting for and stopping the background server.
 */
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Errors } from '@oclif/core';
import { Logger, SfError } from '@salesforce/core';
import { SfCommand } from '@salesforce/sf-plugins-core';
import { sfAuthSource } from './core/auth.js';
import { PortInUseError, serverState, ServerError, UnknownOrgError, type OrgSummary, type ServerState } from './core/client.js';
import type { OrgLogin } from './core/orgs.js';
import { StateBusyError, type OpenTarget } from './core/state.js';
import { ValidationError } from './core/validate.js';
import { openUrl } from './os/browser.js';
import type { DockOptions } from './os/dockApp.js';
import { LoginServiceError, loginServiceFor, type LoginService, type Registration } from './os/loginService.js';
import { StartError, startDetached, stopServer } from './os/process.js';

export type DockModule = {
  buildDockApp: (home: string, opts: DockOptions) => Promise<string>;
  removeDockApp: () => Promise<void>;
  hasDockApp: () => boolean;
};

export type CommandDeps = {
  platform: NodeJS.Platform;
  cwd: () => string;
  /** True when a person can answer questions: stdin and stdout are terminals. */
  interactive: () => boolean;
  /** Asks a yes/no question; Enter means yes. */
  ask: (question: string) => Promise<boolean>;
  logins: () => Promise<OrgLogin[]>;
  startDetached: typeof startDetached;
  stopServer: typeof stopServer;
  loginService: () => LoginService;
  /** The Dock app module, loaded only when it's needed. */
  dock: () => Promise<DockModule>;
  open: (url: string, target: OpenTarget | null, appMode: boolean) => Promise<void>;
  /** The node the server runs on; one that outlives sf CLI updates when there is one (stableNodePath). */
  nodePath: string;
};

const debug = (message: string): void => void Logger.childFromRoot('org-launcher').debug(message);

/**
 * Asks on the terminal and waits for an answer. sf-plugins-core's confirm takes its default answer after
 * a timeout; here only a person's answer counts, so nothing is ever registered without one.
 */
function askOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let answered = false;
    rl.on('SIGINT', () => {
      rl.close();
      process.exit(130);
    });
    rl.on('close', () => {
      if (!answered) resolve(false);
    });
    rl.question(`${question} `, (text) => {
      answered = true;
      rl.close();
      resolve(/^(y|yes)?$/i.test(text.trim()));
    });
  });
}

/**
 * The node to run the server on. The sf CLI installers run on their own node inside
 * <data>/client/<version>/bin/, and an update deletes old version folders, so the login service would
 * lose its node. The client folder's `current` link always points at the newest one: when execPath is
 * in a version folder and current/bin/node is there, that path is used instead.
 */
export function stableNodePath(execPath: string, exists: (path: string) => boolean = existsSync): string {
  const match = /^(.*[\\/]client)([\\/])([^\\/]+)[\\/]bin[\\/](node(?:\.exe)?)$/i.exec(execPath);
  if (!match || match[3] === 'current') return execPath;
  const [, client, sep, , node] = match;
  const current = [client, 'current', 'bin', node].join(sep);
  return exists(current) ? current : execPath;
}

function realDeps(): CommandDeps {
  return {
    platform: process.platform,
    cwd: () => process.cwd(),
    interactive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
    ask: askOnTerminal,
    logins: () => sfAuthSource({ log: debug }).listLogins(),
    startDetached,
    stopServer,
    loginService: () => loginServiceFor(),
    dock: async () => import('./os/dockApp.js'),
    open: (url, target, appMode) => openUrl(url, target, undefined, undefined, appMode),
    nodePath: stableNodePath(process.execPath),
  };
}

let current = realDeps();

export function commandDeps(): CommandDeps {
  return current;
}

/** For tests: replaces some of the outside effects. */
export function setCommandDeps(patch: Partial<CommandDeps>): void {
  current = { ...current, ...patch };
}

export function resetCommandDeps(): void {
  current = realDeps();
}

const START_WAIT_MS = 5000;
const POLL_MS = 100;

export const pageUrl = (port: number): string => `http://localhost:${port}`;

/**
 * This plugin's own folder, found from this file (lib/ when installed, src/ under tests), never from
 * oclif's config: a command's `this.config` is the sf CLI's, not this plugin's.
 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The built server script inside this plugin. */
export const serverScript = (): string => join(PACKAGE_ROOT, 'lib', 'server', 'main.js');

/**
 * The login service as this launcher folder sees it: none, ours (it runs the server for this folder),
 * or another folder's (ORG_LAUNCHER_HOME was different when it was registered), which is never touched.
 * On Windows the task can't say its folder, so a registered task always counts as ours.
 * A service that can't be checked counts as none.
 */
export type AtLogin =
  | { state: 'none' }
  | { state: 'ours'; registration: Registration; readsBack: boolean }
  | { state: 'other'; home: string | null };

export async function atLogin(deps: CommandDeps, home: string): Promise<AtLogin> {
  try {
    const service = deps.loginService();
    const registration = await service.registration();
    if (registration === null) return { state: 'none' };
    if (!service.readsBack || (registration.home !== null && resolvePath(registration.home) === resolvePath(home))) {
      return { state: 'ours', registration, readsBack: service.readsBack };
    }
    return { state: 'other', home: registration.home };
  } catch {
    debug("couldn't check the login service");
    return { state: 'none' };
  }
}

/** True when the login service runs the server for this launcher folder. */
export async function startsAtLogin(deps: CommandDeps, home: string): Promise<boolean> {
  return (await atLogin(deps, home)).state === 'ours';
}

/** Said when another launcher folder's login service is registered. */
export function atLoginElsewhere(other: string | null): string {
  return (
    `Org Launcher already starts at login for ${other ?? 'another folder'}. ` +
    'Run sf launcher uninstall with ORG_LAUNCHER_HOME set to that folder first.'
  );
}

/**
 * Starts the server: through the login service when it runs this folder's server, else as a detached
 * process. A login service that won't start falls back to a detached server, so the page still opens.
 */
export async function startServer(deps: CommandDeps, serverJs: string, home: string): Promise<void> {
  if (await startsAtLogin(deps, home)) {
    try {
      await deps.loginService().start();
      return;
    } catch {
      debug("the login service didn't start; starting the server on its own");
    }
  }
  try {
    await deps.startDetached(deps.nodePath, serverJs, home);
  } catch (error) {
    throw toSfError(error);
  }
}

/** Waits up to 5 s for Org Launcher to answer on port; returns the last state seen. */
export async function waitForServer(port: number): Promise<ServerState> {
  const deadline = Date.now() + START_WAIT_MS;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const state = await serverState(port);
    if (state === 'ours' || Date.now() >= deadline) return state;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Registers the login service, which starts its own server. A server this command started detached is
 * stopped first, so the two never fight over the port. When registering fails, nothing is left
 * registered and the server starts again on its own, so the page keeps working; the error says why.
 * Another folder's login service is never replaced.
 */
export async function registerAtLogin(deps: CommandDeps, serverJs: string, home: string): Promise<void> {
  const service = await atLogin(deps, home);
  if (service.state === 'other') throw new UserError(atLoginElsewhere(service.home), 'AtLoginElsewhere');
  await deps.stopServer(home);
  try {
    await deps.loginService().register(deps.nodePath, serverJs, home);
  } catch (error) {
    try {
      await deps.startDetached(deps.nodePath, serverJs, home);
    } catch {
      debug("couldn't start the server again after registering failed");
    }
    throw toSfError(error);
  }
}

/**
 * Registers the login service again, quietly, when it runs another node or server than this command
 * would register (the sf CLI updated, or the plugin moved). Consent was given when it was registered.
 * True when it re-registered, or tried to: the server is starting either way.
 */
export async function healAtLogin(deps: CommandDeps, serverJs: string, home: string): Promise<boolean> {
  const service = await atLogin(deps, home);
  if (service.state !== 'ours' || !service.readsBack) return false;
  const { nodePath, serverJs: registered } = service.registration;
  if (nodePath === deps.nodePath && registered === serverJs) return false;
  try {
    await registerAtLogin(deps, serverJs, home);
    debug('registered the login service again with the current node and server');
  } catch {
    debug("couldn't register the login service again");
  }
  return true;
}

/** Stops the server however it runs. True when the login service was registered (it starts again at login). */
export async function stopEverything(deps: CommandDeps, home: string): Promise<{ stopped: boolean; atLogin: boolean }> {
  const ours = await startsAtLogin(deps, home);
  if (ours) {
    try {
      await deps.loginService().stop();
    } catch (error) {
      throw toSfError(error);
    }
  }
  const stopped = await deps.stopServer(home);
  return { stopped: ours || stopped, atLogin: ours };
}

/** An error whose message is written for people. It's printed as is, with no "Error (...)" label, and exits 1. */
export class UserError extends SfError {
  public constructor(message: string, name = 'UserError') {
    super(message, name, undefined, 1);
  }
}

/** Errors with a message written for people become UserErrors; others pass through. */
export function toSfError(error: unknown): unknown {
  const known = [PortInUseError, UnknownOrgError, ServerError, ValidationError, StateBusyError, LoginServiceError, StartError];
  if (known.some((type) => error instanceof type)) {
    const { name, message } = error as Error;
    return new UserError(message, name);
  }
  return error;
}

/** The base of every `sf launcher` command: a UserError prints only its message. */
export abstract class LauncherCommand<T> extends SfCommand<T> {
  protected async catch(error: Error | SfError | Errors.CLIError): Promise<never> {
    if (!(error instanceof UserError) || this.jsonEnabled()) return super.catch(error);
    process.exitCode = 1;
    this.logToStderr(error.message);
    // Printed already: oclif must not print it again.
    throw Object.assign(error, { skipOclifErrorHandling: true, oclif: { exit: 1 } });
  }
}

export const portInUse = (port: number): unknown => toSfError(new PortInUseError(port));

/** The lines `tag` and `note` print about an org. */
export function orgLines(org: string, summary: OrgSummary): string[] {
  return [
    org,
    `  Tags: ${summary.tags.length > 0 ? summary.tags.join(', ') : 'none'}`,
    `  Note: ${summary.note === '' ? 'none' : summary.note}`,
  ];
}
