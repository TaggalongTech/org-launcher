import { expect } from 'chai';
import {
  checkOrg,
  isPermissionError,
  NO_PERMISSION,
  pkgFrom,
  reasonFor,
  visiblePackages,
  type Pkg,
} from '../../src/core/checks.js';

describe('checks: packages and reasons', () => {
  it('visiblePackages hides Salesforce namespaces and keeps no-namespace packages', () => {
    const packages: Pkg[] = [
      { name: 'Zeta Tools', namespace: 'zeta', version: '2.0.0.1' },
      { name: 'Sales Insights', namespace: 'OIQ', version: '1.0.0.1' },
      { name: 'Sales Insights lowercase', namespace: 'oiq', version: '1.0.0.1' },
      { name: 'My Unlocked App', namespace: null, version: '0.3.0.7' },
      { name: 'alpha kit', namespace: 'alpha', version: '1.0.0.0' },
    ];
    expect(visiblePackages(packages)).to.deep.equal([
      { name: 'alpha kit', namespace: 'alpha', version: '1.0.0.0' },
      { name: 'My Unlocked App', namespace: null, version: '0.3.0.7' },
      { name: 'Zeta Tools', namespace: 'zeta', version: '2.0.0.1' },
    ]);
    expect(packages).to.have.length(5); // the input list is not changed
  });

  it('version string is Major.Minor.Patch.Build', () => {
    const pkg = pkgFrom({
      SubscriberPackage: { Name: 'Field Kit', NamespacePrefix: 'fkit' },
      SubscriberPackageVersion: { MajorVersion: 4, MinorVersion: 0, PatchVersion: 0, BuildNumber: 3 },
    });
    expect(pkg).to.deep.equal({ name: 'Field Kit', namespace: 'fkit', version: '4.0.0.3' });
  });

  it('a package without a namespace has namespace null', () => {
    const pkg = pkgFrom({
      SubscriberPackage: { Name: 'My Unlocked App', NamespacePrefix: null },
      SubscriberPackageVersion: { MajorVersion: 1, MinorVersion: 2, PatchVersion: 0, BuildNumber: 11 },
    });
    expect(pkg).to.deep.equal({ name: 'My Unlocked App', namespace: null, version: '1.2.0.11' });
  });

  it('an expired login reads as a plain reason', () => {
    expect(reasonFor(new Error('expired access/refresh token'))).to.equal(
      'Its login expired or was revoked. Log in again with sf org login web.'
    );
  });

  it('a permission error is limited access, not an org that can not be reached', async () => {
    const denied = Object.assign(new Error("sObject type 'ApexClass' is not supported."), { name: 'INVALID_TYPE' });
    const check = await checkOrg(() => Promise.reject(denied), 'salesrep@example.org', {
      timeoutMs: 1000,
      project: null,
      now: () => new Date(0),
    });
    expect(check.health).to.equal('limited');
    expect(check.reason).to.equal(NO_PERMISSION);
    expect(isPermissionError(Object.assign(new Error('insufficient access rights'), { name: 'INSUFFICIENT_ACCESS' }))).to.equal(
      true
    );
    expect(isPermissionError(new Error('expired access/refresh token'))).to.equal(false);
  });

  it('a reason is one line and never carries a link or a session id', () => {
    const error = new Error(
      'Bad answer from https://blue.my.salesforce.com/services/data/v62.0 with 00DAA0000000001!AQEAQ.abcdefghijklmnop\nsecond line'
    );
    const reason = reasonFor(error);
    expect(reason).to.not.match(/https?:/);
    expect(reason).to.not.include('AQEAQ');
    expect(reason).to.not.include('\n');
    expect(reason).to.not.include('second line');
  });
});
