import test from "node:test";
import assert from "node:assert/strict";
import { parseOptions, planCapacity, TARGET } from "../scripts/configure-warm-capacity.mjs";

const functions = ["ApiFunction", "StateFunction"].map(logicalId => ({ logicalId, functionName: `${TARGET.stack}-${logicalId}-example`, alias: "live", memoryMB: 1024, provisioned: 0 }));

test("warm capacity stays a dry run unless apply is supplied and rejects inverted limits", () => {
  assert.deepEqual(parseOptions([]), { apply: false, enabled: true, min: 1, max: 2 });
  assert.equal(parseOptions(["--disable"]).enabled, false);
  assert.equal(parseOptions(["--apply", "--min", "2", "--max", "5"]).apply, true);
  for (const args of [["--min", "0"], ["--max", "1.5"], ["--min", "3", "--max", "2"], ["--max"], ["--unknown"]]) assert.throws(() => parseOptions(args));
});

test("capacity planning blocks reduced quotas, preserves unrelated allocations and quotes both aliases", () => {
  const options = parseOptions([]);
  assert.equal(planCapacity(options, 10, functions).quota.ready, false);
  const ready = planCapacity(options, 1000, functions);
  assert.equal(ready.quota.ready, true);
  assert.equal(ready.warmCapacityOnlyUSD.minimum30days, 18.66);
  assert.equal(ready.warmCapacityOnlyUSD.maximum30days, 37.31);
  assert.equal(planCapacity(options, 1000, functions, 900).quota.ready, false);
  assert.equal(planCapacity(options, 1000, functions.map(item => ({ ...item, provisioned: 2 })), 900).quota.ready, true);
  assert.equal(planCapacity(parseOptions(["--disable"]), 10, functions).quota.ready, true);
  assert.throws(() => planCapacity(options, 1000, functions.map(item => ({ ...item, alias: "$LATEST" }))));
});
