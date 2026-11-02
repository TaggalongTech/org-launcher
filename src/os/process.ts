/**
 * Starts and stops the launcher's server as a plain background process, for when no login service runs it.
 * The server writes server.pid once it listens and removes it when it stops.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const PID_FILE = 'server.pid';
const STOP_WAIT_MS = 5000;
/** How the server's script path ends, which its command line must show before we stop it. */
const SERVER_SCRIPT = /server[\\/]main\.js/;

/** The server couldn't be started; the message is written for people. */
export class StartError extends Error {
  public constructor() {
    super("Couldn't start Org Launcher's server.");
    this.name = 'StartError';
  }
}

/** Starts `node serverJs` detached from this process, in home and with its output ignored. Returns its pid. */
export function startDetached(nodePath: string, serverJs: string, home: string): Promise<number> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [serverJs], {
      cwd: home,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ORG_LAUNCHER_HOME: home },
    });
    child.once('error', () => reject(new StartError()));
    child.once('spawn', () => {
      child.unref();
      if (child.pid === undefined) reject(new StartError());
      else resolve(child.pid);
    });
  });
}

/** Reads a process's command line; null when it can't be read. */
export type CommandLineReader = (pid: number) => Promise<string | null>;

/**
 * Stops the server named in home's server.pid and waits for it to exit. True when a server was stopped.
 * A pid file left behind by a server that died is removed, and so is one whose pid now belongs to
 * some other program (the number was reused). A process whose command line can't be read is never
 * stopped, and its pid file stays: it may still be the server.
 */
export async function stopServer(home: string, readCommandLine: CommandLineReader = commandLine): Promise<boolean> {
  const file = join(home, PID_FILE);
  const pid = readPid(file);
  if (pid === null) return false;
  if (!isAlive(pid)) {
    removePidFile(file, pid);
    return false;
  }
  const line = await readCommandLine(pid);
  if (line === null) return false;
  if (!SERVER_SCRIPT.test(line)) {
    removePidFile(file, pid);
    return false;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // It exited on its own.
  }
  if (!(await exited(pid, STOP_WAIT_MS))) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // It exited just now.
    }
    await exited(pid, STOP_WAIT_MS);
  }
  removePidFile(file, pid);
  return true;
}

function readPid(file: string): number | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
  return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

/** True while the process exists and is ours to signal. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The command that prints a process's command line: ps on macOS and Linux, PowerShell's Win32_Process
 * on Windows. pid is a whole number read from the pid file, so it's safe in the PowerShell filter.
 */
export function commandLineQuery(pid: number, platform: NodeJS.Platform): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
    };
  }
  return { cmd: 'ps', args: ['-o', 'command=', '-p', String(pid)] };
}

/** The process's command line, from ps or PowerShell; null when that fails. */
function commandLine(pid: number): Promise<string | null> {
  const { cmd, args } = commandLineQuery(pid, process.platform);
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

async function exited(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/** Removes the pid file if it still names pid. */
function removePidFile(file: string, pid: number): void {
  if (readPid(file) !== pid) return;
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}
