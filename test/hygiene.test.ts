import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Product names from other tools that must never ship in this one. */
const FORBIDDEN = /continuous control|netsuite/i;
const UNSAFE_DOM = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write'];
const URL_PATTERN = /https?:\/\/[^\s"'`<>)]*/g;
const ALLOWED_URL = 'https://taggalong.com/accelerators';
/** An SVG can't render without its namespace; these are names, not links. */
const SVG_NAMESPACES = ['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink'];
/** What people read before installing. They link out freely, but name no other product. */
const DOCS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md'];

/** Lists every file under dir; a folder that doesn't exist yet has no files. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** Scans src/, web/, assets/ and the docs under root and returns one line per rule broken. */
function findViolations(root: string): string[] {
  const problems: string[] = [];
  for (const doc of DOCS.filter((name) => existsSync(join(root, name)))) {
    const forbidden = FORBIDDEN.exec(readFileSync(join(root, doc), 'utf8'));
    if (forbidden) problems.push(`${doc}: contains "${forbidden[0]}"`);
  }
  for (const folder of ['src', 'web', 'assets']) {
    for (const file of walk(join(root, folder))) {
      const rel = relative(root, file).split(sep).join('/');
      const text = readFileSync(file, 'utf8');

      const forbidden = FORBIDDEN.exec(text);
      if (forbidden) problems.push(`${rel}: contains "${forbidden[0]}"`);

      if (rel.startsWith('web/') && rel.endsWith('.js')) {
        for (const api of UNSAFE_DOM) {
          if (text.includes(api)) problems.push(`${rel}: uses ${api}`);
        }
      }

      if (rel.startsWith('web/')) {
        for (const url of text.match(URL_PATTERN) ?? []) {
          const allowed = (rel === 'web/index.html' && url === ALLOWED_URL) || SVG_NAMESPACES.includes(url);
          if (!allowed) problems.push(`${rel}: links to ${url}`);
        }
      }
    }
  }
  return problems;
}

describe('repo hygiene', () => {
  it('ships no other product names, unsafe DOM calls or outside links', () => {
    expect(findViolations(repoRoot)).to.deep.equal([]);
  });

  it('has a README, contributing guide and security policy', () => {
    expect(DOCS.filter((name) => !existsSync(join(repoRoot, name)))).to.deep.equal([]);
  });

  it('catches each rule when a file breaks it', () => {
    const root = mkdtempSync(join(tmpdir(), 'org-launcher-hygiene-'));
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'web'));
      writeFileSync(join(root, 'src', 'sync.ts'), "const target = 'NetSuite';\n");
      writeFileSync(join(root, 'src', 'label.ts'), "const label = 'Continuous Control';\n");
      writeFileSync(join(root, 'README.md'), 'Syncs orders to NetSuite.\n');
      writeFileSync(join(root, 'SECURITY.md'), 'Report issues at https://example.com/report.\n');
      writeFileSync(join(root, 'web', 'app.js'), "el.innerHTML = '<b>x</b>';\n");
      writeFileSync(join(root, 'web', 'index.html'), '<a href="https://taggalong.com/accelerators">by Taggalong</a>\n');
      writeFileSync(join(root, 'web', 'other.html'), '<a href="https://example.com/x">x</a>\n');
      writeFileSync(
        join(root, 'web', 'icon.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a href="https://example.com/y"/></svg>\n'
      );

      expect(findViolations(root)).to.have.members([
        'src/sync.ts: contains "NetSuite"',
        'src/label.ts: contains "Continuous Control"',
        'README.md: contains "NetSuite"',
        'web/app.js: uses innerHTML',
        'web/other.html: links to https://example.com/x',
        'web/icon.svg: links to https://example.com/y',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
