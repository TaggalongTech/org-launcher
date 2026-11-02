/**
 * One check of one org: can we reach it, what kind of org is it, which packages does it have, and
 * does it hold Apex from source. Reasons for a failed check are short, one line, and never carry a
 * link or a session id.
 */
import { Org } from '@salesforce/core';
import { SALESFORCE_NAMESPACES } from './salesforceNamespaces.js';

/** An installed package. `version` is Major.Minor.Patch.Build, like "4.0.0.3". */
export type Pkg = { name: string; namespace: string | null; version: string };

/** Apex the org holds outside any package. `project` names the local project it likely came from. */
export type SourceHint = { apexClasses: number; project: string | null };

export type Check = {
  health: 'ok' | 'unreachable';
  reason: string | null;
  orgType: 'production' | 'developer' | null;
  packages: Pkg[];
  source: SourceHint | null;
  checkedAt: string;
};

/** Asks one org about itself, through the login with this username. */
export type OrgQuery = (
  username: string
) => Promise<{ orgType: string; isSandbox: boolean; packages: Pkg[]; unpackagedApex: number }>;

/** The fields we read from one InstalledSubscriberPackage record (Tooling API). */
export type InstalledPackageRecord = {
  SubscriberPackage?: { Name?: string | null; NamespacePrefix?: string | null } | null;
  SubscriberPackageVersion?: {
    MajorVersion?: number | null;
    MinorVersion?: number | null;
    PatchVersion?: number | null;
    BuildNumber?: number | null;
  } | null;
};

const ORGANIZATION_SOQL = 'SELECT OrganizationType, IsSandbox FROM Organization LIMIT 1';
const PACKAGES_SOQL =
  'SELECT SubscriberPackage.Name, SubscriberPackage.NamespacePrefix, SubscriberPackageVersion.MajorVersion, ' +
  'SubscriberPackageVersion.MinorVersion, SubscriberPackageVersion.PatchVersion, SubscriberPackageVersion.BuildNumber ' +
  'FROM InstalledSubscriberPackage';
const UNPACKAGED_APEX_SOQL = "SELECT COUNT() FROM ApexClass WHERE ManageableState = 'unmanaged'";

/** The reason when an org doesn't answer in time. Production always waits 30 seconds. */
export const NO_ANSWER = 'No answer in 30 seconds';
export const DEFAULT_TIMEOUT_MS = 30_000;

const HIDDEN = new Set(SALESFORCE_NAMESPACES.map((ns) => ns.toLowerCase()));

export function pkgFrom(record: InstalledPackageRecord): Pkg {
  const pkg = record.SubscriberPackage ?? {};
  const v = record.SubscriberPackageVersion ?? {};
  const part = (n: number | null | undefined): number => n ?? 0;
  const namespace = pkg.NamespacePrefix ?? '';
  return {
    name: pkg.Name ?? 'Unnamed package',
    namespace: namespace === '' ? null : namespace,
    version: `${part(v.MajorVersion)}.${part(v.MinorVersion)}.${part(v.PatchVersion)}.${part(v.BuildNumber)}`,
  };
}

/** Drops packages Salesforce installs itself and sorts the rest by name. Packages without a namespace always show. */
export function visiblePackages(packages: Pkg[]): Pkg[] {
  return packages
    .filter((p) => p.namespace === null || !HIDDEN.has(p.namespace.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.version.localeCompare(b.version));
}

/** Production or developer, from Organization.OrganizationType. A sandbox gives null: the login already says sandbox. */
export function orgTypeFrom(organizationType: string, isSandbox: boolean): Check['orgType'] {
  if (isSandbox) return null;
  return /developer/i.test(organizationType) ? 'developer' : 'production';
}

/** Queries orgs through the sf CLI's saved logins. Read-only: three queries per org. */
export function sfOrgQuery(): OrgQuery {
  return async (username) => {
    const org = await Org.create({ aliasOrUsername: username });
    const conn = org.getConnection();
    const [organization, packages, apex] = await Promise.all([
      conn.query<{ OrganizationType: string; IsSandbox: boolean }>(ORGANIZATION_SOQL),
      conn.tooling.query<InstalledPackageRecord>(PACKAGES_SOQL),
      conn.tooling.query(UNPACKAGED_APEX_SOQL),
    ]);
    const info = organization.records[0];
    if (!info) throw new Error("The org didn't say what kind of org it is.");
    return {
      orgType: info.OrganizationType,
      isSandbox: info.IsSandbox === true,
      packages: packages.records.map(pkgFrom),
      unpackagedApex: apex.totalSize,
    };
  };
}

const LOGIN_GONE =
  /expired access\/refresh token|invalid_grant|INVALID_SESSION_ID|NamedOrgNotFound|No authorization information/i;
const NOT_FOUND = /ENOTFOUND|getaddrinfo/i;
const NETWORK = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i;
const MAX_REASON = 200;

/** A one-line reason for a failed check. Links and session ids are removed. */
export function reasonFor(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (LOGIN_GONE.test(message)) return 'Its login expired or was revoked. Log in again with sf org login web.';
  if (NOT_FOUND.test(message)) return "Salesforce can't find this org's address. The org may have been deleted.";
  if (NETWORK.test(message)) return "Couldn't connect to Salesforce. Check your network and refresh.";
  const firstLine = (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0];
  const clean = firstLine
    .replace(/https?:\/\/\S+/gi, '(link removed)')
    .replace(/00D\w{12,15}!\S+/g, '(session removed)')
    .replace(/[A-Za-z0-9._!-]{40,}/g, '(removed)')
    .trim();
  if (clean === '') return "The org didn't answer the check.";
  return clean.length > MAX_REASON ? `${clean.slice(0, MAX_REASON - 1)}…` : clean;
}

class NoAnswer extends Error {}

/** Settles with the promise, or rejects with NoAnswer once ms have passed. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NoAnswer()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks one org and never throws: a failure comes back as an unreachable check.
 *
 * @param options.project the local project the org's source came from, if known
 * @param options.now the time to stamp on the check when it finishes
 */
export async function checkOrg(
  query: OrgQuery,
  username: string,
  options: { timeoutMs: number; project: string | null; now: () => Date }
): Promise<Check> {
  try {
    // Through then(), so a query that throws before returning a promise fails the same way.
    const answer = await withTimeout(Promise.resolve().then(() => query(username)), options.timeoutMs);
    const checkedAt = options.now().toISOString();
    return {
      health: 'ok',
      reason: null,
      orgType: orgTypeFrom(answer.orgType, answer.isSandbox),
      packages: answer.packages,
      source: answer.unpackagedApex > 0 ? { apexClasses: answer.unpackagedApex, project: options.project } : null,
      checkedAt,
    };
  } catch (error) {
    const reason = error instanceof NoAnswer ? NO_ANSWER : reasonFor(error);
    return { health: 'unreachable', reason, orgType: null, packages: [], source: null, checkedAt: options.now().toISOString() };
  }
}
