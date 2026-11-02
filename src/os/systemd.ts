/**
 * Linux: a systemd user service, ~/.config/systemd/user/org-launcher.service, started at login.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mustRun,
  refuseLineBreaks,
  type LoginService,
  type Registration,
  type Run,
} from './loginService.js';

const UNIT = 'org-launcher';

/** path is the PATH at registration; without it the service gets systemd's short default PATH. */
export type UnitInput = { nodePath: string; serverJs: string; home: string; path?: string };

/** systemd expands %specifiers in every one of these settings; %% is a plain %. */
const noSpecifiers = (text: string): string => text.replace(/%/g, '%%');

/** One quoted ExecStart argument: C-style escapes inside double quotes, and $$ for a plain $. */
const execArg = (text: string): string =>
  `"${noSpecifiers(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$')}"`;

/** One quoted Environment= assignment: C-style escapes inside double quotes; $ is plain there. */
const envLine = (name: string, value: string): string =>
  `Environment="${name}=${noSpecifiers(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`;

/** Undoes C-style escapes inside double quotes, then the %% for a plain %. */
const unquote = (text: string): string => text.replace(/\\(.)/g, '$1').replace(/%%/g, '%');

/**
 * The unit file: `node serverJs` in home, restarted when it fails, started with the user's session.
 * PATH is the one from registration, so the server can find sf, and sf can find node. While node or the
 * server is gone (an update tidied away the old node, or the plugin was uninstalled), it isn't started.
 */
export function systemdUnit({ nodePath, serverJs, home, path }: UnitInput): string {
  refuseLineBreaks(nodePath, serverJs, home, path ?? '');
  const pathLine = path === undefined || path === '' ? '' : envLine('PATH', path);
  return `[Unit]
Description=Org Launcher
ConditionPathExists=${noSpecifiers(nodePath)}
ConditionPathExists=${noSpecifiers(serverJs)}

[Service]
ExecStart=${execArg(nodePath)} ${execArg(serverJs)}
WorkingDirectory=${noSpecifiers(home)}
${envLine('ORG_LAUNCHER_HOME', home)}${pathLine}Restart=on-failure

[Install]
WantedBy=default.target
`;
}

/** What a unit this module wrote runs. Fields that aren't in the expected place read as null. */
export function readUnit(text: string): Registration {
  const quoted = '"((?:[^"\\\\]|\\\\.)*)"';
  const exec = new RegExp(`^ExecStart=${quoted} ${quoted}$`, 'm').exec(text);
  const home = new RegExp(`^Environment="ORG_LAUNCHER_HOME=((?:[^"\\\\]|\\\\.)*)"$`, 'm').exec(text);
  const fromExecArg = (raw: string): string => unquote(raw.replace(/\$\$/g, '$'));
  return {
    nodePath: exec ? fromExecArg(exec[1]) : null,
    serverJs: exec ? fromExecArg(exec[2]) : null,
    home: home ? unquote(home[1]) : null,
  };
}

export type SystemdPlace = { run: Run; configHome: string; path: string | undefined };

export function systemdService({ run, configHome, path }: SystemdPlace): LoginService {
  const dir = join(configHome, 'systemd', 'user');
  const file = join(dir, `${UNIT}.service`);
  const systemctl = (what: string, ...args: string[]): Promise<void> =>
    mustRun(run, what, 'systemctl', ['--user', ...args]);

  return {
    async register(nodePath, serverJs, home): Promise<void> {
      const unit = systemdUnit({ nodePath, serverJs, home, path });
      mkdirSync(home, { recursive: true, mode: 0o700 });
      await run('systemctl', ['--user', 'stop', UNIT]); // Stops an earlier one; fails when there was none.
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, unit, { mode: 0o644 });
      const what = "Couldn't start Org Launcher at login";
      try {
        await systemctl(what, 'daemon-reload');
        await systemctl(what, 'enable', '--now', UNIT);
      } catch (error) {
        // Nothing half-registered: a unit systemd won't run would only get in the way.
        await run('systemctl', ['--user', 'disable', '--now', UNIT]);
        rmSync(file, { force: true });
        await run('systemctl', ['--user', 'daemon-reload']);
        throw error;
      }
    },

    async unregister(): Promise<void> {
      await run('systemctl', ['--user', 'disable', '--now', UNIT]); // Fails when it isn't there, which is fine.
      rmSync(file, { force: true });
      await systemctl("Couldn't remove the login service", 'daemon-reload');
    },

    registration(): Promise<Registration | null> {
      if (!existsSync(file)) return Promise.resolve(null);
      let text = '';
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        // Registered, but what it runs can't be read.
      }
      return Promise.resolve(readUnit(text));
    },

    readsBack: true,

    start(): Promise<void> {
      return systemctl("Couldn't start Org Launcher", 'start', UNIT);
    },

    stop(): Promise<void> {
      return systemctl("Couldn't stop Org Launcher", 'stop', UNIT);
    },
  };
}
