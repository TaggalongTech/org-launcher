// Run as its own process by state.test.ts: adds a tag to ten orgs, one write each.
// Prints "ready", then waits for a "go" file so both workers write at the same moment.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { StateStore } from '../../../src/core/state.js';

const [dir, prefix] = process.argv.slice(2);
const store = new StateStore(dir);
process.stdout.write('ready\n');
while (!existsSync(join(dir, 'go'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
for (let i = 0; i < 10; i++) {
  store.addTags(`00D${prefix}${String(i).padStart(11, '0')}`, [`p${prefix}`]);
}
