import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';

const webDir = fileURLToPath(new URL('../../web/', import.meta.url));
const read = (file: string): string => readFileSync(`${webDir}${file}`, 'utf8');

const CREDIT = 'https://taggalong.com/accelerators';
/** An SVG can't render without its namespace; these are names, not links. */
const SVG_NAMESPACES = ['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink'];
/** Links with a scheme, and protocol-relative ones in quotes (so comments don't count). */
const URL_PATTERN = /(?:https?:|(?<=["'`(])(?=\/\/))\/\/[^\s"'`<>)]*/g;

describe('web: static page files', () => {
  it('index.html references only same-origin assets', () => {
    const html = read('index.html');
    const refs = [...html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    expect(refs).to.include.members(['/theme.js', '/app.js', '/app.css', '/icon.svg', '/manifest.json']);
    for (const ref of refs) {
      expect(ref, ref).to.match(/^\/[^/]/);
    }
  });

  it('app.js never uses innerHTML and friends', () => {
    const js = read('app.js');
    for (const api of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      expect(js, api).not.to.include(api);
    }
  });

  it('footer credit is the only external link', () => {
    const found: string[] = [];
    for (const file of ['index.html', 'theme.js', 'app.js', 'app.css', 'manifest.json', 'icon.svg']) {
      for (const url of read(file).match(URL_PATTERN) ?? []) {
        if (!SVG_NAMESPACES.includes(url)) found.push(`${file}: ${url}`);
      }
    }
    expect(found).to.deep.equal([`index.html: ${CREDIT}`]);
    const footer = /<footer[\s\S]*<\/footer>/.exec(read('index.html'))?.[0] ?? '';
    expect(footer).to.include(`href="${CREDIT}"`);
  });

  it('theme.js runs before the stylesheet, so a saved theme never flashes the other one', () => {
    const html = read('index.html');
    expect(html.indexOf('src="/theme.js"')).to.be.above(-1).and.below(html.indexOf('href="/app.css"'));
  });

  it('light and dark both come from the same tokens, and a chosen theme beats the system one', () => {
    const css = read('app.css');
    expect(css).to.include(':root[data-theme="dark"]');
    expect(css).to.include('@media (prefers-color-scheme: dark)');
    expect(css).to.include(':root:not([data-theme="light"])');
    expect(css).to.include('src: url("/instrument-sans.woff2")');
  });

  it('manifest name "Org Launcher", icon purpose "any maskable"', () => {
    const manifest = JSON.parse(read('manifest.json')) as {
      name: string;
      theme_color: string;
      icons: Array<{ src: string; purpose: string }>;
    };
    expect(manifest.name).to.equal('Org Launcher');
    expect(manifest.theme_color).to.equal('#0D4651');
    expect(manifest.icons).to.have.length(1);
    expect(manifest.icons[0].src).to.equal('/icon.svg');
    expect(manifest.icons[0].purpose).to.equal('any maskable');
  });
});
