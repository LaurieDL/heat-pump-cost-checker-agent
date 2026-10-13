// Loads core/heat-pump-core.js in Node.
//
// heat-pump-core.js is a byte-for-byte copy of the file fidesq.com serves at
// /assets/js/heat-pump-core.js (generated there from heat-pump-plugin/src/core).
// It is a classic browser script that declares `var HeatPumpCore`, so we wrap
// it in a function that returns that value rather than editing the file. (It is
// our own vendored file, not user input.) To update the figures, copy the new
// file over it unchanged.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CORE_PATH = fileURLToPath(new URL('./heat-pump-core.js', import.meta.url));

export function loadCore() {
  const source = readFileSync(CORE_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  const core = new Function(`${source}\n;return HeatPumpCore;`)();
  if (!core || typeof core.estimate !== 'function') throw new Error('heat-pump-core.js did not define HeatPumpCore.estimate');
  return core;
}
