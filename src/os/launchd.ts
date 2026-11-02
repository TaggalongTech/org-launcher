/**
 * macOS: a LaunchAgent in ~/Library/LaunchAgents that runs the server at login and restarts it if it fails.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import {
  LoginServiceError,
  refuseLineBreaks,
  type LoginService,
  type Pause,
  type Registration,
  type Run,
} from './loginService.js';

/** Registering under this label replaces an earlier agent with the same label. */
export const LAUNCHD_LABEL = 'com.taggalong.org-launcher';
const FALLBACK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/** launchd can refuse a bootstrap right after a bootout (error 5); it's tried this many times. */
const BOOTSTRAP_TRIES = 3;
const BOOTSTRAP_WAIT_MS = 1000;

/**
 * The agent runs `sh -c LAUNCH_GUARD node serverJs`, so sh gets node as $0 and the server as $1; the paths
 * are never part of the script. When either is gone (the sf CLI updated and tidied away its old node, or
 * the plugin was uninstalled), it exits cleanly, and launchd leaves it stopped instead of retrying.
 */
export const LAUNCH_GUARD = '[ -x "$0" ] && [ -f "$1" ] || exit 0; exec "$0" "$1"';

export type PlistInput = { nodePath: string; serverJs: string; home: string; userHome: string; path: string };

const xml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const unxml = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * The agent's plist: `node serverJs` in home, logging to home/server.log. launchd restarts it only after a
 * failed exit; a clean exit (stopped, port taken by another program, node or server gone) leaves it stopped.
 */
export function launchdPlist({ nodePath, serverJs, home, userHome, path }: PlistInput): string {
  // The plist is only ever read by launchd on macOS, so its paths are always POSIX.
  const log = xml(posix.join(home, 'server.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${xml(LAUNCH_GUARD)}</string>
    <string>${xml(nodePath)}</string>
    <string>${xml(serverJs)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
    <key>HOME</key>
    <string>${xml(userHome)}</string>
    <key>ORG_LAUNCHER_HOME</key>
    <string>${xml(home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

/** What a plist this module wrote runs. Fields that aren't in the expected place read as null. */
export function readPlist(text: string): Registration {
  const strings = (block: string | undefined): string[] =>
    [...(block ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]));
  const args = strings(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1]);
  const guarded = args.length === 5 && args[0] === '/bin/sh' && args[1] === '-c' && args[2] === LAUNCH_GUARD;
  const home = /<key>ORG_LAUNCHER_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
  return {
    nodePath: guarded ? args[3] : null,
    serverJs: guarded ? args[4] : null,
    home: home === undefined ? null : unxml(home),
  };
}

export type LaunchdPlace = { run: Run; userHome: string; uid: number; path: string | undefined; pause: Pause };

export function launchdService({ run, userHome, uid, path, pause }: LaunchdPlace): LoginService {
  const plist = join(userHome, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const domain = `gui/${uid}`;
  const service = `${domain}/${LAUNCHD_LABEL}`;
  const bootout = (): Promise<unknown> => run('launchctl', ['bootout', service]);

  return {
    async register(nodePath, serverJs, home): Promise<void> {
      refuseLineBreaks(nodePath, serverJs, home);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      mkdirSync(join(userHome, 'Library', 'LaunchAgents'), { recursive: true });
      // launchd ignores an agent file that others can write to.
      writeFileSync(plist, launchdPlist({ nodePath, serverJs, home, userHome, path: path ?? FALLBACK_PATH }), {
        mode: 0o644,
      });
      await bootout(); // Unloads an earlier agent; fails when there was none.
      let code = 0;
      for (let tries = 1; tries <= BOOTSTRAP_TRIES; tries++) {
        // eslint-disable-next-line no-await-in-loop
        code = (await run('launchctl', ['bootstrap', domain, plist])).code;
        if (code === 0) return;
        // eslint-disable-next-line no-await-in-loop
        if (tries < BOOTSTRAP_TRIES) await pause(BOOTSTRAP_WAIT_MS);
      }
      // Nothing half-registered: an agent file launchd won't load would only get in the way.
      await bootout();
      rmSync(plist, { force: true });
      throw new LoginServiceError(`Couldn't start Org Launcher at login: launchctl bootstrap failed (exit ${code}).`);
    },

    async unregister(): Promise<void> {
      await bootout(); // Fails when it isn't loaded, which is fine.
      rmSync(plist, { force: true });
    },

    registration(): Promise<Registration | null> {
      if (!existsSync(plist)) return Promise.resolve(null);
      let text = '';
      try {
        text = readFileSync(plist, 'utf8');
      } catch {
        // Registered, but what it runs can't be read.
      }
      return Promise.resolve(readPlist(text));
    },

    readsBack: true,

    async start(): Promise<void> {
      // After a stop the agent is unloaded, so load it; one that's still loaded is started instead.
      if ((await run('launchctl', ['bootstrap', domain, plist])).code === 0) return;
      const { code } = await run('launchctl', ['kickstart', service]);
      if (code !== 0) throw new LoginServiceError(`Couldn't start Org Launcher: launchctl kickstart failed (exit ${code}).`);
    },

    async stop(): Promise<void> {
      const { code } = await run('launchctl', ['bootout', service]);
      if (code === 0) return;
      // Not loaded means already stopped.
      if ((await run('launchctl', ['print', service])).code !== 0) return;
      throw new LoginServiceError(`Couldn't stop Org Launcher: launchctl bootout failed (exit ${code}).`);
    },
  };
}
