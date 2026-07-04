import { parityExceptions } from './parity/exceptions.ts';
import { laneB } from './parity/lane-b.ts';
import { runScenarioSuite } from './parity/scenarios.ts';
import { loopbackListenSkipReason } from './helpers/listen.ts';

const loopbackSkipReason = await loopbackListenSkipReason();

// Lane B spawns a real `node dist-node/server.mjs` per scenario. Every scenario
// RUNS when loopback listeners are available; sandboxed environments that deny
// `listen(127.0.0.1)` skip this HTTP-only lane before it can hang. Slow
// scenarios (e.g. the provider-500 retry turn) are tolerated by the adapter's
// per-scenario quiesce windows.
runScenarioSuite(laneB, parityExceptions, { skip: loopbackSkipReason });
