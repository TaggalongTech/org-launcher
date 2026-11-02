/**
 * The rows the page shows: one per org, from the sf CLI's logins, what people saved, and the last
 * check of each org. rows() never waits on Salesforce; checks run in the background and are kept
 * in cache.json so the next start shows them at once.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkOrg, DEFAULT_TIMEOUT_MS, visiblePackages, type Check, type OrgQuery, type Pkg, type SourceHint } from './checks.js';
import { buildOrgs, type AuthSource, type OrgLogin, type OrgRecord, type OrgType } from './orgs.js';
import { projectIndex } from './projects.js';
import type { OpenTarget, OrgEntry, StateStore } from './state.js';

export type OrgRow = {
  id: string;
  alias: string;
  otherAliases: string[];
  type: OrgType;
  devHub: string | null;
  expires: string | null;
  daysLeft: number | null;
  health: 'ok' | 'expired' | 'unreachable' | 'unknown';
  healthReason: string | null;
  tags: string[];
  note: string;
  hidden: boolean;
  logins: Array<{ username: string; aliases: string[]; main: boolean }>;
  packages: Pkg[] | null;
  source: SourceHint | null;
  checkedAt: string | null;
  checkFailed: boolean;
  open: OpenTarget | null;
};

export type RefreshStatus = { running: boolean; done: number; total: number; startedAt: string | null; error: string | null };

export type InventoryDeps = {
  auth: AuthSource;
  query: OrgQuery;
  store: StateStore;
  cacheDir: string;
  /**
   * Maps org ids to the local project their source came from. Built at the start of each refresh;
   * by default from the projects in the saved settings.
   */
  projectIndex?: () => ReadonlyMap<string, string>;
  now?: () => Date;
  /** How many orgs are checked at once. */
  workers?: number;
  /** How long to wait for one org. Tests shorten it; the reason text always says 30 seconds. */
  timeoutMs?: number;
};

/** A check as cache.json keeps it. After a failed check, the packages are the ones from before. */
type CachedCheck = Check & { checkFailed: boolean };

const CACHE_FILE = 'cache.json';
const DEFAULT_WORKERS = 6;
const DAY_MS = 86_400_000;
const LIST_FAILED = "Couldn't read your sf CLI logins. Run sf org list to see what's wrong.";
const CHECKS_FAILED = "Couldn't finish checking your orgs. Refresh to try again.";
const SAVE_FAILED = "Couldn't save the org checks. Check that Org Launcher's folder can be written to.";

export class Inventory {
  private readonly now: () => Date;
  private readonly workers: number;
  private readonly timeoutMs: number;
  private logins: OrgLogin[] | null = null;
  private defaultUser: string | null = null;
  private cache: Record<string, CachedCheck> | null = null;
  private progress: RefreshStatus = { running: false, done: 0, total: 0, startedAt: null, error: null };
  /** Orgs logged out of since the running refresh listed the logins; its listing may still hold them. */
  private forgotten = new Set<string>();
  /** A refresh to run when the running one ends, because the logins changed under it. */
  private again = false;

  public constructor(private readonly deps: InventoryDeps) {
    this.now = deps.now ?? ((): Date => new Date());
    this.workers = Math.max(1, deps.workers ?? DEFAULT_WORKERS);
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The rows from memory and cache.json. Empty until the first refresh has listed the logins. */
  public rows(): OrgRow[] {
    const entries = this.deps.store.all();
    const checks = this.checks();
    const now = this.now();
    return this.records(entries).map((record) => toRow(record, entries[record.orgId], checks[record.orgId], now));
  }

  /** Starts a refresh in the background unless one is running. */
  public startRefresh(): 'started' | 'already running' {
    if (this.progress.running) return 'already running';
    this.progress = { running: true, done: 0, total: 0, startedAt: this.now().toISOString(), error: null };
    // This refresh lists the logins from now on, so what was forgotten before is already gone from them.
    this.forgotten = new Set();
    this.again = false;
    void this.refresh().finally(() => {
      this.progress.running = false;
      if (this.again) this.startRefresh();
    });
    return 'started';
  }

  /**
   * Drops an org from the rows at once, after its logins were logged out. A refresh that is running
   * may have listed it before the logout, so another refresh runs when that one ends.
   */
  public forget(orgId: string): void {
    this.forgotten.add(orgId);
    if (this.logins !== null) this.logins = this.logins.filter((login) => login.orgId !== orgId);
    if (this.progress.running) this.again = true;
  }

  public status(): RefreshStatus {
    return { ...this.progress };
  }

  /** Re-lists the logins, then checks every org that hasn't expired, a few at a time. Never throws. */
  private async refresh(): Promise<void> {
    let logins: OrgLogin[];
    let defaultUser: string | null;
    try {
      [logins, defaultUser] = await Promise.all([this.deps.auth.listLogins(), this.deps.auth.defaultUsername()]);
    } catch {
      this.progress.error = LIST_FAILED;
      return;
    }
    this.logins = logins.filter((login) => !this.forgotten.has(login.orgId));
    this.defaultUser = defaultUser;
    const projects = this.projects();
    try {
      this.forgetOrgsNotListed(logins);
      const live = this.records(this.deps.store.all()).filter((record) => !record.expired);
      this.progress.total = live.length;
      await eachLimit(live, this.workers, async (record) => {
        const check = await checkOrg(this.deps.query, record.main.username, {
          timeoutMs: this.timeoutMs,
          project: projects.get(record.orgId) ?? null,
          now: this.now,
        });
        const checks = this.checks();
        checks[record.orgId] = afterCheck(check, checks[record.orgId]);
        this.saveCache();
        this.progress.done += 1;
      });
    } catch {
      this.progress.error = CHECKS_FAILED;
    }
  }

  /** The project index for this refresh. It only adds a hint, so a failure gives an empty one. */
  private projects(): ReadonlyMap<string, string> {
    try {
      return this.deps.projectIndex ? this.deps.projectIndex() : projectIndex(this.deps.store.settings().projects);
    } catch {
      return new Map();
    }
  }

  private records(entries: Record<string, OrgEntry>): OrgRecord[] {
    if (this.logins === null) return [];
    const mains: Record<string, string | null> = {};
    for (const [orgId, entry] of Object.entries(entries)) mains[orgId] = entry.mainLogin;
    return buildOrgs(this.logins, mains, this.defaultUser, this.now());
  }

  /** The checks, read from cache.json the first time. */
  private checks(): Record<string, CachedCheck> {
    this.cache ??= readCache(join(this.deps.cacheDir, CACHE_FILE));
    return this.cache;
  }

  private forgetOrgsNotListed(logins: OrgLogin[]): void {
    const listed = new Set(logins.map((login) => login.orgId));
    const checks = this.checks();
    for (const orgId of Object.keys(checks)) {
      if (!listed.has(orgId)) delete checks[orgId];
    }
  }

  /** Writes a temp file next to cache.json, then renames it over cache.json. */
  private saveCache(): void {
    const file = join(this.deps.cacheDir, CACHE_FILE);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(this.deps.cacheDir, { recursive: true, mode: 0o700 });
      writeFileSync(temp, `${JSON.stringify({ version: 1, checks: this.checks() }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      removeQuietly(temp);
      this.progress.error = SAVE_FAILED;
    }
  }
}

/** A new check replaces the old one; a failed check keeps what the last good one found. */
function afterCheck(check: Check, previous: CachedCheck | undefined): CachedCheck {
  if (check.health === 'ok') return { ...check, checkFailed: false };
  return {
    ...check,
    orgType: previous?.orgType ?? null,
    packages: previous?.packages ?? [],
    source: previous?.source ?? null,
    checkFailed: true,
  };
}

/** The row fields that come from the last check; blank before the first one. */
function checkFields(check: CachedCheck | undefined): Pick<OrgRow, 'packages' | 'source' | 'checkedAt' | 'checkFailed'> {
  if (!check) return { packages: null, source: null, checkedAt: null, checkFailed: false };
  return {
    packages: visiblePackages(check.packages),
    source: check.source,
    checkedAt: check.checkedAt,
    checkFailed: check.checkFailed,
  };
}

function toRow(record: OrgRecord, entry: OrgEntry | undefined, check: CachedCheck | undefined, now: Date): OrgRow {
  const type = record.type === 'org' && check?.orgType ? check.orgType : record.type;
  const health = record.expired ? 'expired' : check?.health ?? 'unknown';
  return {
    id: record.orgId,
    alias: record.alias,
    otherAliases: record.otherAliases,
    type,
    devHub: record.devHub,
    expires: record.expires,
    daysLeft: daysLeft(record.expires, now),
    health,
    healthReason: health === 'unreachable' ? check?.reason ?? null : null,
    tags: entry?.tags ?? [],
    note: entry?.note ?? '',
    hidden: entry?.hidden ?? false,
    logins: [
      { username: record.main.username, aliases: record.main.aliases, main: true },
      ...record.others.map((login) => ({ username: login.username, aliases: login.aliases, main: false })),
    ],
    ...checkFields(check),
    open: entry?.open ?? null,
  };
}

/** Whole days from today's local date to an expiration date (YYYY-MM-DD); negative once it has passed. */
function daysLeft(expires: string | null, now: Date): number | null {
  const match = expires ? /^(\d{4})-(\d{2})-(\d{2})/.exec(expires) : null;
  if (!match) return null;
  const end = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((end - today) / DAY_MS);
}

/** Runs fn over items with at most `limit` running at once. */
async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';

function readPkg(raw: unknown): Pkg | undefined {
  if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.version !== 'string') return undefined;
  if (!isStringOrNull(raw.namespace)) return undefined;
  return { name: raw.name, namespace: raw.namespace, version: raw.version };
}

function readSource(raw: unknown): SourceHint | null | undefined {
  if (raw === null) return null;
  if (!isRecord(raw) || typeof raw.apexClasses !== 'number' || !isStringOrNull(raw.project)) return undefined;
  return { apexClasses: raw.apexClasses, project: raw.project };
}

/** One cached check, or undefined when it isn't the right shape. */
function readCachedCheck(raw: unknown): CachedCheck | undefined {
  if (!isRecord(raw)) return undefined;
  const { health, reason, orgType, packages, checkedAt } = raw;
  if (health !== 'ok' && health !== 'unreachable') return undefined;
  if (orgType !== null && orgType !== 'production' && orgType !== 'developer') return undefined;
  if (!isStringOrNull(reason) || typeof checkedAt !== 'string' || !Array.isArray(packages)) return undefined;
  const pkgs = packages.map(readPkg);
  const source = readSource(raw.source);
  if (pkgs.some((p) => p === undefined) || source === undefined) return undefined;
  return {
    health,
    reason,
    orgType,
    packages: pkgs as Pkg[],
    source,
    checkedAt,
    checkFailed: raw.checkFailed === true,
  };
}

/** Reads cache.json. It's only a cache: a missing, unreadable or corrupt file reads as empty. */
function readCache(file: string): Record<string, CachedCheck> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  if (!isRecord(data) || !isRecord(data.checks)) return {};
  const checks: Record<string, CachedCheck> = {};
  for (const [orgId, raw] of Object.entries(data.checks)) {
    const check = readCachedCheck(raw);
    if (check) checks[orgId] = check;
  }
  return checks;
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}
