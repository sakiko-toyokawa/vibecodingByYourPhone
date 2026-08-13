import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAINTENANCE_REQUEST_BEGIN,
  MAINTENANCE_REQUEST_END,
  extractMaintenanceRequest,
} from "./maintenance-request.js";

test("extractMaintenanceRequest parses a valid block", () => {
  const report = [
    "finished",
    MAINTENANCE_REQUEST_BEGIN,
    JSON.stringify({
      target_type: "generic_webhook",
      external_ref: { source: "ops", subject_id: "deploy-42" },
      wake_policy: { trigger_types: ["deploy_ready"], max_repairs: 5 },
      context_payload: { allowed_commands: ["npm test"] },
    }),
    MAINTENANCE_REQUEST_END,
  ].join("\n");
  const request = extractMaintenanceRequest(report);
  assert.ok(request);
  assert.equal(request?.target_type, "generic_webhook");
  assert.deepEqual(request?.wake_policy, {
    trigger_types: ["deploy_ready"],
    max_repairs: 5,
  });
});

test("extractMaintenanceRequest rejects invalid blocks", () => {
  assert.equal(extractMaintenanceRequest("no markers"), null);
  assert.equal(
    extractMaintenanceRequest(
      `${MAINTENANCE_REQUEST_BEGIN}\n{"target_type":"x"}\n${MAINTENANCE_REQUEST_END}`,
    ),
    null,
  );
  assert.equal(
    extractMaintenanceRequest(
      `${MAINTENANCE_REQUEST_BEGIN}\n{"target_type":"x","external_ref":{"source":"ops","subject_id":"1"},"wake_policy":{"trigger_types":[]},"context_payload":{}}\n${MAINTENANCE_REQUEST_END}`,
    ),
    null,
  );
});
