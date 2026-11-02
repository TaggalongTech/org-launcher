import { expect } from 'chai';
import { sfLoginUrl } from '../../src/core/loginUrl.js';

describe('browser: login url', () => {
  it('opens the org by username and asks it for a front-door link', async () => {
    const asked: string[] = [];
    const loginUrl = sfLoginUrl(async (aliasOrUsername) => {
      asked.push(aliasOrUsername);
      return { getFrontDoorUrl: async () => 'https://example.my.salesforce.com/secur/frontdoor.jsp?otp=stub' };
    });
    expect(await loginUrl('admin@example.com')).to.equal(
      'https://example.my.salesforce.com/secur/frontdoor.jsp?otp=stub'
    );
    expect(asked).to.deep.equal(['admin@example.com']);
  });

  it('passes on an org error so the caller can explain it', async () => {
    const loginUrl = sfLoginUrl(async () => {
      throw new Error('expired access/refresh token');
    });
    let error: unknown;
    try {
      await loginUrl('admin@example.com');
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).to.equal('expired access/refresh token');
  });
});
