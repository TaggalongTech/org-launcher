import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { projectIndex, rememberProject } from '../../src/core/projects.js';
import { StateStore } from '../../src/core/state.js';

const BLUE = '00DAA0000000001AAA';
const GREEN = '00DAA0000000002AAA';

describe('projects: link orgs to local projects', () => {
  let root: string;
  let store: StateStore;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'org-launcher-projects-')));
    store = new StateStore(join(root, 'home'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Makes a project folder with the given sfdx-project.json contents (a string is written as is). */
  function project(name: string, config: unknown = { packageDirectories: [{ path: 'force-app' }] }): string {
    const folder = join(root, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'sfdx-project.json'), typeof config === 'string' ? config : JSON.stringify(config));
    return folder;
  }

  /** Makes <folder>/<state>/orgs/<orgId>/ and sets its modified time. */
  function orgFolder(folder: string, orgId: string, modified: Date, state = '.sf'): void {
    const dir = join(folder, state, 'orgs', orgId);
    mkdirSync(join(dir, 'localSourceTracking'), { recursive: true });
    utimesSync(dir, modified, modified);
  }

  it('finds sfdx-project.json from a subfolder', () => {
    const folder = project('kit');
    const deep = join(folder, 'force-app', 'main', 'default');
    mkdirSync(deep, { recursive: true });
    rememberProject(deep, store);
    expect(store.settings().projects).to.deep.equal([folder]);
  });

  it('a folder outside any project adds nothing', () => {
    const loose = join(root, 'loose');
    mkdirSync(loose);
    rememberProject(loose, store);
    expect(store.settings().projects).to.deep.equal([]);
  });

  it('remembering again moves the project to the front without a duplicate', () => {
    const first = project('first');
    const second = project('second');
    rememberProject(first, store);
    rememberProject(second, store);
    expect(store.settings().projects).to.deep.equal([second, first]);
    rememberProject(first, store);
    expect(store.settings().projects).to.deep.equal([first, second]);
  });

  it('projects list capped at 50', () => {
    const old = Array.from({ length: 50 }, (_, i) => join(root, `old-${i}`));
    store.updateSettings({ projects: old });
    const folder = project('newest');
    rememberProject(folder, store);
    const projects = store.settings().projects;
    expect(projects).to.have.length(50);
    expect(projects[0]).to.equal(folder);
    expect(projects[49]).to.equal(old[48]);
    expect(projects).not.to.include(old[49]);
  });

  it('label prefers name, then package, then folder', () => {
    const named = project('named', { name: 'Field Kit', packageDirectories: [{ path: 'a', package: 'kit-pkg' }] });
    const packaged = project('packaged', {
      packageDirectories: [{ path: 'a' }, { path: 'b', package: 'kit-pkg' }, { path: 'c', package: 'later' }],
    });
    const plain = project('plain-folder', { name: '  ', packageDirectories: [{ path: 'force-app' }] });
    const when = new Date(2026, 10, 1);
    orgFolder(named, BLUE, when);
    orgFolder(packaged, GREEN, when);
    const third = '00DAA0000000003AAA';
    orgFolder(plain, third, when, '.sfdx');
    const index = projectIndex([named, packaged, plain]);
    expect(Object.fromEntries(index)).to.deep.equal({ [BLUE]: 'Field Kit', [GREEN]: 'kit-pkg', [third]: 'plain-folder' });
  });

  it('org seen in two projects uses most recently modified orgs/<id> folder', () => {
    const older = project('older', { name: 'Older' });
    const newer = project('newer', { name: 'Newer' });
    orgFolder(older, BLUE, new Date(2026, 9, 1), '.sf');
    orgFolder(newer, BLUE, new Date(2026, 10, 1), '.sfdx');
    orgFolder(older, GREEN, new Date(2026, 10, 1), '.sfdx');
    orgFolder(newer, GREEN, new Date(2026, 9, 1), '.sf');
    const index = projectIndex([older, newer]);
    expect(index.get(BLUE)).to.equal('Newer');
    expect(index.get(GREEN)).to.equal('Older');
    expect(projectIndex([newer, older]).get(BLUE)).to.equal('Newer');
  });

  it('missing or unreadable project is skipped', () => {
    const good = project('good', { name: 'Good' });
    const corrupt = project('corrupt', '{ not json');
    const notObject = project('list', '[1, 2]');
    const locked = project('locked', { name: 'Locked' });
    const when = new Date(2026, 10, 1);
    orgFolder(good, BLUE, when);
    orgFolder(corrupt, GREEN, when);
    orgFolder(notObject, GREEN, when);
    orgFolder(locked, GREEN, when);
    // Windows has no unreadable mode bits, so only the other cases run there.
    const canLock = process.platform !== 'win32';
    if (canLock) chmodSync(join(locked, 'sfdx-project.json'), 0o000);
    try {
      const projects = [join(root, 'gone'), good, corrupt, notObject, ...(canLock ? [locked] : [])];
      expect(Object.fromEntries(projectIndex(projects))).to.deep.equal({ [BLUE]: 'Good' });
    } finally {
      if (canLock) chmodSync(join(locked, 'sfdx-project.json'), 0o600);
    }
  });

  it('only folders named like an org id count', () => {
    const folder = project('kit', { name: 'Kit' });
    const when = new Date(2026, 10, 1);
    orgFolder(folder, BLUE, when);
    orgFolder(folder, 'someone@example.com', when, '.sfdx');
    orgFolder(folder, '00DAA0000000001', when);
    writeFileSync(join(folder, '.sf', 'orgs', GREEN), 'a file, not a folder');
    expect(Object.fromEntries(projectIndex([folder]))).to.deep.equal({ [BLUE]: 'Kit' });
  });
});
