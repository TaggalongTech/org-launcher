import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { launcherHome, StateStore } from '../../src/core/state.js';
import { ValidationError } from '../../src/core/validate.js';

const ORG = '00D000000000001';
const OTHER = '00D000000000002';
const worker = fileURLToPath(new URL('fixtures/add-tags-worker.ts', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

type Worker = { ready: Promise<void>; done: Promise<{ code: number | null; stderr: string }> };

/** Starts the add-tags worker in its own node process. It writes once a "go" file appears in dir. */
function startWorker(dir: string, prefix: string): Worker {
  const child = spawn(
    process.execPath,
    ['--loader=ts-node/esm', '--disable-warning=ExperimentalWarning', '--disable-warning=DEP0180', worker, dir, prefix],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ready = new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
  const done = new Promise<{ code: number | null; stderr: string }>((resolve) =>
    child.on('close', (code) => resolve({ code, stderr }))
  );
  return { ready: Promise.race([ready, done.then(() => undefined)]), done };
}

function expectValidationError(fn: () => unknown, message?: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).to.be.instanceOf(ValidationError);
  if (message !== undefined) expect((caught as Error).message).to.equal(message);
}

describe('state store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'org-launcher-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('note round-trips verbatim', () => {
    const note = '<b>demo</b> & "Q4"';
    new StateStore(dir).update(ORG, { note });
    expect(new StateStore(dir).get(ORG).note).to.equal(note);
  });

  it('missing org is blank', () => {
    expect(new StateStore(dir).get(ORG)).to.deep.equal({
      tags: [],
      note: '',
      hidden: false,
      mainLogin: null,
      open: null,
    });
  });

  it('writes the documented file format', () => {
    new StateStore(dir).update(ORG, { note: 'build demo', hidden: true, open: { browser: 'chrome', profile: 'Profile 3' } });
    const data: unknown = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(data).to.deep.equal({
      version: 1,
      orgs: {
        [ORG]: {
          tags: [],
          note: 'build demo',
          hidden: true,
          mainLogin: null,
          open: { browser: 'chrome', profile: 'Profile 3' },
        },
      },
    });
    expect(readdirSync(dir).filter((name) => name !== 'state.json')).to.deep.equal([]);
  });

  it('corrupt state.json is backed up and reads empty', () => {
    writeFileSync(join(dir, 'state.json'), '{not json');
    const store = new StateStore(dir);
    expect(store.all()).to.deep.equal({});
    expect(readdirSync(dir).filter((name) => name.startsWith('state.json.bad-'))).to.have.length(1);
    store.update(ORG, { note: 'fresh' });
    expect(new StateStore(dir).get(ORG).note).to.equal('fresh');
  });

  it('non-object entry is ignored then replaced on write', () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, orgs: { [ORG]: 'just a note' } }));
    const store = new StateStore(dir);
    expect(store.get(ORG).note).to.equal('');
    store.update(ORG, { note: 'fixed' });
    expect(new StateStore(dir).get(ORG).note).to.equal('fixed');
  });

  it('fills missing fields of a hand-written entry', () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, orgs: { [ORG]: { note: 'from skill' } } }));
    expect(new StateStore(dir).get(ORG)).to.deep.equal({
      tags: [],
      note: 'from skill',
      hidden: false,
      mainLogin: null,
      open: null,
    });
  });

  it('keeps a hand edit past the limits until it is changed', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `t${i}`);
    const note = 'n'.repeat(600);
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, orgs: { [ORG]: { tags, note } } }));
    const store = new StateStore(dir);
    store.update(ORG, { hidden: true });
    expect(store.get(ORG)).to.deep.include({ tags, note, hidden: true });
    expectValidationError(() => store.addTags(ORG, ['more']), 'An org can have up to 10 tags.');
    expect(store.removeTags(ORG, ['t10']).tags).to.have.length(10);
  });

  it('reads each valid setting from a hand-edited settings.json', () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        port: 'x',
        tagOpen: { demo: { browser: 'chrome' }, 'bad tag': { browser: 'chrome' }, qa: { browser: 'opera' } },
        projects: ['/work/a', 7, ''],
        asked: { atLogin: true },
      })
    );
    expect(new StateStore(dir).settings()).to.deep.equal({
      port: 4242,
      defaultOpen: null,
      tagOpen: { demo: { browser: 'chrome' } },
      projects: ['/work/a'],
      asked: { atLogin: true, dock: false },
    });
  });

  it('addTags dedupes and keeps order', () => {
    const store = new StateStore(dir);
    store.addTags(ORG, ['demo', 'RLM ']);
    expect(store.addTags(ORG, ['rlm']).tags).to.deep.equal(['demo', 'rlm']);
    expect(new StateStore(dir).get(ORG).tags).to.deep.equal(['demo', 'rlm']);
  });

  it('removeTags', () => {
    const store = new StateStore(dir);
    store.addTags(ORG, ['demo', 'rlm', 'qa']);
    expect(store.removeTags(ORG, [' RLM', 'missing']).tags).to.deep.equal(['demo', 'qa']);
    expect(new StateStore(dir).get(ORG).tags).to.deep.equal(['demo', 'qa']);
  });

  it('setTags', () => {
    const store = new StateStore(dir);
    store.addTags(ORG, ['demo', 'rlm']);
    expect(store.setTags(ORG, ['QA', 'qa', 'beta']).tags).to.deep.equal(['qa', 'beta']);
    expect(store.setTags(ORG, []).tags).to.deep.equal([]);
  });

  it('rejects tag "has space"', () => {
    expectValidationError(
      () => new StateStore(dir).addTags(ORG, ['has space']),
      'Tags are lowercase letters, numbers, dot, dash or underscore, up to 32 characters.'
    );
    expect(existsSync(join(dir, 'state.json'))).to.equal(false);
  });

  it('rejects 11th tag', () => {
    const store = new StateStore(dir);
    store.setTags(ORG, Array.from({ length: 10 }, (_, i) => `t${i}`));
    expectValidationError(() => store.addTags(ORG, ['t10']), 'An org can have up to 10 tags.');
    expect(store.get(ORG).tags).to.have.length(10);
  });

  it('rejects 501-char note', () => {
    const store = new StateStore(dir);
    expectValidationError(() => store.update(ORG, { note: 'x'.repeat(501) }));
    expect(store.update(ORG, { note: `  ${'x'.repeat(500)}  ` }).note).to.have.length(500);
  });

  it('rejects a bad org id, open target or main login', () => {
    const store = new StateStore(dir);
    expectValidationError(() => store.update('not-an-org', { note: 'x' }));
    expectValidationError(() => store.update(ORG, { open: { browser: 'chrome', profile: '../etc' } }));
    expectValidationError(() => store.update(ORG, { open: { browser: 'firefox', profile: 'a/b' } }));
    // A profile that starts with a dash would read as a Firefox option.
    expectValidationError(() => store.update(ORG, { open: { browser: 'firefox', profile: '-new-instance' } }));
    expectValidationError(() => store.update(ORG, { open: { browser: 'firefox', profile: ' work' } }));
    expectValidationError(() => store.update(ORG, { open: { browser: 'safari' as 'chrome' } }));
    expectValidationError(() => store.update(ORG, { mainLogin: '  ' }));
    expect(store.update(ORG, { open: { browser: 'firefox', profile: 'dev-edition default' } }).open).to.deep.equal({
      browser: 'firefox',
      profile: 'dev-edition default',
    });
    expect(store.update(ORG, { open: { browser: 'edge' } }).open).to.deep.equal({ browser: 'edge' });
    expect(store.update(ORG, { mainLogin: 'admin@example.com' }).mainLogin).to.equal('admin@example.com');
  });

  it('update keeps fields it was not given', () => {
    const store = new StateStore(dir);
    store.update(ORG, { note: 'keep me', tags: ['demo'] });
    store.update(ORG, { hidden: true });
    store.update(OTHER, { note: 'other org' });
    expect(new StateStore(dir).get(ORG)).to.deep.include({ note: 'keep me', tags: ['demo'], hidden: true });
  });

  it('20 concurrent addTags from two StateStore instances all land', async () => {
    const workers = [startWorker(dir, '1'), startWorker(dir, '2')];
    await Promise.all(workers.map((w) => w.ready));
    writeFileSync(join(dir, 'go'), '');
    const results = await Promise.all(workers.map((w) => w.done));
    for (const result of results) expect(result, result.stderr).to.deep.include({ code: 0 });
    const orgs = new StateStore(dir).all();
    expect(Object.keys(orgs).length).to.equal(20);
    expect(existsSync(join(dir, 'state.lock'))).to.equal(false);
  });

  it('a second instance sees writes at once', () => {
    const a = new StateStore(dir);
    const b = new StateStore(dir);
    a.addTags(ORG, ['demo']);
    b.addTags(ORG, ['rlm']);
    expect(a.get(ORG).tags).to.deep.equal(['demo', 'rlm']);
  });

  it('stale lock older than 10 s is taken over', () => {
    const lock = join(dir, 'state.lock');
    writeFileSync(lock, 'someone else');
    const past = new Date(Date.now() - 11_000);
    utimesSync(lock, past, past);
    const started = Date.now();
    new StateStore(dir).addTags(ORG, ['demo']);
    expect(Date.now() - started).to.be.below(1000);
    expect(new StateStore(dir).get(ORG).tags).to.deep.equal(['demo']);
    expect(existsSync(lock)).to.equal(false);
  });

  it('a fresh lock held elsewhere times out after 2 s and changes nothing', () => {
    const lock = join(dir, 'state.lock');
    writeFileSync(lock, 'someone else');
    const started = Date.now();
    expect(() => new StateStore(dir).addTags(ORG, ['demo'])).to.throw(/busy/);
    const waited = Date.now() - started;
    expect(waited).to.be.within(1900, 3000);
    expect(readFileSync(lock, 'utf8')).to.equal('someone else');
    expect(existsSync(join(dir, 'state.json'))).to.equal(false);
  });

  it('settings defaults', () => {
    expect(new StateStore(dir).settings()).to.deep.equal({
      port: 4242,
      defaultOpen: null,
      tagOpen: {},
      projects: [],
      asked: { atLogin: false, dock: false },
    });
  });

  it('settings save and validate', () => {
    const store = new StateStore(dir);
    store.updateSettings({ port: 4343, tagOpen: { ' Demo ': { browser: 'brave', profile: 'Default' } } });
    store.updateSettings({ asked: { atLogin: true, dock: false } });
    expect(new StateStore(dir).settings()).to.deep.equal({
      port: 4343,
      defaultOpen: null,
      tagOpen: { demo: { browser: 'brave', profile: 'Default' } },
      projects: [],
      asked: { atLogin: true, dock: false },
    });
    expectValidationError(() => store.updateSettings({ port: 80 }));
    expectValidationError(() => store.updateSettings({ port: 70_000 }));
    expectValidationError(() => store.updateSettings({ defaultOpen: { browser: 'chrome', profile: 'Work' } }));
    expect(store.settings().port).to.equal(4343);
  });

  it('corrupt settings.json is backed up and reads defaults', () => {
    writeFileSync(join(dir, 'settings.json'), '[1,');
    expect(new StateStore(dir).settings().port).to.equal(4242);
    expect(readdirSync(dir).filter((name) => name.startsWith('settings.json.bad-'))).to.have.length(1);
  });

  it('launcherHome honors ORG_LAUNCHER_HOME', () => {
    const saved = process.env.ORG_LAUNCHER_HOME;
    try {
      process.env.ORG_LAUNCHER_HOME = dir;
      expect(launcherHome()).to.equal(dir);
      delete process.env.ORG_LAUNCHER_HOME;
      expect(launcherHome()).to.match(/[/\\]\.sf[/\\]org-launcher$/);
    } finally {
      if (saved === undefined) delete process.env.ORG_LAUNCHER_HOME;
      else process.env.ORG_LAUNCHER_HOME = saved;
    }
  });
});
