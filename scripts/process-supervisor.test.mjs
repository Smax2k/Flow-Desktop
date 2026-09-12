import assert from "node:assert/strict";
import test from "node:test";
import { startManagedCommand } from "./process-supervisor.mjs";

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test("terminate stops the managed process and its descendants", {
  skip: process.platform === "win32",
}, async (context) => {
  let descendantPid;
  const script = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `;
  const command = startManagedCommand(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
    terminationGraceMs: 500,
  });

  context.after(() => {
    if (processExists(command.child.pid)) {
      process.kill(-command.child.pid, "SIGKILL");
    }
  });

  descendantPid = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Le descendant n’a pas démarré.")), 2_000);
    command.child.stdout.once("data", (data) => {
      clearTimeout(timeout);
      resolve(Number.parseInt(data.toString().trim(), 10));
    });
  });

  assert.equal(processExists(command.child.pid), true);
  assert.equal(processExists(descendantPid), true);
  await command.terminate();
  assert.equal(processExists(command.child.pid), false);
  assert.equal(processExists(descendantPid), false);
});
