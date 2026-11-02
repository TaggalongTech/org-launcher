/**
 * What people save about their orgs (tags, notes, hidden, main login, browser) and the launcher's settings.
 * Every read goes to disk so changes from other processes show up at once. Every write takes a lock file,
 * re-reads, changes, then writes a temp file and renames it over the old one.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  checkOrgId,
  checkPort,
  normalizeMainLogin,
  normalizeNote,
  normalizeOpenTarget,
  normalizeTag,
  normalizeTags,
  ValidationError,
  type OpenTarget,
} from './validate.js';

export type { Browser, OpenTarget } from './validate.js';

export type OrgEntry = { tags: string[]; note: string; hidden: boolean; mainLogin: string | null; open: OpenTarget | null };
export type Settings = {
  port: number;
  defaultOpen: OpenTarget | null;
  tagOpen: Record<string, OpenTarget>;
  projects: string[];
  asked: { atLogin: boolean; dock: boolean };
};

/** Thrown when another process holds the lock for longer than we wait. */
export class StateBusyError extends Error {
  public constructor() {
    super("Org Launcher's saved data is busy in another process. Try again in a moment.");
    this.name = 'StateBusyError';
  }
}

export const DEFAULT_PORT = 4242;
const STATE_FILE = 'state.json';
const SETTINGS_FILE = 'settings.json';
const LOCK_FILE = 'state.lock';
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;
const CORRUPT = Symbol('corrupt');

/** The folder for everything the launcher saves: ORG_LAUNCHER_HOME, or ~/.sf/org-launcher. */
export function launcherHome(): string {
  const home = process.env.ORG_LAUNCHER_HOME;
  if (home) return home; // an empty value counts as unset
  return join(homedir(), '.sf', 'org-launcher');
}

const noOrgs = (): Record<string, OrgEntry> => ({});

const blankEntry = (): OrgEntry => ({ tags: [], note: '', hidden: false, mainLogin: null, open: null });

const defaultSettings = (): Settings => ({
  port: DEFAULT_PORT,
  defaultOpen: null,
  tagOpen: {},
  projects: [],
  asked: { atLogin: false, dock: false },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Runs a check and falls back when the value is not valid. Used when reading files people may have edited. */
function orDefault<T>(check: () => T, fallback: T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof ValidationError) return fallback;
    throw error;
  }
}

/** Blocks this thread; the store is synchronous, so waiting for the lock has to be too. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const errorCode = (error: unknown): unknown => (isRecord(error) ? error.code : undefined);

/**
 * Reads one entry from the file, keeping each valid field and filling the rest. Non-objects give undefined.
 * Limits on count and length apply to new input only: a hand edit past them is kept, never wiped.
 */
function readEntry(raw: unknown): OrgEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const blank = blankEntry();
  const tags = Array.isArray(raw.tags)
    ? raw.tags.flatMap((tag: unknown) => orDefault(() => [normalizeTag(tag as string)], []))
    : blank.tags;
  return {
    tags: [...new Set(tags)],
    note: typeof raw.note === 'string' ? raw.note : blank.note,
    hidden: raw.hidden === true,
    mainLogin: orDefault(() => normalizeMainLogin(raw.mainLogin as string | null), blank.mainLogin),
    open: orDefault(() => normalizeOpenTarget(raw.open as OpenTarget | null), blank.open),
  };
}

/** Parses state.json's contents; a file that isn't the right shape is corrupt. Bad entries are skipped. */
function readOrgs(data: unknown): Record<string, OrgEntry> | typeof CORRUPT {
  if (!isRecord(data) || !isRecord(data.orgs)) return CORRUPT;
  const orgs: Record<string, OrgEntry> = {};
  for (const [orgId, raw] of Object.entries(data.orgs)) {
    const entry = readEntry(raw);
    if (entry && orDefault(() => checkOrgId(orgId), '')) orgs[orgId] = entry;
  }
  return orgs;
}

function normalizeTagOpen(tagOpen: Record<string, OpenTarget>): Record<string, OpenTarget> {
  if (!isRecord(tagOpen)) throw new ValidationError('Tag browsers must map each tag to a browser.');
  const result: Record<string, OpenTarget> = {};
  for (const [tag, target] of Object.entries(tagOpen)) {
    const checked = normalizeOpenTarget(target);
    if (checked === null) throw new ValidationError('Pick a browser for each tag.');
    result[normalizeTag(tag)] = checked;
  }
  return result;
}

function normalizeProjects(projects: string[]): string[] {
  if (!Array.isArray(projects) || projects.some((p) => typeof p !== 'string' || p.trim() === '')) {
    throw new ValidationError('Projects must be a list of folder paths.');
  }
  return [...new Set(projects.map((p) => p.trim()))];
}

function normalizeAsked(asked: Settings['asked']): Settings['asked'] {
  if (!isRecord(asked) || typeof asked.atLogin !== 'boolean' || typeof asked.dock !== 'boolean') {
    throw new ValidationError('Asked must say true or false for atLogin and dock.');
  }
  return { atLogin: asked.atLogin, dock: asked.dock };
}

/** Parses settings.json's contents, keeping each valid value and using the default for the rest. */
function readSettings(data: unknown): Settings | typeof CORRUPT {
  if (!isRecord(data)) return CORRUPT;
  const d = defaultSettings();
  const tagOpen: Record<string, OpenTarget> = {};
  for (const [tag, target] of Object.entries(isRecord(data.tagOpen) ? data.tagOpen : {})) {
    Object.assign(tagOpen, orDefault(() => normalizeTagOpen({ [tag]: target as OpenTarget }), {}));
  }
  const projects = Array.isArray(data.projects)
    ? data.projects.filter((p: unknown): p is string => typeof p === 'string' && p.trim() !== '')
    : d.projects;
  const asked = isRecord(data.asked) ? data.asked : {};
  return {
    port: orDefault(() => checkPort(data.port as number), d.port),
    defaultOpen: orDefault(() => normalizeOpenTarget(data.defaultOpen as OpenTarget | null), d.defaultOpen),
    tagOpen,
    projects: normalizeProjects(projects),
    asked: { atLogin: asked.atLogin === true, dock: asked.dock === true },
  };
}

/** Checks the fields a caller passed and returns only those. */
function normalizeEntryPatch(patch: Partial<OrgEntry>): Partial<OrgEntry> {
  const result: Partial<OrgEntry> = {};
  if (patch.tags !== undefined) result.tags = normalizeTags(patch.tags);
  if (patch.note !== undefined) result.note = normalizeNote(patch.note);
  if (patch.hidden !== undefined) {
    if (typeof patch.hidden !== 'boolean') throw new ValidationError('Hidden must be true or false.');
    result.hidden = patch.hidden;
  }
  if (patch.mainLogin !== undefined) result.mainLogin = normalizeMainLogin(patch.mainLogin);
  if (patch.open !== undefined) result.open = normalizeOpenTarget(patch.open);
  return result;
}

function normalizeSettingsPatch(patch: Partial<Settings>): Partial<Settings> {
  const result: Partial<Settings> = {};
  if (patch.port !== undefined) result.port = checkPort(patch.port);
  if (patch.defaultOpen !== undefined) result.defaultOpen = normalizeOpenTarget(patch.defaultOpen);
  if (patch.tagOpen !== undefined) result.tagOpen = normalizeTagOpen(patch.tagOpen);
  if (patch.projects !== undefined) result.projects = normalizeProjects(patch.projects);
  if (patch.asked !== undefined) result.asked = normalizeAsked(patch.asked);
  return result;
}

export class StateStore {
  public constructor(private readonly dir: string) {}

  /** The saved entry for an org, or a blank one. */
  public get(orgId: string): OrgEntry {
    return this.all()[orgId] ?? blankEntry();
  }

  public all(): Record<string, OrgEntry> {
    return this.load(STATE_FILE, readOrgs, noOrgs, false);
  }

  /** Changes only the fields given, after checking them. */
  public update(orgId: string, patch: Partial<OrgEntry>): OrgEntry {
    checkOrgId(orgId);
    const changes = normalizeEntryPatch(patch);
    return this.change(orgId, (entry) => ({ ...entry, ...changes }));
  }

  /** Adds tags after the existing ones, skipping any the org already has. */
  public addTags(orgId: string, tags: string[]): OrgEntry {
    checkOrgId(orgId);
    const added = normalizeTags(tags);
    return this.change(orgId, (entry) => ({ ...entry, tags: normalizeTags([...entry.tags, ...added]) }));
  }

  /** Removes tags; tags the org doesn't have are ignored. */
  public removeTags(orgId: string, tags: string[]): OrgEntry {
    checkOrgId(orgId);
    const removed = new Set(tags.map((tag) => String(tag).trim().toLowerCase()));
    return this.change(orgId, (entry) => ({ ...entry, tags: entry.tags.filter((tag) => !removed.has(tag)) }));
  }

  public setTags(orgId: string, tags: string[]): OrgEntry {
    return this.update(orgId, { tags });
  }

  public settings(): Settings {
    return this.load(SETTINGS_FILE, readSettings, defaultSettings, false);
  }

  /** Changes only the settings given, after checking them. */
  public updateSettings(patch: Partial<Settings>): Settings {
    const changes = normalizeSettingsPatch(patch);
    return this.withLock(() => {
      const next = { ...this.load(SETTINGS_FILE, readSettings, defaultSettings, true), ...changes };
      this.write(SETTINGS_FILE, next);
      return next;
    });
  }

  /** Re-reads state.json under the lock, changes one org and writes the file back. */
  private change(orgId: string, edit: (entry: OrgEntry) => OrgEntry): OrgEntry {
    return this.withLock(() => {
      const orgs = this.load(STATE_FILE, readOrgs, noOrgs, true);
      const e = edit(orgs[orgId] ?? blankEntry());
      const entry: OrgEntry = { tags: e.tags, note: e.note, hidden: e.hidden, mainLogin: e.mainLogin, open: e.open };
      orgs[orgId] = entry;
      this.write(STATE_FILE, { version: 1, orgs });
      return entry;
    });
  }

  /**
   * Reads and parses one file. A missing file gives the empty value. A corrupt file is renamed to
   * <name>.bad-<epoch ms> so a hand edit is never lost, and reads as empty. Without the lock held,
   * the rename happens under the lock after checking the file is still corrupt.
   */
  private load<T>(name: string, parse: (data: unknown) => T | typeof CORRUPT, empty: () => T, locked: boolean): T {
    const file = join(this.dir, name);
    const parsed = readParsed(file, parse);
    if (parsed !== CORRUPT) return parsed ?? empty();
    if (locked) {
      backUp(file);
    } else {
      try {
        this.withLock(() => {
          if (readParsed(file, parse) === CORRUPT) backUp(file);
        });
      } catch (error) {
        // Whoever holds the lock will back the file up when it reads it.
        if (!(error instanceof StateBusyError)) throw error;
      }
    }
    return empty();
  }

  /** Writes a temp file next to the target, then renames it over the target. */
  private write(name: string, data: unknown): void {
    const file = join(this.dir, name);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch (error) {
      removeQuietly(temp);
      throw error;
    }
  }

  /**
   * Runs fn while holding state.lock, which other processes respect too. Waits up to 2 s for the lock
   * and takes over a lock older than 10 s, since its owner must have died.
   */
  private withLock<T>(fn: () => T): T {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = join(this.dir, LOCK_FILE);
    const token = `${process.pid} ${randomUUID()}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = openSync(lock, 'wx', 0o600);
        try {
          writeSync(fd, token);
        } finally {
          closeSync(fd);
        }
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      if (isStale(lock)) {
        removeQuietly(lock);
        continue;
      }
      if (Date.now() >= deadline) throw new StateBusyError();
      sleep(10 + Math.floor(Math.random() * 20));
    }
    try {
      return fn();
    } finally {
      releaseLock(lock, token);
    }
  }
}

function readParsed<T>(file: string, parse: (data: unknown) => T | typeof CORRUPT): T | typeof CORRUPT | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) return CORRUPT;
    throw error;
  }
}

function backUp(file: string): void {
  try {
    renameSync(file, `${file}.bad-${Date.now()}`);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function isStale(lock: string): boolean {
  try {
    return statSync(lock).mtimeMs < Date.now() - LOCK_STALE_MS;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/** Removes the lock only if it is still ours. */
function releaseLock(lock: string, token: string): void {
  try {
    if (readFileSync(lock, 'utf8') === token) unlinkSync(lock);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}
