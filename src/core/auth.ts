/**
 * Reads the sf CLI's saved logins through @salesforce/core. Only the fields a row needs are copied;
 * tokens and login URLs never leave this file.
 */
import { AuthInfo, ConfigAggregator, Logger, OrgConfigProperties, StateAggregator, type OrgAuthorization } from '@salesforce/core';
import type { AuthSource, OrgLogin } from './orgs.js';

/** The fields we read from one entry of AuthInfo.listAllAuthorizations(). */
export type RawAuthorization = Pick<
  OrgAuthorization,
  'orgId' | 'username' | 'aliases' | 'isScratchOrg' | 'isDevHub' | 'isSandbox' | 'instanceUrl' | 'error' | 'isExpired'
>;

/** Details only the login's own auth file has. */
export type LoginDetails = { expirationDate?: string; devHubUsername?: string };

const SKIPPED = 'skipped one unreadable login';

/**
 * Turns sf CLI authorizations into logins. A login whose auth file can't be read is skipped and
 * logged without its username.
 */
export async function loginsFrom(
  auths: RawAuthorization[],
  detailsFor: (username: string) => Promise<LoginDetails>,
  log: (message: string) => void
): Promise<OrgLogin[]> {
  const logins: OrgLogin[] = [];
  for (const auth of auths) {
    if (auth.error !== undefined || !auth.orgId) {
      log(SKIPPED);
      continue;
    }
    let details: LoginDetails;
    try {
      // One at a time: @salesforce/core warns that parallel AuthInfo reads can collide.
      // eslint-disable-next-line no-await-in-loop
      details = await detailsFor(auth.username);
    } catch {
      log(SKIPPED);
      continue;
    }
    const login: OrgLogin = {
      orgId: auth.orgId,
      username: auth.username,
      aliases: auth.aliases ?? [],
      isScratch: auth.isScratchOrg === true,
      isDevHub: auth.isDevHub === true,
      isSandbox: auth.isSandbox === true,
      instanceUrl: auth.instanceUrl ?? '',
      isExpired: auth.isExpired === true,
    };
    if (details.devHubUsername) login.devHubUsername = details.devHubUsername;
    if (details.expirationDate) login.expirationDate = details.expirationDate;
    logins.push(login);
  }
  return logins;
}

/** Reads the two fields listAllAuthorizations() doesn't return. */
async function readDetails(username: string): Promise<LoginDetails> {
  const fields = (await AuthInfo.create({ username })).getFields();
  return { expirationDate: fields.expirationDate, devHubUsername: fields.devHubUsername };
}

/** The sf CLI's logins on this machine. Each call reads the sf CLI's files again, so new logins and aliases show up. */
export function sfAuthSource(options: { log?: (message: string) => void } = {}): AuthSource {
  const log = options.log ?? ((message: string): void => void Logger.childFromRoot('org-launcher').warn(message));
  return {
    async listLogins(): Promise<OrgLogin[]> {
      await StateAggregator.clearInstanceAsync(); // re-read aliases saved since the last call
      const auths = await AuthInfo.listAllAuthorizations();
      return loginsFrom(auths, readDetails, log);
    },
    async defaultUsername(): Promise<string | null> {
      await ConfigAggregator.clearInstance(); // re-read a default set since the last call
      await StateAggregator.clearInstanceAsync();
      const config = await ConfigAggregator.create();
      const target = config.getPropertyValue<string>(OrgConfigProperties.TARGET_ORG);
      if (!target) return null;
      const state = await StateAggregator.getInstance();
      return state.aliases.resolveUsername(target);
    },
  };
}
