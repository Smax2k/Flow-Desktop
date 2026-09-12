import { spawn, spawnSync } from "node:child_process";

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function signalProcessTree(child, signal) {
  if (!child.pid || !isRunning(child)) return;

  try {
    if (process.platform === "win32") {
      const argumentsList = ["/pid", String(child.pid), "/t"];
      if (signal === "SIGKILL") argumentsList.push("/f");
      spawnSync("taskkill", argumentsList, { stdio: "ignore" });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export function startManagedCommand(command, argumentsList, options = {}) {
  const {
    terminationGraceMs = 3_000,
    ...spawnOptions
  } = options;
  const child = spawn(command, argumentsList, {
    ...spawnOptions,
    detached: process.platform !== "win32",
    shell: false,
  });

  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });

  async function terminate() {
    if (!isRunning(child)) return completion;

    signalProcessTree(child, "SIGTERM");
    const stoppedNormally = await Promise.race([
      completion.then(() => true, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), terminationGraceMs)),
    ]);

    if (!stoppedNormally && isRunning(child)) {
      signalProcessTree(child, "SIGKILL");
    }

    return completion;
  }

  return { child, completion, terminate };
}
