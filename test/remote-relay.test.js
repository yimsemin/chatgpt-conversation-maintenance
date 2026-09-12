import assert from "node:assert/strict";
import test from "node:test";

import { APP_RELEASE, RELAY_PROTOCOL_VERSION } from "../app-version.js";
import { validateRelayVersion } from "../remote-relay.js";

test("relay connection accepts only the current release and protocol", () => {
  assert.doesNotThrow(() => validateRelayVersion(APP_RELEASE, RELAY_PROTOCOL_VERSION));
  assert.throws(() => validateRelayVersion("old-release", RELAY_PROTOCOL_VERSION), /version mismatch/);
  assert.throws(() => validateRelayVersion(APP_RELEASE, RELAY_PROTOCOL_VERSION - 1), /version mismatch/);
});
