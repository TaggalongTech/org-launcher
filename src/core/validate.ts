/** Checks for everything people can save. Each error message is written to be shown to them as is. */

export class ValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export type Browser = 'chrome' | 'edge' | 'brave' | 'firefox';
/** A browser and, optionally, one of its profiles. No profile means the browser's last-used one. */
export type OpenTarget = { browser: Browser; profile?: string };

export const MAX_TAGS = 10;
export const MAX_NOTE = 500;
const MAX_LOGIN = 255;
const BROWSERS: readonly Browser[] = ['chrome', 'edge', 'brave', 'firefox'];
const TAG = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ORG_ID = /^00D[A-Za-z0-9]{12,15}$/;
const CHROMIUM_PROFILE = /^(Default|Profile [0-9]{1,4})$/;
const FIREFOX_PROFILE = /^[A-Za-z0-9_.][A-Za-z0-9 ._-]{0,63}$/;

/** Trims and lowercases a tag, then checks it. */
export function normalizeTag(t: string): string {
  const tag = typeof t === 'string' ? t.trim().toLowerCase() : '';
  if (!TAG.test(tag)) {
    throw new ValidationError('Tags are lowercase letters, numbers, dot, dash or underscore, up to 32 characters.');
  }
  return tag;
}

/** Normalizes a list of tags, drops repeats (first one wins) and checks the count. */
export function normalizeTags(tags: readonly string[]): string[] {
  if (!Array.isArray(tags)) throw new ValidationError('Tags must be a list.');
  const result = [...new Set(tags.map(normalizeTag))];
  if (result.length > MAX_TAGS) throw new ValidationError(`An org can have up to ${MAX_TAGS} tags.`);
  return result;
}

/** Trims a note and checks its length. */
export function normalizeNote(note: string): string {
  if (typeof note !== 'string') throw new ValidationError('A note must be text.');
  const trimmed = note.trim();
  if (trimmed.length > MAX_NOTE) throw new ValidationError(`A note can be up to ${MAX_NOTE} characters.`);
  return trimmed;
}

export function checkOrgId(orgId: string): string {
  if (typeof orgId !== 'string' || !ORG_ID.test(orgId)) {
    throw new ValidationError('That is not a Salesforce org id. Org ids start with 00D.');
  }
  return orgId;
}

/** A main login is the username to open the org with, or null to clear it. */
export function normalizeMainLogin(login: string | null): string | null {
  if (login === null) return null;
  const trimmed = typeof login === 'string' ? login.trim() : '';
  if (trimmed === '' || trimmed.length > MAX_LOGIN || /\s/.test(trimmed)) {
    throw new ValidationError('The main login must be a username, like admin@example.com.');
  }
  return trimmed;
}

/** Checks a browser and profile pair; null clears it. Returns a fresh copy with only the known fields. */
export function normalizeOpenTarget(target: OpenTarget | null): OpenTarget | null {
  if (target === null) return null;
  if (typeof target !== 'object' || !BROWSERS.includes(target.browser)) {
    throw new ValidationError('Pick a browser: chrome, edge, brave or firefox.');
  }
  if (target.profile === undefined) return { browser: target.browser };
  const profile = target.profile;
  if (target.browser === 'firefox') {
    if (typeof profile !== 'string' || !FIREFOX_PROFILE.test(profile)) {
      throw new ValidationError(
        "Firefox profile names are letters, numbers, spaces, dot, dash or underscore, and can't start with a dash or a space."
      );
    }
  } else if (typeof profile !== 'string' || !CHROMIUM_PROFILE.test(profile)) {
    throw new ValidationError('Profiles for this browser are named "Default" or "Profile" and a number, like "Profile 3".');
  }
  return { browser: target.browser, profile };
}

export function checkPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new ValidationError('The port must be a whole number from 1024 to 65535.');
  }
  return port;
}
