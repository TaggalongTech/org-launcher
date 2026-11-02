/**
 * What the commands use to reach the launcher's server, and to save tags and notes. A save goes through
 * the running server when there is one, and straight to the state files (under their lock) when there
 * isn't. A port held by another program is never written behind its back.
 */
import { request } from 'node:http';
import type { OrgLogin } from './orgs.js';
import type { StateStore } from './state.js';
import { normalizeNote, normalizeTags } from './validate.js';

export type ServerState = 'ours' | 'foreign' | 'down';
export type Health = { state: 'ours'; version: string } | { state: 'foreign' | 'down' };

/** The changes a command can make to one org. */
export type OrgPatch = { addTags?: string[]; removeTags?: string[]; tags?: string[]; note?: string };
/** What the commands show about an org after a change. */
export type OrgSummary = { orgId: string; tags: string[]; note: string };

export type ClientDeps = {
  store: StateStore;
  /** The sf CLI's logins, to find the org a name points at. */
  logins: () => Promise<OrgLogin[]>;
};

const HEALTH_TIMEOUT_MS = 1000;
const CONNECT_TIMEOUT_MS = 5000;
const SAVE_TIMEOUT_MS = 10_000;

/** Raised when the port in settings answers but isn't Org Launcher. */
export class PortInUseError extends Error {
  public constructor(public readonly port: number) {
    super(`Port ${port} is in use by another program. Set a different port with sf launcher start --port <n>.`);
    this.name = 'PortInUseError';
  }
}

export class UnknownOrgError extends Error {
  public constructor(target: string) {
    super(`No org "${target}" in your sf CLI logins.`);
    this.name = 'UnknownOrgError';
  }
}

/** An error the server sent back, with its message. */
export class ServerError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ServerError';
  }
}

type Answer = { status: number; text: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Raised when no connection was made in time: nothing accepted it, so nothing is listening. */
const NEVER_CONNECTED = 'ENEVERCONNECTED';

/**
 * Sends one request to 127.0.0.1:port. Connecting gets its own, longer allowance: Windows can take about
 * 2 s to refuse a closed port. Once connected, the answer must come within ms. Rejects with the error's
 * code: ECONNREFUSED or ENEVERCONNECTED when nothing listens, ETIMEDOUT when the answer is late.
 */
function send(port: number, method: 'GET' | 'POST', path: string, ms: number, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(body, 'utf8');
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      }
    );
    const giveUp = (after: number, code: string): NodeJS.Timeout =>
      setTimeout(() => req.destroy(Object.assign(new Error('timed out'), { code })), after);
    let timer = giveUp(CONNECT_TIMEOUT_MS, NEVER_CONNECTED);
    req.on('socket', (socket) => {
      const connected = (): void => {
        clearTimeout(timer);
        timer = giveUp(ms, 'ETIMEDOUT');
      };
      if (socket.connecting) socket.once('connect', connected);
      else connected();
    });
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(data);
  });
}

/** What a failed health request says about the port. */
export function stateFromError(error: unknown): 'foreign' | 'down' {
  const code = isRecord(error) ? error.code : undefined;
  return code === 'ECONNREFUSED' || code === NEVER_CONNECTED ? 'down' : 'foreign';
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Asks /api/health on port, waiting up to a second for the answer once connected. Org Launcher answers
 * {"app":"org-launcher"}; any other answer, or none in time, means another program has the port.
 * A refused connection, or none made at all, means down.
 */
export async function serverHealth(port: number): Promise<Health> {
  let answer: Answer;
  try {
    answer = await send(port, 'GET', '/api/health', HEALTH_TIMEOUT_MS);
  } catch (error) {
    return { state: stateFromError(error) };
  }
  const data = parse(answer.text);
  if (answer.status !== 200 || !isRecord(data) || data.app !== 'org-launcher') return { state: 'foreign' };
  return { state: 'ours', version: typeof data.version === 'string' ? data.version : 'unknown' };
}

export async function serverState(port: number): Promise<ServerState> {
  return (await serverHealth(port)).state;
}

const ORG_ID = /^00D[0-9A-Za-z]{12}([0-9A-Za-z]{3})?$/;

/**
 * The 18-character id of the org target names, like the sf CLI's -o: an alias, a username, or an org id
 * of 15 or 18 characters. Null when no login matches.
 */
export function findOrgId(target: string, logins: OrgLogin[]): string | null {
  const byAlias = logins.find((l) => l.aliases.includes(target));
  if (byAlias) return byAlias.orgId;
  const lower = target.toLowerCase();
  const byUsername = logins.find((l) => l.username.toLowerCase() === lower);
  if (byUsername) return byUsername.orgId;
  if (!ORG_ID.test(target)) return null;
  // An 18-character id's last three characters encode the case of the first 15, so it matches in any case.
  const byId =
    target.length === 18
      ? logins.find((l) => l.orgId.toLowerCase() === lower)
      : logins.find((l) => l.orgId.slice(0, 15) === target);
  return byId?.orgId ?? null;
}

/** The org's 18-character id, or UnknownOrgError. */
export async function resolveOrg(target: string, deps: ClientDeps): Promise<string> {
  const orgId = findOrgId(target, await deps.logins());
  if (orgId === null) throw new UnknownOrgError(target);
  return orgId;
}

/** Checks a patch before anything is saved, so a bad tag never leaves a half-made change. */
function checkPatch(patch: OrgPatch): OrgPatch {
  const checked: OrgPatch = {};
  if (patch.tags !== undefined) checked.tags = normalizeTags(patch.tags);
  if (patch.addTags !== undefined) checked.addTags = normalizeTags(patch.addTags);
  if (patch.removeTags !== undefined) checked.removeTags = normalizeTags(patch.removeTags);
  if (patch.note !== undefined) checked.note = normalizeNote(patch.note);
  return checked;
}

/** Saves through the running server. Null when the server doesn't know the org yet (a brand-new login). */
async function saveThroughServer(port: number, orgId: string, patch: OrgPatch): Promise<OrgSummary | null> {
  const answer = await send(port, 'POST', '/api/org', SAVE_TIMEOUT_MS, JSON.stringify({ id: orgId, ...patch }));
  const data = parse(answer.text);
  if (answer.status === 404) return null;
  if (answer.status !== 200 || !isRecord(data)) {
    const message = isRecord(data) && typeof data.error === 'string' ? data.error : "Org Launcher couldn't save that.";
    throw new ServerError(answer.status, message);
  }
  const tags = Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === 'string') : [];
  return { orgId, tags, note: typeof data.note === 'string' ? data.note : '' };
}

/** Saves to the state files, in the server's order: set fields, then add tags, then remove tags. */
function saveToFile(store: StateStore, orgId: string, patch: OrgPatch): OrgSummary {
  const fields = { ...(patch.tags ? { tags: patch.tags } : {}), ...(patch.note !== undefined ? { note: patch.note } : {}) };
  let entry = Object.keys(fields).length > 0 ? store.update(orgId, fields) : store.get(orgId);
  if (patch.addTags?.length) entry = store.addTags(orgId, patch.addTags);
  if (patch.removeTags?.length) entry = store.removeTags(orgId, patch.removeTags);
  return { orgId, tags: entry.tags, note: entry.note };
}

/**
 * Changes one org's tags or note. target is an alias, username or org id. Goes through the server when
 * it runs on the port in settings, else writes the files; refuses when another program has the port.
 */
export async function updateOrg(target: string, patch: OrgPatch, deps: ClientDeps): Promise<OrgSummary> {
  const checked = checkPatch(patch);
  const orgId = await resolveOrg(target, deps);
  const port = deps.store.settings().port;
  const state = await serverState(port);
  if (state === 'foreign') throw new PortInUseError(port);
  if (state === 'ours') {
    const saved = await saveThroughServer(port, orgId, checked);
    if (saved) return saved;
    // The server lists logins on its own schedule; the files take the same lock it uses.
  }
  return saveToFile(deps.store, orgId, checked);
}
