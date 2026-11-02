/**
 * Starts the launcher's server in the background process: on 127.0.0.1 at the port from settings,
 * with server.pid and server.log in the launcher's folder, and a refresh at start and every 10 minutes.
 * Run: node lib/server/main.js
 */
import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lifecycle } from '@salesforce/core';
import { sfAuthSource } from '../core/auth.js';
import { sfOrgQuery } from '../core/checks.js';
import { Inventory } from '../core/inventory.js';
import { sfLoginUrl } from '../core/loginUrl.js';
import { launcherHome, StateStore } from '../core/state.js';
import { openUrl } from '../os/browser.js';
import { createServer } from './http.js';

const REFRESH_EVERY_MS = 10 * 60_000;
/** server.log is moved to server.log.1 at start once it's bigger than this; only one old log is kept. */
export const MAX_LOG_BYTES = 1024 * 1024;
const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));
const WEB_DIR = fileURLToPath(new URL('../../web', import.meta.url));

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version?: unknown };
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

/** Appends a timestamped line to server.log. Logging must never stop the server. */
function fileLog(file: string): (line: string) => void {
  return (line) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // Nowhere better to say it.
    }
  };
}

/** Moves a log bigger than maxBytes to <log>.1, replacing an older one, so the log never grows for long. */
export function rotateLog(file: string, maxBytes = MAX_LOG_BYTES): void {
  try {
    if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
  } catch {
    // No log yet, or it can't be moved: logging goes on as before.
  }
}

/**
 * Warnings are logged by name only. @salesforce/core's warnings can name a username ("The auth file
 * for ... is invalid"), and Node's default handler would print them in full.
 */
function quietWarnings(log: (line: string) => void): void {
  process.removeAllListeners('warning');
  process.on('warning', (warning) => log(`warning ${warning.name}`));
  Lifecycle.getInstance().onWarning(() => {
    log('warning from the sf CLI libraries');
    return Promise.resolve();
  });
}

/** Removes server.pid if it's still ours. */
function removePidFile(file: string): void {
  try {
    if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file);
  } catch {
    // Already gone.
  }
}

export function main(): void {
  const home = launcherHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // The sf CLI picks a default org from the project the process runs in; this folder has none.
  process.chdir(home);
  const logFile = join(home, 'server.log');
  rotateLog(logFile);
  const log = fileLog(logFile);
  quietWarnings(log);

  const store = new StateStore(home);
  const inventory = new Inventory({ auth: sfAuthSource({ log }), query: sfOrgQuery(), store, cacheDir: home });
  const server = createServer({
    inventory,
    store,
    loginUrl: sfLoginUrl(),
    open: (url, target) => openUrl(url, target, undefined, log),
    webDir: WEB_DIR,
    version: packageVersion(),
    log,
  });
  const pidFile = join(home, 'server.pid');
  const port = store.settings().port;

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      // A clean exit: the login service doesn't restart it, so it never loops on a port another program has.
      log(`port ${port} is in use`);
      process.exit(0);
    }
    log(`server error ${error.code ?? error.name}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
    log(`listening on 127.0.0.1:${port}`);
    inventory.startRefresh();
    setInterval(() => inventory.startRefresh(), REFRESH_EVERY_MS).unref();
  });

  const stop = (): void => {
    removePidFile(pidFile);
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

/** True when this file is the script node was started with, not an import. */
function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
