import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import type { OrgQuery, Pkg } from '../../src/core/checks.js';
import { Inventory, type OrgRow } from '../../src/core/inventory.js';
import type { AuthSource, OrgLogin } from '../../src/core/orgs.js';
import { StateStore } from '../../src/core/state.js';

const BLUE = '00DAA0000000001AAA';
const GREEN = '00DAA0000000002AAA';
const OLD = '00DAA0000000003AAA';
const PROD = '00DDD0000000004DDD';
const SANDBOX = '00DCC0000000005CCC';
const NOW = new Date(2026, 10, 2, 12, 0, 0); // 2 November 2026, local time

type Answer = Awaited<ReturnType<OrgQuery>>;

function login(orgId: string, username: string, extra: Partial<OrgLogin> = {}): OrgLogin {
  return {
    orgId,
    username,
    aliases: [],
    isScratch: false,
    isDevHub: false,
    isSandbox: false,
    instanceUrl: 'https://example.my.salesforce.com',
    isExpired: false,
    ...extra,
  };
}

const scratch = (orgId: string, username: string, alias: string, expirationDate = '2026-11-05'): OrgLogin =>
  login(orgId, username, { aliases: [alias], isScratch: true, expirationDate, devHubUsername: 'hub@example.com' });

function fakeAuth(logins: OrgLogin[]): AuthSource {
  return {
    listLogins: async () => logins.map((l) => ({ ...l, aliases: [...l.aliases] })),
    defaultUsername: async () => null,
  };
}

const answer = (extra: Partial<Answer> = {}): Answer => ({
  orgType: 'Developer Edition',
  isSandbox: false,
  packages: [],
  unpackagedApex: 0,
  ...extra,
});

const KIT: Pkg = { name: 'Field Kit', namespace: 'fkit', version: '4.0.0.3' };

/** Waits until the inventory's refresh has finished. */
async function idle(inventory: Inventory): Promise<void> {
  while (inventory.status().running) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Waits until the refresh has listed the logins and started checking. */
async function listed(inventory: Inventory): Promise<void> {
  while (inventory.status().running && inventory.status().total === 0) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const rowFor = (rows: OrgRow[], id: string): OrgRow => {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
};

describe('inventory: org checks in the background', () => {
  let dir: string;
  let store: StateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'org-launcher-inventory-'));
    store = new StateStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function inventory(logins: OrgLogin[], query: OrgQuery, extra: { workers?: number; timeoutMs?: number } = {}): Inventory {
    return new Inventory({ auth: fakeAuth(logins), query, store, cacheDir: dir, now: () => NOW, ...extra });
  }

  it('rows() returns instantly from cache while query never resolves', async () => {
    const logins = [scratch(BLUE, 'blue@example.com', 'blue')];
    const first = inventory(logins, async () => answer({ packages: [KIT] }));
    first.startRefresh();
    await idle(first);

    const second = inventory(logins, () => new Promise<Answer>(() => {}), { timeoutMs: 50 });
    expect(second.startRefresh()).to.equal('started');
    await listed(second);
    const rows = second.rows();
    expect(rows).to.be.an('array'); // not a promise
    expect(second.status().running).to.equal(true);
    const row = rowFor(rows, BLUE);
    expect(row.health).to.equal('ok');
    expect(row.packages).to.deep.equal([KIT]);
    expect(row.checkedAt).to.equal(NOW.toISOString());
    await idle(second);
  });

  it('health is unknown before the first check', async () => {
    const inv = inventory([scratch(BLUE, 'blue@example.com', 'blue')], () => new Promise<Answer>(() => {}), {
      timeoutMs: 50,
    });
    expect(inv.rows()).to.deep.equal([]);
    inv.startRefresh();
    await listed(inv);
    const row = rowFor(inv.rows(), BLUE);
    expect(row.health).to.equal('unknown');
    expect(row.packages).to.equal(null);
    expect(row.checkedAt).to.equal(null);
    expect(row.checkFailed).to.equal(false);
    await idle(inv);
  });

  it('unreachable org gets reason, others still checked', async () => {
    const logins = [scratch(BLUE, 'blue@example.com', 'blue'), scratch(GREEN, 'green@example.com', 'green')];
    const inv = inventory(logins, async (username) => {
      if (username === 'blue@example.com') throw new Error('expired access/refresh token');
      return answer({ packages: [KIT] });
    });
    inv.startRefresh();
    await idle(inv);
    const rows = inv.rows();
    const blue = rowFor(rows, BLUE);
    expect(blue.health).to.equal('unreachable');
    expect(blue.healthReason).to.equal('Its login expired or was revoked. Log in again with sf org login web.');
    const green = rowFor(rows, GREEN);
    expect(green.health).to.equal('ok');
    expect(green.healthReason).to.equal(null);
    expect(green.packages).to.deep.equal([KIT]);
    expect(inv.status()).to.include({ running: false, done: 2, total: 2, error: null });
  });

  it('timeout marks unreachable with "No answer in 30 seconds"', async () => {
    const inv = inventory([scratch(BLUE, 'blue@example.com', 'blue')], () => new Promise<Answer>(() => {}), {
      timeoutMs: 50,
    });
    inv.startRefresh();
    await idle(inv);
    const row = rowFor(inv.rows(), BLUE);
    expect(row.health).to.equal('unreachable');
    expect(row.healthReason).to.equal('No answer in 30 seconds');
  });

  it('failed check keeps previous packages and flags checkFailed', async () => {
    const logins = [scratch(BLUE, 'blue@example.com', 'blue')];
    const first = inventory(logins, async () => answer({ packages: [KIT], unpackagedApex: 42 }));
    first.startRefresh();
    await idle(first);

    const later = new Date(NOW.getTime() + 60_000);
    const second = new Inventory({
      auth: fakeAuth(logins),
      query: () => Promise.reject(new Error('expired access/refresh token')),
      store,
      cacheDir: dir,
      now: () => later,
    });
    second.startRefresh();
    await idle(second);
    const row = rowFor(second.rows(), BLUE);
    expect(row.checkFailed).to.equal(true);
    expect(row.health).to.equal('unreachable');
    expect(row.packages).to.deep.equal([KIT]);
    expect(row.source).to.deep.equal({ apexClasses: 42, project: null });
    expect(row.checkedAt).to.equal(later.toISOString());

    const cache = JSON.parse(readFileSync(join(dir, 'cache.json'), 'utf8')) as {
      checks: Record<string, { packages: Pkg[]; checkFailed: boolean }>;
    };
    expect(cache.checks[BLUE].packages).to.deep.equal([KIT]);
    expect(cache.checks[BLUE].checkFailed).to.equal(true);
  });

  it('failed check never changes tags or notes', async () => {
    store.update(BLUE, { tags: ['demo', 'q4'], note: 'keep me' });
    const before = readFileSync(join(dir, 'state.json'), 'utf8');
    const inv = inventory([scratch(BLUE, 'blue@example.com', 'blue')], () =>
      Promise.reject(new Error('expired access/refresh token'))
    );
    inv.startRefresh();
    await idle(inv);
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).to.equal(before);
    const row = rowFor(inv.rows(), BLUE);
    expect(row.tags).to.deep.equal(['demo', 'q4']);
    expect(row.note).to.equal('keep me');
  });

  it('expired scratch org is not queried', async () => {
    const asked: string[] = [];
    const logins = [scratch(BLUE, 'blue@example.com', 'blue'), scratch(OLD, 'old@example.com', 'old', '2026-10-01')];
    const inv = inventory(logins, async (username) => {
      asked.push(username);
      return answer();
    });
    inv.startRefresh();
    await idle(inv);
    expect(asked).to.deep.equal(['blue@example.com']);
    const old = rowFor(inv.rows(), OLD);
    expect(old.health).to.equal('expired');
    expect(old.daysLeft).to.equal(-32);
    expect(inv.status()).to.include({ done: 1, total: 1 });
  });

  it('unpackagedApex 0 → source null; 42 → {apexClasses:42, project:null}', async () => {
    const logins = [scratch(BLUE, 'blue@example.com', 'blue'), scratch(GREEN, 'green@example.com', 'green')];
    const inv = inventory(logins, async (username) => answer({ unpackagedApex: username === 'blue@example.com' ? 0 : 42 }));
    inv.startRefresh();
    await idle(inv);
    const rows = inv.rows();
    expect(rowFor(rows, BLUE).source).to.equal(null);
    expect(rowFor(rows, GREEN).source).to.deep.equal({ apexClasses: 42, project: null });
  });

  it('source.project names the local project the org was deployed from', async () => {
    const folder = join(dir, 'field-kit');
    mkdirSync(join(folder, '.sf', 'orgs', GREEN), { recursive: true });
    mkdirSync(join(folder, '.sf', 'orgs', BLUE), { recursive: true });
    writeFileSync(join(folder, 'sfdx-project.json'), JSON.stringify({ name: 'Field Kit' }));
    store.updateSettings({ projects: [folder] });
    const logins = [scratch(BLUE, 'blue@example.com', 'blue'), scratch(GREEN, 'green@example.com', 'green')];
    const inv = inventory(logins, async (username) => answer({ unpackagedApex: username === 'blue@example.com' ? 0 : 42 }));
    inv.startRefresh();
    await idle(inv);
    const rows = inv.rows();
    expect(rowFor(rows, BLUE).source).to.equal(null);
    expect(rowFor(rows, GREEN).source).to.deep.equal({ apexClasses: 42, project: 'Field Kit' });
  });

  it('the project index is rebuilt at each refresh start', async () => {
    let builds = 0;
    let label = 'First';
    const inv = new Inventory({
      auth: fakeAuth([scratch(BLUE, 'blue@example.com', 'blue')]),
      query: async () => answer({ unpackagedApex: 3 }),
      store,
      cacheDir: dir,
      now: () => NOW,
      projectIndex: () => {
        builds += 1;
        return new Map([[BLUE, label]]);
      },
    });
    inv.startRefresh();
    await idle(inv);
    expect(rowFor(inv.rows(), BLUE).source).to.deep.equal({ apexClasses: 3, project: 'First' });
    label = 'Second';
    inv.startRefresh();
    await idle(inv);
    expect(builds).to.equal(2);
    expect(rowFor(inv.rows(), BLUE).source).to.deep.equal({ apexClasses: 3, project: 'Second' });
  });

  it('a project index that throws leaves project null and checks every org', async () => {
    const logins = [scratch(BLUE, 'blue@example.com', 'blue'), scratch(GREEN, 'green@example.com', 'green')];
    const inv = new Inventory({
      auth: fakeAuth(logins),
      query: async () => answer({ unpackagedApex: 7 }),
      store,
      cacheDir: dir,
      now: () => NOW,
      projectIndex: () => {
        throw new Error('disk trouble');
      },
    });
    inv.startRefresh();
    await idle(inv);
    expect(inv.status()).to.include({ running: false, done: 2, total: 2, error: null });
    for (const row of inv.rows()) expect(row.source).to.deep.equal({ apexClasses: 7, project: null });
  });

  it("second startRefresh while running returns 'already running'", async () => {
    let release: (value: Answer) => void = () => {};
    const inv = inventory([scratch(BLUE, 'blue@example.com', 'blue')], () =>
      new Promise<Answer>((resolve) => {
        release = resolve;
      })
    );
    expect(inv.startRefresh()).to.equal('started');
    expect(inv.startRefresh()).to.equal('already running');
    await listed(inv);
    expect(inv.startRefresh()).to.equal('already running');
    release(answer());
    await idle(inv);
    expect(inv.startRefresh()).to.equal('started');
    await listed(inv);
    release(answer());
    await idle(inv);
  });

  it('forget drops the org at once, even when a running refresh listed it before the logout', async () => {
    const blue = scratch(BLUE, 'blue@example.com', 'blue');
    const green = scratch(GREEN, 'green@example.com', 'green');
    // Each listing answers when the test releases it, with the logins as they are at that moment.
    const listings: Array<() => void> = [];
    let current = [blue, green];
    const auth: AuthSource = {
      listLogins: () =>
        new Promise<OrgLogin[]>((resolve) => {
          const before = current;
          listings.push(() => resolve(before));
        }),
      defaultUsername: async () => null,
    };
    const inv = new Inventory({ auth, query: async () => answer(), store, cacheDir: dir, now: () => NOW });
    const waitForListing = async (n: number): Promise<void> => {
      while (listings.length < n) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    };

    inv.startRefresh();
    await waitForListing(1);
    listings[0]();
    await idle(inv);
    expect(inv.rows().map((r) => r.id)).to.deep.equal([BLUE, GREEN]);

    // A refresh lists the logins; then Remove logs out of blue while that listing is still out.
    inv.startRefresh();
    await waitForListing(2);
    current = [green];
    inv.forget(BLUE);
    expect(inv.rows().map((r) => r.id)).to.deep.equal([GREEN]);

    listings[1](); // The listing from before the logout still has blue.
    await waitForListing(3); // A second refresh starts when the first ends.
    expect(inv.rows().map((r) => r.id)).to.deep.equal([GREEN]);
    listings[2]();
    await idle(inv);
    expect(inv.rows().map((r) => r.id)).to.deep.equal([GREEN]);
    expect(listings).to.have.length(3);
  });

  it("orgType Developer Edition → 'developer', Production → 'production', IsSandbox → stays 'sandbox'", async () => {
    const logins = [
      login(BLUE, 'dev@example.com', { aliases: ['dev'] }),
      login(PROD, 'admin@corp.example.com', { aliases: ['prod'] }),
      login(SANDBOX, 'admin@corp.example.com.uat', { aliases: ['uat'], isSandbox: true }),
      scratch(GREEN, 'green@example.com', 'green'),
    ];
    const types: Record<string, Answer> = {
      'dev@example.com': answer({ orgType: 'Developer Edition' }),
      'admin@corp.example.com': answer({ orgType: 'Enterprise Edition' }),
      'admin@corp.example.com.uat': answer({ orgType: 'Enterprise Edition', isSandbox: true }),
      'green@example.com': answer({ orgType: 'Developer Edition' }),
    };
    const inv = inventory(logins, async (username) => types[username]);
    expect(inv.startRefresh()).to.equal('started');
    await idle(inv);
    const rows = inv.rows();
    expect(rowFor(rows, BLUE).type).to.equal('developer');
    expect(rowFor(rows, PROD).type).to.equal('production');
    expect(rowFor(rows, SANDBOX).type).to.equal('sandbox');
    expect(rowFor(rows, GREEN).type).to.equal('scratch');
  });

  it('a row carries saved fields, logins and days left', async () => {
    store.update(BLUE, { tags: ['demo'], note: 'hello', hidden: true, open: { browser: 'chrome', profile: 'Profile 3' } });
    const logins = [
      scratch(BLUE, 'blue@example.com', 'blue'),
      login(BLUE, 'qa@blue.example.com', { aliases: ['blue-qa'] }),
      login('00DBB0000000002BBB', 'hub@example.com', { aliases: ['hub'], isDevHub: true }),
    ];
    const inv = inventory(logins, async () => answer());
    inv.startRefresh();
    await idle(inv);
    const row = rowFor(inv.rows(), BLUE);
    expect(row).to.deep.include({
      id: BLUE,
      alias: 'blue',
      otherAliases: ['blue-qa'],
      type: 'scratch',
      devHub: 'hub',
      expires: '2026-11-05',
      daysLeft: 3,
      health: 'ok',
      healthReason: null,
      tags: ['demo'],
      note: 'hello',
      hidden: true,
      open: { browser: 'chrome', profile: 'Profile 3' },
      checkFailed: false,
    });
    expect(row.logins).to.deep.equal([
      { username: 'blue@example.com', aliases: ['blue'], main: true },
      { username: 'qa@blue.example.com', aliases: ['blue-qa'], main: false },
    ]);
    const hub = rowFor(inv.rows(), '00DBB0000000002BBB');
    expect(hub.daysLeft).to.equal(null);
    expect(hub.open).to.equal(null);
    expect(hub.tags).to.deep.equal([]);
  });

  it('a row hides Salesforce packages', async () => {
    const insights: Pkg = { name: 'Sales Insights', namespace: 'OIQ', version: '1.0.0.1' };
    const inv = inventory([scratch(BLUE, 'blue@example.com', 'blue')], async () => answer({ packages: [KIT, insights] }));
    inv.startRefresh();
    await idle(inv);
    expect(rowFor(inv.rows(), BLUE).packages).to.deep.equal([KIT]);
  });

  it('checks at most 6 orgs at a time', async () => {
    const logins = Array.from({ length: 9 }, (_, i) =>
      scratch(`00DAA00000000${String(10 + i)}AAA`, `user${i}@example.com`, `org${i}`)
    );
    let running = 0;
    let most = 0;
    const inv = inventory(logins, async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return answer();
    });
    inv.startRefresh();
    await idle(inv);
    expect(most).to.equal(6);
    expect(inv.status()).to.include({ done: 9, total: 9 });
  });

  it('a login listing failure shows in status and keeps the last rows', async () => {
    const logins = [scratch(BLUE, 'blue@example.com', 'blue')];
    let fail = false;
    const auth: AuthSource = {
      listLogins: async () => {
        if (fail) throw new Error('disk trouble at https://login.salesforce.com/secret');
        return logins;
      },
      defaultUsername: async () => null,
    };
    const inv = new Inventory({ auth, query: async () => answer(), store, cacheDir: dir, now: () => NOW });
    inv.startRefresh();
    await idle(inv);
    fail = true;
    inv.startRefresh();
    await idle(inv);
    const status = inv.status();
    expect(status.running).to.equal(false);
    expect(status.error).to.equal("Couldn't read your sf CLI logins. Run sf org list to see what's wrong.");
    expect(inv.rows().map((r) => r.id)).to.deep.equal([BLUE]);
  });

  it('a corrupt cache.json reads as empty', async () => {
    writeFileSync(join(dir, 'cache.json'), '{ not json');
    const inv = inventory([scratch(BLUE, 'blue@example.com', 'blue')], async () => answer({ packages: [KIT] }));
    inv.startRefresh();
    await idle(inv);
    expect(rowFor(inv.rows(), BLUE).packages).to.deep.equal([KIT]);
    const cache = JSON.parse(readFileSync(join(dir, 'cache.json'), 'utf8')) as { checks: Record<string, unknown> };
    expect(Object.keys(cache.checks)).to.deep.equal([BLUE]);
  });
});
