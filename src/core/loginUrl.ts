/**
 * Gets a one-time login link for an org. The link carries a session, so it goes straight to openUrl:
 * it is never logged, saved, put in an error message or sent to the page.
 */
import { Org } from '@salesforce/core';

/** Returns a fresh login link for the org that username belongs to. */
export type LoginUrl = (username: string) => Promise<string>;

/** The one Org method we need, so tests can pass a stand-in. */
type FrontDoor = { getFrontDoorUrl(): Promise<string> };

const openOrg = (aliasOrUsername: string): Promise<FrontDoor> => Org.create({ aliasOrUsername });

/** A LoginUrl backed by the sf CLI's saved logins. */
export function sfLoginUrl(createOrg: (aliasOrUsername: string) => Promise<FrontDoor> = openOrg): LoginUrl {
  return async (username: string): Promise<string> => {
    const org = await createOrg(username);
    return org.getFrontDoorUrl();
  };
}
