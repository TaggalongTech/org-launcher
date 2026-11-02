import { expect } from 'chai';
import { resolveOpen } from '../../src/core/openTarget.js';
import type { OrgEntry, Settings } from '../../src/core/state.js';

const entry = (over: Partial<OrgEntry> = {}): OrgEntry => ({
  tags: [],
  note: '',
  hidden: false,
  mainLogin: null,
  open: null,
  ...over,
});

const settings = (over: Partial<Settings> = {}): Settings => ({
  port: 4242,
  defaultOpen: null,
  tagOpen: {},
  projects: [],
  asked: { atLogin: false, dock: false },
  ...over,
});

describe('openTarget', () => {
  it('org override beats tag beats default', () => {
    const s = settings({
      defaultOpen: { browser: 'firefox' },
      tagOpen: { prod: { browser: 'edge', profile: 'Default' } },
    });
    const own = { browser: 'chrome' as const, profile: 'Profile 3' };
    expect(resolveOpen(entry({ tags: ['prod'], open: own }), s)).to.deep.equal(own);
    expect(resolveOpen(entry({ tags: ['prod'] }), s)).to.deep.equal({ browser: 'edge', profile: 'Default' });
    expect(resolveOpen(entry({ tags: ['other'] }), s)).to.deep.equal({ browser: 'firefox' });
  });

  it('first tag in org order with a mapping wins', () => {
    const s = settings({
      tagOpen: { alpha: { browser: 'brave' }, zeta: { browser: 'edge' } },
    });
    expect(resolveOpen(entry({ tags: ['none', 'zeta', 'alpha'] }), s)).to.deep.equal({ browser: 'edge' });
    expect(resolveOpen(entry({ tags: ['alpha', 'zeta'] }), s)).to.deep.equal({ browser: 'brave' });
  });

  it('null when nothing set', () => {
    expect(resolveOpen(entry({ tags: ['prod'] }), settings())).to.equal(null);
  });

  it('a tag named like an object property is not a mapping', () => {
    expect(resolveOpen(entry({ tags: ['constructor', 'tostring'] }), settings())).to.equal(null);
  });
});
