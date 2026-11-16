/**
 * Apify Actor entry: Prelaunch launch-readiness scan, charged per scan
 * (pay per event). Logic lives in core.ts and scanners.ts; this file only
 * wires in the Apify SDK.
 */

import "./env.ts"; // must stay first: sets up env before lib/ loads
import { Actor, log } from "apify";
import { ActorInputError, parseInput, runActor, statusMessage } from "./core.ts";
import { makeScanner } from "./scanners.ts";

await Actor.init();

let opts;
try {
  opts = parseInput(await Actor.getInput());
} catch (err) {
  if (err instanceof ActorInputError) {
    await Actor.fail(`Invalid input: ${err.message}`);
  }
  throw err;
}

const charging = Actor.getChargingManager();
const kv = await Actor.openKeyValueStore();

log.info(`Prelaunch ${opts.scanType} scan of ${opts.urls.length} site(s)`);

const summary = await runActor(opts, {
  scan: makeScanner(async (key, jpeg) => {
    await kv.setValue(key, jpeg, { contentType: "image/jpeg" });
    return kv.getPublicUrl(key);
  }),
  pushData: (item) => Actor.pushData(item),
  charge: (eventName) => Actor.charge({ eventName }),
  remaining: (eventName) => charging.calculateMaxEventChargeCountWithinLimit(eventName),
  log,
});

await Actor.setValue("OUTPUT", summary);
const message = statusMessage(summary);
if (summary.scanned === 0 && summary.errors > 0 && summary.notScannedBudget.length === 0) {
  // Nothing could be scanned at all: mark the run failed so callers notice.
  await Actor.fail(message);
}
await Actor.exit(message);
