/**
 * Turns the sf CLI's saved logins into one row per org. Pure: no disk, no network.
 * Several logins can point at one org; one of them is the org's main login and gives the row its alias.
 */

/** One saved sf CLI login. Never carries tokens or login URLs. */
export type Login = {
  username: string;
  aliases: string[];
  isScratch: boolean;
  isDevHub: boolean;
  isSandbox: boolean;
  instanceUrl: string;
  devHubUsername?: string;
  expirationDate?: string;
  isExpired: boolean;
};

/** A login plus the 18-character id of the org it belongs to. */
export type OrgLogin = Login & { orgId: string };

/** Where logins come from: the sf CLI on a real machine, a fake in tests. */
export type AuthSource = { listLogins(): Promise<OrgLogin[]>; defaultUsername(): Promise<string | null> };

/** 'org' until a check against the org says whether it's production or a developer org. */
export type OrgType = 'scratch' | 'sandbox' | 'devhub' | 'production' | 'developer' | 'org';

export type OrgRecord = {
  orgId: string;
  alias: string;
  otherAliases: string[];
  main: Login;
  others: Login[];
  type: OrgType;
  devHub: string | null;
  expires: string | null;
  expired: boolean;
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Shortest first, then alphabetical. */
const byLengthThenText = (a: string, b: string): number => a.length - b.length || byText(a, b);

/** The alias a login shows by: its shortest alias, or undefined when it has none. */
const shortestAlias = (login: Login): string | undefined => [...login.aliases].sort(byLengthThenText)[0];

/** The local calendar date of `now` as YYYY-MM-DD, the same shape as an expiration date. */
function localDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Picks the org's main login. See the order in the comments below. */
function pickMain(logins: OrgLogin[], saved: string | null | undefined, defaultUser: string | null): OrgLogin {
  // 1. The login the person chose, if it's still here.
  const chosen = saved ? logins.find((l) => l.username === saved) : undefined;
  if (chosen) return chosen;
  // 2. The login that created a scratch org. Only that login's auth file names the Dev Hub; other users
  //    logged in to the org (a launchpad's sales rep, say) don't. Then a scratch login with an alias, then any.
  const scratch = logins.filter((l) => l.isScratch);
  const creator = scratch.find((l) => l.devHubUsername) ?? scratch.find((l) => l.aliases.length > 0) ?? scratch[0];
  if (creator) return creator;
  // 3. The sf CLI's default login, if it's on this org.
  const fallback = defaultUser ? logins.find((l) => l.username === defaultUser) : undefined;
  if (fallback) return fallback;
  // 4. A login with an alias: shortest alias first, then alphabetical.
  const aliased = logins
    .filter((l) => l.aliases.length > 0)
    .sort((a, b) => byLengthThenText(shortestAlias(a) ?? '', shortestAlias(b) ?? '') || byText(a.username, b.username));
  if (aliased.length > 0) return aliased[0];
  // 5. The first username alphabetically.
  return [...logins].sort((a, b) => byText(a.username, b.username))[0];
}

function orgType(logins: OrgLogin[]): OrgType {
  if (logins.some((l) => l.isScratch)) return 'scratch';
  if (logins.some((l) => l.isDevHub)) return 'devhub';
  if (logins.some((l) => l.isSandbox)) return 'sandbox';
  return 'org';
}

/** Drops orgId so a row's logins carry only login fields. */
function asLogin({ orgId, ...login }: OrgLogin): Login {
  void orgId;
  return login;
}

/**
 * Groups logins by org and builds one row per org, sorted by alias.
 *
 * @param logins every saved login, each with its org id
 * @param mains the main login each org's saved entry names, by org id
 * @param defaultUser the sf CLI's default username, or null
 * @param now the current time; tests pass a fixed one
 */
export function buildOrgs(
  logins: OrgLogin[],
  mains: Record<string, string | null>,
  defaultUser: string | null,
  now: Date = new Date()
): OrgRecord[] {
  const byOrg = new Map<string, OrgLogin[]>();
  for (const login of logins) {
    const group = byOrg.get(login.orgId);
    if (group) group.push(login);
    else byOrg.set(login.orgId, [login]);
  }
  const byUsername = new Map(logins.map((l) => [l.username, l]));
  const today = localDate(now);

  const records: OrgRecord[] = [];
  for (const [orgId, unsorted] of byOrg) {
    // Alphabetical first, so ties (two scratch logins, say) always pick the same main login.
    const group = [...unsorted].sort((a, b) => byText(a.username, b.username));
    const main = pickMain(group, mains[orgId], defaultUser);
    const others = group.filter((l) => l !== main).sort((a, b) => byText(a.username, b.username));
    const alias = shortestAlias(main) ?? main.username;
    const otherAliases = [...new Set(group.flatMap((l) => l.aliases))].filter((a) => a !== alias).sort(byLengthThenText);

    const withExpiry = [main, ...others].find((l) => l.expirationDate);
    const expires = withExpiry?.expirationDate ?? null;
    const expired = group.some((l) => l.isExpired) || (expires !== null && expires < today);

    const hubUsername = [main, ...others].find((l) => l.devHubUsername)?.devHubUsername;
    const hubLogin = hubUsername ? byUsername.get(hubUsername) : undefined;
    const devHub = hubUsername ? (hubLogin && shortestAlias(hubLogin)) ?? hubUsername : null;

    records.push({
      orgId,
      alias,
      otherAliases,
      main: asLogin(main),
      others: others.map(asLogin),
      type: orgType(group),
      devHub,
      expires,
      expired,
    });
  }
  return records.sort((a, b) => byText(a.alias.toLowerCase(), b.alias.toLowerCase()) || byText(a.orgId, b.orgId));
}
