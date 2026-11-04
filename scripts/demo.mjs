// Org Launcher's real server and page with made-up orgs: for trying the page and taking the README screenshots.
// Needs `npm run build` first. Usage: node scripts/demo.mjs [port]   (default 4399). Touches no real logins or saved data.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const plugin = fileURLToPath(new URL('..', import.meta.url));
const [port = '4399'] = process.argv.slice(2);
const { Inventory } = await import(join(plugin, 'lib/core/inventory.js'));
const { StateStore } = await import(join(plugin, 'lib/core/state.js'));
const { createServer } = await import(join(plugin, 'lib/server/http.js'));

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const id = (n) => `00D5g00000Demo${String(n).padStart(2, '0')}AA`.slice(0, 18);
const login = (n, username, alias, fields = {}) => ({
  orgId: id(n), username, aliases: alias ? [alias] : [], isScratch: false, isDevHub: false, isSandbox: false,
  instanceUrl: 'https://example.my.salesforce.com', isExpired: false, ...fields,
});
const scratch = (n, username, alias, days, extra = {}) =>
  login(n, username, alias, { isScratch: true, devHubUsername: 'admin@acme-hub.example.com', expirationDate: day(days), ...extra });

const logins = [
  login(1, 'admin@acme-hub.example.com', 'devhub', { isDevHub: true }),
  scratch(2, 'test-q7xk2mbd9r4a@example.com', 'rlm-base__my-lab', 27),
  login(2, 'salesrep@example.org.00d5g00000demo02', null, { isScratch: true }),
  scratch(3, 'test-hb3w8ncy1zpe@example.com', 'feature-billing', 21),
  scratch(4, 'test-m2vz6ktq0lsu@example.com', 'qa-invoices', 2),
  scratch(5, 'test-p9ej4rxa7wgd@example.com', 'spike-pricing', -3),
  login(6, 'admin@acme.example.com.uat', 'acme-uat', { isSandbox: true }),
  login(7, 'admin@acme.example.com', 'acme-prod'),
  login(8, 'me@dev-ed.example.com', 'my-dev-ed'),
];

const pkg = (name, namespace, version) => ({ name, namespace, version });
const answers = {
  'admin@acme-hub.example.com': { orgType: 'Developer Edition', packages: [] },
  'test-q7xk2mbd9r4a@example.com': { orgType: 'Developer Edition', packages: [] },
  'test-hb3w8ncy1zpe@example.com': { orgType: 'Developer Edition', packages: [pkg('Acme Billing', 'acmebill', '2.1.0.4')], unpackagedApex: 38 },
  'test-m2vz6ktq0lsu@example.com': { orgType: 'Developer Edition', packages: [pkg('Acme Billing', 'acmebill', '2.1.0.3')] },
  'admin@acme.example.com.uat': { orgType: 'Enterprise Edition', isSandbox: true, packages: [pkg('Acme Billing', 'acmebill', '2.0.0.9'), pkg('Field Service Tools', 'fstools', '4.0.0.3')] },
  'admin@acme.example.com': { orgType: 'Enterprise Edition', packages: [pkg('Acme Billing', 'acmebill', '2.0.0.9'), pkg('Field Service Tools', 'fstools', '4.0.0.3')] },
  'me@dev-ed.example.com': { orgType: 'Developer Edition', packages: [pkg('Kit Tools', 'kittools', '1.3.0.1')] },
};
const query = async (username) => {
  await new Promise((r) => setTimeout(r, 150));
  const a = answers[username];
  if (!a) throw new Error('expired access/refresh token');
  return { isSandbox: false, unpackagedApex: 0, ...a };
};

const home = mkdtempSync(join(tmpdir(), 'org-launcher-demo-'));
const store = new StateStore(home);
const tags = { 2: ['field-guide'], 3: ['client-a', 'billing'], 4: ['client-a', 'qa'], 5: ['spike'], 6: ['client-a'], 7: ['client-a', 'prod'] };
const notes = { 2: 'Field guide labs', 3: 'Invoice PDF rework', 4: 'Regression run before Friday', 6: 'Release 4.2 testing', 7: "Look, don't touch" };
for (const [n, t] of Object.entries(tags)) store.addTags(id(Number(n)), t);
for (const [n, note] of Object.entries(notes)) store.update(id(Number(n)), { note });

const inventory = new Inventory({
  auth: { listLogins: async () => logins, defaultUsername: async () => null },
  query, store, cacheDir: home,
  projectIndex: () => new Map([[id(3), 'billing-app']]),
});
const server = createServer({
  inventory, store, webDir: join(plugin, 'web'), version: '0.1.2',
  loginUrl: async () => 'about:blank', open: async () => {}, run: async () => ({ code: 0, stdout: '', stderr: '' }),
});
server.listen(Number(port), '127.0.0.1', () => { inventory.startRefresh(); console.log(`demo on http://127.0.0.1:${port}`); });
