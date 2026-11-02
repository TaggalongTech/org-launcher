/**
 * The Mac Dock app: ~/Applications/Org Launcher.app, which opens the page as its own window.
 * Commands load this module only when they need it, and only on macOS.
 * Every program it runs goes through a Run with an argument list, never through a shell string.
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_PORT, type OpenTarget } from '../core/state.js';
import { darwinChromiumApps } from './browser.js';
import { LAUNCHD_LABEL } from './launchd.js';
import { runCommand, type Run } from './loginService.js';

export const APP_NAME = 'Org Launcher';
export const BUNDLE_ID = 'com.taggalong.org-launcher.app';
const EXECUTABLE = 'org-launcher';
const ICON_SVG = fileURLToPath(new URL('../../assets/icon.svg', import.meta.url));
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
/** Each icon size macOS asks for; every one also comes at twice the size. */
const ICON_SIZES = [16, 32, 128, 256, 512];

export type DockOptions = {
  /** The settings when the app is built. The app reads them again from settings.json at each launch. */
  port: number;
  defaultOpen: OpenTarget | null;
  /** Where the app goes; ~/Applications by default. */
  appDir?: string;
  /** Pin the app to the Dock and refresh the Dock's icon when it changed. False builds the app only. */
  pin?: boolean;
  run?: Run;
  /** The icon to draw; the plugin's assets/icon.svg by default. */
  iconSvg?: string;
};

export type RemoveOptions = { appDir?: string; run?: Run };

const defaultAppDir = (): string => join(homedir(), 'Applications');

/** Where the Dock app lives. */
export function dockAppPath(appDir = defaultAppDir()): string {
  return join(appDir, `${APP_NAME}.app`);
}

export function hasDockApp(appDir?: string): boolean {
  return existsSync(dockAppPath(appDir));
}

/** Runs a command that must work. A failure throws "<what>: <cmd> [<subcommand>] failed (exit n)." */
async function mustRun(run: Run, what: string, cmd: string, args: string[]): Promise<void> {
  const { code } = await run(cmd, args);
  const label = args[0] && !args[0].startsWith('-') ? `${cmd} ${args[0]}` : cmd;
  if (code !== 0) throw new Error(`${what}: ${label} failed (exit ${code}).`);
}

/**
 * The icon file's name, from its contents. macOS caches icons by file name, so a new name is how
 * the Dock learns the icon changed.
 */
export function iconName(svg: Buffer | string): string {
  return `AppIcon-${createHash('md5').update(svg).digest('hex').slice(0, 8)}`;
}

export function infoPlist(icon: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
  <key>CFBundleIconFile</key><string>${icon}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
</dict>
</plist>
`;
}

/** Wraps text in single quotes for sh, where nothing inside is special. */
function shellQuote(text: string): string {
  if (text.includes('\0')) throw new Error("The Dock app can't use a path with a null character in it.");
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** The programs the launch script runs, and the login service's file. Tests swap in fakes. */
export type LaunchTools = {
  open: string;
  curl: string;
  launchctl: string;
  osascript: string;
  sleep: string;
  /** The login service's plist; when it's there, the script asks launchd to start the server. */
  agentPlist: string;
};

const defaultTools = (): LaunchTools => ({
  open: '/usr/bin/open',
  curl: '/usr/bin/curl',
  launchctl: '/bin/launchctl',
  osascript: '/usr/bin/osascript',
  sleep: '/bin/sleep',
  agentPlist: join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
});

/**
 * The app's executable. It reads settings.json at each launch, so a browser or port changed on the page
 * applies at once. It reads the values the way the server does: a missing or broken file, or a value the
 * server would refuse, means the default (port 4242, the default browser). The port must be a whole
 * number from 1024 to 65535 and the profile "Default" or "Profile <n>"; each reaches open only as part of
 * a quoted argument.
 *
 * Before opening, it checks that Org Launcher answers on the port. If not and the login service is
 * there, it asks launchd to start it and waits up to 5 seconds. If it's still not answering, it says
 * how to start it and opens nothing. It never starts node itself.
 */
export function launchScript(settingsFile: string, tools: Partial<LaunchTools> = {}): string {
  const { open, curl, launchctl, osascript, sleep, agentPlist } = { ...defaultTools(), ...tools };
  const apps = darwinChromiumApps()
    .map(([browser, app]) => `  ${browser}) APP=${shellQuote(app)} ;;\n`)
    .join('');
  const read = (keyPath: string): string => `/usr/bin/plutil -extract ${keyPath} raw -o - "$SETTINGS" 2>/dev/null`;
  return `#!/bin/sh
# ${APP_NAME}: opens the page as its own window. Reads settings.json at each launch.
SETTINGS=${shellQuote(settingsFile)}
OPEN=${shellQuote(open)}
CURL=${shellQuote(curl)}
LAUNCHCTL=${shellQuote(launchctl)}
OSASCRIPT=${shellQuote(osascript)}
SLEEP=${shellQuote(sleep)}
AGENT=${shellQuote(agentPlist)}
PORT=$(${read('port')})
case "$PORT" in
  [0-9][0-9][0-9][0-9]|[0-9][0-9][0-9][0-9][0-9]) [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || PORT=${DEFAULT_PORT} ;;
  *) PORT=${DEFAULT_PORT} ;;
esac
URL="http://localhost:$PORT"
running() {
  "$CURL" -s -m 1 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | /usr/bin/grep -q '"app":"org-launcher"'
}
if ! running; then
  if [ -f "$AGENT" ]; then
    "$LAUNCHCTL" kickstart "gui/$(/usr/bin/id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1
    TRIES=0
    while [ "$TRIES" -lt 10 ] && ! running; do
      "$SLEEP" 0.5
      TRIES=$((TRIES + 1))
    done
  fi
  if ! running; then
    "$OSASCRIPT" -e 'on run argv' -e 'display alert (item 1 of argv) message (item 2 of argv)' -e 'end run' \\
      "Org Launcher isn't running" "Run sf launcher in a terminal to start it." >/dev/null 2>&1
    exit 0
  fi
fi
BROWSER=$(${read('defaultOpen.browser')})
PROFILE=$(${read('defaultOpen.profile')})
case "$PROFILE" in
  Default|'Profile '[0-9]|'Profile '[0-9][0-9]|'Profile '[0-9][0-9][0-9]|'Profile '[0-9][0-9][0-9][0-9]) ;;
  *) PROFILE= ;;
esac
case "$BROWSER" in
${apps}  *) exec "$OPEN" "$URL" ;;
esac
if [ -n "$PROFILE" ]; then
  exec "$OPEN" -na "$APP" --args "--profile-directory=$PROFILE" "--app=$URL"
fi
exec "$OPEN" -na "$APP" --args "--app=$URL"
`;
}

/** The icon file the app was last built with, from its Info.plist; null when there's no app. */
function builtIconName(app: string): string | null {
  try {
    const plist = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8');
    return /<key>CFBundleIconFile<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Draws the .icns from the SVG in work: qlmanage renders it at 1024, sips makes each size, iconutil
 * packs them. The SVG is a full-bleed opaque square, so macOS rounds it and it fills the whole tile.
 */
async function renderIcon(run: Run, svg: string, work: string): Promise<string> {
  const what = "Couldn't make the Dock icon";
  await mustRun(run, what, 'qlmanage', ['-t', '-s', '1024', '-o', work, svg]);
  const png = join(work, `${basename(svg)}.png`);
  if (!existsSync(png)) throw new Error(`${what}: qlmanage drew no image.`);
  const iconset = join(work, 'AppIcon.iconset');
  mkdirSync(iconset);
  for (const size of ICON_SIZES) {
    for (const [scale, suffix] of [
      [1, ''],
      [2, '@2x'],
    ] as const) {
      const px = String(size * scale);
      const out = join(iconset, `icon_${size}x${size}${suffix}.png`);
      // eslint-disable-next-line no-await-in-loop
      await mustRun(run, what, 'sips', ['-z', px, px, png, '--out', out]);
    }
  }
  const icns = join(work, 'AppIcon.icns');
  await mustRun(run, what, 'iconutil', ['-c', 'icns', iconset, '-o', icns]);
  return icns;
}

/** True when a Dock tile's file URL points at app, with or without percent-encoding. */
function pointsAt(url: string, app: string): boolean {
  try {
    return fileURLToPath(url).replace(/\/+$/, '') === app;
  } catch {
    return false;
  }
}

/**
 * How many tiles the Dock keeps on its app side. A Dock that never saved any has none; any other
 * failure to read the count throws, so a pin is never added twice and no app is deleted while pinned.
 */
async function pinnedCount(run: Run, file: string): Promise<number> {
  const { code, stdout, stderr } = await run('plutil', ['-extract', 'persistent-apps', 'raw', '-o', '-', file]);
  if (code !== 0 && stderr.includes('No value at that key path')) return 0;
  const text = stdout.trim();
  if (code !== 0 || !/^\d+$/.test(text)) throw new Error("Couldn't read the Dock's settings.");
  return Number(text);
}

/**
 * Exports the Dock's settings to a file in work and finds the tiles that are this app. Matched by file
 * URL only: another app can share the bundle id.
 */
async function findPins(run: Run, app: string, work: string): Promise<{ file: string; indexes: number[] }> {
  const file = join(work, 'dock.plist');
  await mustRun(run, "Couldn't read the Dock's settings", 'defaults', ['export', 'com.apple.dock', file]);
  const count = await pinnedCount(run, file);
  const indexes: number[] = [];
  for (let i = 0; i < count; i++) {
    const keyPath = `persistent-apps.${i}.tile-data.file-data._CFURLString`;
    // eslint-disable-next-line no-await-in-loop
    const { code, stdout } = await run('plutil', ['-extract', keyPath, 'raw', '-o', '-', file]);
    if (code === 0 && pointsAt(stdout.trim(), app)) indexes.push(i);
  }
  return { file, indexes };
}

const xml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A Dock tile for app, in the form `defaults write -array-add` takes. */
function dockTile(app: string): string {
  const url = xml(`${pathToFileURL(app).href}/`);
  return (
    '<dict><key>tile-data</key><dict><key>file-data</key><dict>' +
    `<key>_CFURLString</key><string>${url}</string>` +
    '<key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>'
  );
}

/** Deletes the Dock's icon cache, so it draws a changed icon again. */
async function clearDockIconCache(run: Run): Promise<void> {
  const { code, stdout } = await run('getconf', ['DARWIN_USER_CACHE_DIR']);
  const dir = stdout.trim();
  if (code === 0 && dir !== '') rmSync(join(dir, 'com.apple.dock.iconcache'), { recursive: true, force: true });
}

/**
 * Builds the app, pins it to the Dock (unless it's pinned already) and returns its path. The Dock
 * restarts only to show a new pin or a changed icon. Safe to run again.
 */
export async function buildDockApp(home: string, opts: DockOptions): Promise<string> {
  const run = opts.run ?? runCommand;
  const app = dockAppPath(opts.appDir);
  const svg = opts.iconSvg ?? ICON_SVG;
  const icon = iconName(readFileSync(svg));
  const iconChanged = builtIconName(app) !== icon;
  const work = mkdtempSync(join(tmpdir(), 'org-launcher-dock-'));
  try {
    // The icon is drawn first: if that fails, the earlier app stays as it was.
    const icns = await renderIcon(run, svg, work);

    rmSync(app, { recursive: true, force: true });
    const contents = join(app, 'Contents');
    mkdirSync(join(contents, 'MacOS'), { recursive: true });
    mkdirSync(join(contents, 'Resources'));
    writeFileSync(join(contents, 'Info.plist'), infoPlist(icon));
    const executable = join(contents, 'MacOS', EXECUTABLE);
    writeFileSync(executable, launchScript(join(home, 'settings.json')));
    chmodSync(executable, 0o755);
    copyFileSync(icns, join(contents, 'Resources', `${icon}.icns`));
    const now = new Date();
    utimesSync(app, now, now);
    await run(LSREGISTER, ['-f', app]); // Tells macOS about the new icon; the app works without it.

    if (opts.pin === false) return app;
    const pinNow = (await findPins(run, app, work)).indexes.length === 0;
    if (pinNow) {
      await mustRun(run, "Couldn't pin Org Launcher to the Dock", 'defaults', [
        'write',
        'com.apple.dock',
        'persistent-apps',
        '-array-add',
        dockTile(app),
      ]);
    }
    if (iconChanged) await clearDockIconCache(run);
    if (pinNow || iconChanged) await run('killall', ['Dock']);
    return app;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Unpins the app from the Dock and deletes it. Other apps in the Dock stay as they are. */
export async function removeDockApp(opts: RemoveOptions = {}): Promise<void> {
  const run = opts.run ?? runCommand;
  const app = dockAppPath(opts.appDir);
  const work = mkdtempSync(join(tmpdir(), 'org-launcher-dock-'));
  try {
    const { file, indexes } = await findPins(run, app, work);
    if (indexes.length > 0) {
      const what = "Couldn't unpin Org Launcher from the Dock";
      // Last first, so each index still points at the same tile.
      for (const i of [...indexes].reverse()) {
        // eslint-disable-next-line no-await-in-loop
        await mustRun(run, what, 'plutil', ['-remove', `persistent-apps.${i}`, file]);
      }
      await mustRun(run, what, 'defaults', ['import', 'com.apple.dock', file]);
      await run('killall', ['Dock']);
    }
    rmSync(app, { recursive: true, force: true });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
