import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { loginsFrom, type RawAuthorization } from '../../src/core/auth.js';
import { buildOrgs, type OrgLogin } from '../../src/core/orgs.js';

type Fixture = {
  scratchPair: OrgLogin[];
  devHub: OrgLogin;
  sandboxPair: OrgLogin[];
  aliasPair: OrgLogin[];
};

/** A fresh copy of the fixture logins for each test, so no test can change another's data. */
function fixture(): Fixture {
  const path = fileURLToPath(new URL('../fixtures/auths.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

/** The local calendar date `days` from today, as YYYY-MM-DD. */
function dayFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const SCRATCH = '00DAA0000000001AAA';
const HUB = '00DBB0000000002BBB';
const SANDBOX = '00DCC0000000003CCC';
const PROD = '00DDD0000000004DDD';

describe('orgs: one row per org', () => {
  it('two logins on one org become one row; scratch login is main', () => {
    const { scratchPair } = fixture();
    const orgs = buildOrgs([scratchPair[1], scratchPair[0]], {}, null);
    expect(orgs).to.have.length(1);
    const [org] = orgs;
    expect(org.orgId).to.equal(SCRATCH);
    expect(org.main.username).to.equal('test-abc123@example.com');
    expect(org.others.map((l) => l.username)).to.deep.equal(['qa@blue.example.com']);
    expect(org.type).to.equal('scratch');
    expect(org.alias).to.equal('blue');
    expect(org.otherAliases).to.deep.equal(['blue-qa']);
    expect(org.expires).to.equal('2999-01-01');
    expect(org.expired).to.equal(false);
  });

  it('saved main login wins over scratch', () => {
    const { scratchPair } = fixture();
    const [org] = buildOrgs(scratchPair, { [SCRATCH]: 'qa@blue.example.com' }, 'test-abc123@example.com');
    expect(org.main.username).to.equal('qa@blue.example.com');
    expect(org.alias).to.equal('blue-qa');
    expect(org.otherAliases).to.deep.equal(['blue']);
    expect(org.type).to.equal('scratch');
  });

  it('saved main login that no longer exists falls back', () => {
    const { scratchPair } = fixture();
    const [org] = buildOrgs(scratchPair, { [SCRATCH]: 'gone@blue.example.com' }, null);
    expect(org.main.username).to.equal('test-abc123@example.com');
  });

  it('default username is main for a non-scratch org', () => {
    const { sandboxPair } = fixture();
    const [org] = buildOrgs(sandboxPair, { [SANDBOX]: null }, 'builder@corp.example.com.uat');
    expect(org.main.username).to.equal('builder@corp.example.com.uat');
    expect(org.type).to.equal('sandbox');
  });

  it('first username alphabetically when nothing else decides', () => {
    const { sandboxPair } = fixture();
    const [org] = buildOrgs([sandboxPair[1], sandboxPair[0]], {}, 'someone@else.example.com');
    expect(org.main.username).to.equal('admin@corp.example.com.uat');
  });

  it('expired by date', () => {
    const { scratchPair } = fixture();
    const scratch = { ...scratchPair[0], expirationDate: dayFromToday(-1), isExpired: false };
    const [org] = buildOrgs([scratch], {}, null);
    expect(org.expires).to.equal(dayFromToday(-1));
    expect(org.expired).to.equal(true);
  });

  it('not expired on its last day', () => {
    const { scratchPair } = fixture();
    const scratch = { ...scratchPair[0], expirationDate: dayFromToday(0), isExpired: false };
    const [org] = buildOrgs([scratch], {}, null);
    expect(org.expired).to.equal(false);
  });

  it('expired when the sf CLI says so', () => {
    const { scratchPair } = fixture();
    const scratch = { ...scratchPair[0], isExpired: true };
    const [org] = buildOrgs([scratch], {}, null);
    expect(org.expired).to.equal(true);
  });

  it('devHub shows alias', () => {
    const { scratchPair, devHub } = fixture();
    const orgs = buildOrgs([...scratchPair, devHub], {}, null);
    const scratch = orgs.find((o) => o.orgId === SCRATCH);
    const hub = orgs.find((o) => o.orgId === HUB);
    expect(scratch?.devHub).to.equal('hub');
    expect(hub?.type).to.equal('devhub');
    expect(hub?.devHub).to.equal(null);
    expect(hub?.expires).to.equal(null);
  });

  it('devHub shows username when the Dev Hub has no login here', () => {
    const { scratchPair } = fixture();
    const [org] = buildOrgs(scratchPair, {}, null);
    expect(org.devHub).to.equal('hub@example.com');
  });

  it('alias is shortest alias', () => {
    const { devHub } = fixture();
    const [org] = buildOrgs([devHub], {}, null);
    expect(org.alias).to.equal('hub');
    expect(org.otherAliases).to.deep.equal(['aaa-long']);
  });

  it('org with no aliases uses username', () => {
    const { sandboxPair } = fixture();
    const [org] = buildOrgs([sandboxPair[0]], {}, null);
    expect(org.alias).to.equal('admin@corp.example.com.uat');
    expect(org.otherAliases).to.deep.equal([]);
  });

  it('no alias-suffix special case', () => {
    const { aliasPair } = fixture();
    const [org] = buildOrgs(aliasPair, {}, null);
    // The shorter alias wins by length alone, and the login that carries it is the main one.
    expect(org.main.username).to.equal('zed@prod.example.com');
    expect(org.alias).to.equal('admin');
    expect(org.otherAliases).to.deep.equal(['qa-readonly']);
    expect(org.type).to.equal('org');
  });

  describe('a scratch org with a second scratch login', () => {
    // Salesforce Labs' launchpad logs a sales rep in next to the admin login that created the org.
    // The sales rep sorts first alphabetically, so ties must not fall back to the first scratch login.
    const LAUNCHPAD = '00DEE0000000006EEE';
    const scratchLogin = (username: string, fields: Partial<OrgLogin> = {}): OrgLogin => ({
      orgId: LAUNCHPAD,
      username,
      aliases: [],
      isScratch: true,
      isDevHub: false,
      isSandbox: false,
      instanceUrl: 'https://launchpad.scratch.my.salesforce.com',
      isExpired: false,
      ...fields,
    });
    const admin = (fields: Partial<OrgLogin> = {}): OrgLogin =>
      scratchLogin('test-xyz789@example.com', {
        aliases: ['rlm-base__study'],
        devHubUsername: 'hub@example.com',
        expirationDate: '2999-01-01',
        ...fields,
      });

    it('the login that created the org is main', () => {
      const [org] = buildOrgs([scratchLogin('salesrep@example.org.00dee0000000006eee'), admin()], {}, null);
      expect(org.main.username).to.equal('test-xyz789@example.com');
      expect(org.alias).to.equal('rlm-base__study');
      expect(org.others.map((l) => l.username)).to.deep.equal(['salesrep@example.org.00dee0000000006eee']);
    });

    it('the creator wins even when the other login has an alias and the creator has none', () => {
      const salesRep = scratchLogin('salesrep@example.org.00dee0000000006eee', { aliases: ['sales-rep-user'] });
      const [org] = buildOrgs([salesRep, admin({ aliases: [] })], {}, null);
      expect(org.main.username).to.equal('test-xyz789@example.com');
    });

    it('a login with an alias is main when no login names a Dev Hub', () => {
      const salesRep = scratchLogin('salesrep@example.org.00dee0000000006eee');
      const [org] = buildOrgs([salesRep, admin({ devHubUsername: undefined })], {}, null);
      expect(org.main.username).to.equal('test-xyz789@example.com');
    });

    it('a saved main login still wins over the creator', () => {
      const salesRep = scratchLogin('salesrep@example.org.00dee0000000006eee');
      const [org] = buildOrgs([salesRep, admin()], { [LAUNCHPAD]: salesRep.username }, null);
      expect(org.main.username).to.equal(salesRep.username);
    });
  });

  it('keeps the 18-character org id as the sf CLI reports it', () => {
    const { aliasPair } = fixture();
    const [org] = buildOrgs(aliasPair, {}, null);
    expect(org.orgId).to.equal(PROD);
    expect(org.orgId).to.have.length(18);
  });
});

describe('orgs: reading sf CLI logins', () => {
  const raw = (fields: Partial<RawAuthorization>): RawAuthorization => ({
    orgId: '00DEE0000000005EEE',
    username: 'one@example.com',
    aliases: ['one'],
    isScratchOrg: false,
    isDevHub: false,
    isSandbox: false,
    instanceUrl: 'https://one.my.salesforce.com',
    isExpired: 'unknown',
    ...fields,
  });

  it('skips an unreadable login without logging its username', async () => {
    const logged: string[] = [];
    const logins = await loginsFrom(
      [raw({}), raw({ username: 'broken@example.com', error: 'bad file' })],
      () => Promise.resolve({}),
      (message) => logged.push(message)
    );
    expect(logins.map((l) => l.username)).to.deep.equal(['one@example.com']);
    expect(logged).to.deep.equal(['skipped one unreadable login']);
  });

  it('skips a login whose details cannot be read', async () => {
    const logged: string[] = [];
    const logins = await loginsFrom(
      [raw({}), raw({ username: 'broken@example.com' })],
      (username) => (username === 'broken@example.com' ? Promise.reject(new Error('no file')) : Promise.resolve({})),
      (message) => logged.push(message)
    );
    expect(logins.map((l) => l.username)).to.deep.equal(['one@example.com']);
    expect(logged).to.deep.equal(['skipped one unreadable login']);
  });

  it('copies only the fields a row needs, never tokens', async () => {
    const withToken = { ...raw({ isScratchOrg: true, isExpired: false, aliases: null }), accessToken: 'secret' };
    const [login] = await loginsFrom(
      [withToken],
      () => Promise.resolve({ expirationDate: '2999-01-01', devHubUsername: 'hub@example.com' }),
      () => {}
    );
    expect(login).to.deep.equal({
      orgId: '00DEE0000000005EEE',
      username: 'one@example.com',
      aliases: [],
      isScratch: true,
      isDevHub: false,
      isSandbox: false,
      instanceUrl: 'https://one.my.salesforce.com',
      devHubUsername: 'hub@example.com',
      expirationDate: '2999-01-01',
      isExpired: false,
    });
  });
});
