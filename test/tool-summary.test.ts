import test from "node:test";
import assert from "node:assert/strict";
import {
  namedCallSummary,
  jobResultSummary,
} from "../src/rendering/tool-summary.js";
import { foldRun, initialRun } from "../src/projection/run-projection.js";

test("plugin actions and jobs show useful selected arguments without arbitrary payloads", () => {
  assert.equal(
    namedCallSummary("functions.plugin_manager", {
      action: "install_bundle",
      target: "plugin@1",
      token: "PRIVATE",
    }),
    "install bundle · plugin@1",
  );
  assert.equal(
    namedCallSummary("job_output", '{"job_id":"bash-123","wait":true}'),
    "bash-123",
  );
  assert.equal(
    jobResultSummary(
      "job_output",
      "first\nTests passed\n[exit code: 0]\n[status: completed]",
      "bash-123",
    ),
    "bash-123 · completed · exit 0 · Tests passed",
  );
  assert.equal(
    jobResultSummary(
      "job_output",
      '{"status":"running","output":"one\\ntwo","internal":"PRIVATE"}',
      "j",
    ),
    "j · running · two",
  );
  assert.equal(jobResultSummary("read", "PRIVATE", "path"), undefined);
  assert.ok(
    jobResultSummary("job_output", "x".repeat(10000), "j")!.length < 150,
  );
});

test("job result enriches only its matching log entry summary", () => {
  let state = foldRun(initialRun(), {
    type: "tool/call",
    time: 1,
    data: {
      callId: "j",
      name: "job_output",
      arguments: { job_id: "bash-123" },
    },
  });
  assert.equal(state.toolLog[0]?.summary, "bash-123");
  state = foldRun(state, {
    type: "tool/result",
    time: 2,
    data: {
      message: {
        toolCallId: "j",
        content: [{ type: "text", text: "Tests passed\n[status: completed]" }],
      },
    },
  });
  assert.equal(
    state.toolLog[0]?.summary,
    "bash-123 · completed · Tests passed",
  );
  assert.equal(state.tools, 1);
});
