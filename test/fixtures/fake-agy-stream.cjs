const { createInterface } = require("node:readline");
const input = createInterface({ input: process.stdin });
input.on("line", () => {
  process.stdout.write(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "fake CLI answer" } }) + "\n");
  process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }) + "\n");
});
