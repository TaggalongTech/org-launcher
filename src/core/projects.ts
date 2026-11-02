/**
 * The local projects a developer runs the launcher from, and which org each one deployed to. The sf CLI
 * keeps a folder per org under a project's .sf/orgs (and the older .sfdx/orgs) once it tracks source there.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { StateStore } from './state.js';

const PROJECT_FILE = 'sfdx-project.json';
const ORG_FOLDERS = [join('.sf', 'orgs'), join('.sfdx', 'orgs')];
const MAX_PROJECTS = 50;
/** An 18-character org id, the name the sf CLI gives each org's folder. */
const ORG_ID = /^00D[0-9A-Za-z]{15}$/;

/** Adds the project holding cwd to the front of the remembered projects. A folder outside any project adds nothing. */
export function rememberProject(cwd: string, store: StateStore): void {
  const folder = projectRoot(cwd);
  if (folder === null) return;
  const projects = store.settings().projects;
  if (projects[0] === folder) return;
  store.updateSettings({ projects: [folder, ...projects.filter((p) => p !== folder)].slice(0, MAX_PROJECTS) });
}

/**
 * Maps each org id to the label of the project that last deployed to it. When two projects know the same
 * org, the one whose org folder changed most recently wins. Projects that are gone or unreadable are skipped.
 */
export function projectIndex(projects: string[]): Map<string, string> {
  const newest = new Map<string, { label: string; modified: number }>();
  for (const folder of projects) {
    const label = projectLabel(folder);
    if (label === null) continue;
    for (const [orgId, modified] of orgFolders(folder)) {
      const seen = newest.get(orgId);
      if (!seen || modified > seen.modified) newest.set(orgId, { label, modified });
    }
  }
  return new Map([...newest].map(([orgId, { label }]) => [orgId, label]));
}

/** The nearest folder at or above start that holds sfdx-project.json, or null. */
function projectRoot(start: string): string | null {
  let folder = resolve(start);
  for (;;) {
    if (isFile(join(folder, PROJECT_FILE))) return folder;
    const parent = dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
}

/** sfdx-project.json's name, else its first package name, else the folder name. Null when the file can't be read. */
function projectLabel(folder: string): string | null {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(join(folder, PROJECT_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(config)) return null;
  const name = nonBlank(config.name);
  if (name) return name;
  const dirs = Array.isArray(config.packageDirectories) ? config.packageDirectories : [];
  for (const dir of dirs) {
    const pkg = isRecord(dir) ? nonBlank(dir.package) : null;
    if (pkg) return pkg;
  }
  return basename(folder);
}

/** Each org folder in the project, with when it last changed. */
function orgFolders(folder: string): Array<[string, number]> {
  const found: Array<[string, number]> = [];
  for (const orgs of ORG_FOLDERS) {
    let names: string[];
    try {
      names = readdirSync(join(folder, orgs));
    } catch {
      continue;
    }
    for (const name of names.filter((n) => ORG_ID.test(n))) {
      try {
        const stats = statSync(join(folder, orgs, name));
        if (stats.isDirectory()) found.push([name, stats.mtimeMs]);
      } catch {
        // Removed while we looked.
      }
    }
  }
  return found;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonBlank = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
