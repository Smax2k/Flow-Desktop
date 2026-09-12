import { watch } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startManagedCommand } from "./process-supervisor.mjs";

export const WEB_SERVICE_HOST = "127.0.0.1";
export const WEB_SERVICE_PORT = 4178;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const typescriptRoot = dirname(require.resolve("typescript/package.json"));
const viteRoot = dirname(require.resolve("vite/package.json"));
const tsc = join(typescriptRoot, "bin", "tsc");
const vite = join(viteRoot, "bin", "vite.js");
const watchedPaths = [
  "src",
  "public",
  "index.html",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsconfig.app.json",
  "vite.config.ts",
];

let activeCommand = null;
let preview = null;
let rebuildTimer = null;
let rebuildRequested = false;
let rebuilding = false;
let shuttingDown = false;
const watchers = [];

function ensurePortIsAvailable() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Le port ${WEB_SERVICE_PORT} est déjà utilisé.`));
        return;
      }
      reject(error);
    });
    probe.listen(WEB_SERVICE_PORT, WEB_SERVICE_HOST, () => {
      probe.close(resolve);
    });
  });
}

async function runBuildCommand(script, argumentsList) {
  activeCommand = startManagedCommand(process.execPath, [script, ...argumentsList], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  const result = await activeCommand.completion;
  activeCommand = null;
  if (result.status !== 0) {
    throw new Error(`La commande de build s’est terminée avec le code ${result.status ?? "inconnu"}.`);
  }
}

async function build() {
  console.log("\n[Flow Web] Vérification TypeScript…");
  await runBuildCommand(tsc, []);
  console.log("[Flow Web] Construction de la build de production…");
  await runBuildCommand(vite, ["build"]);
}

async function startPreview() {
  preview = startManagedCommand(
    process.execPath,
    [
      vite,
      "preview",
      "--host",
      WEB_SERVICE_HOST,
      "--port",
      String(WEB_SERVICE_PORT),
      "--strictPort",
    ],
    {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    },
  );
  preview.completion.then(({ status }) => {
    if (!shuttingDown && preview && status !== 0) {
      console.error(`[Flow Web] Le serveur s’est arrêté avec le code ${status ?? "inconnu"}.`);
    }
  }).catch((error) => {
    if (!shuttingDown) console.error(`[Flow Web] ${error.message}`);
  });
}

async function restartPreview() {
  if (preview) {
    const currentPreview = preview;
    preview = null;
    await currentPreview.terminate();
  }
  if (!shuttingDown) await startPreview();
}

async function rebuild() {
  if (rebuilding || shuttingDown) {
    rebuildRequested = true;
    return;
  }

  rebuilding = true;
  do {
    rebuildRequested = false;
    try {
      await build();
      await restartPreview();
      console.log(`[Flow Web] Disponible sur http://${WEB_SERVICE_HOST}:${WEB_SERVICE_PORT}`);
    } catch (error) {
      if (!shuttingDown) {
        console.error(`[Flow Web] Build échoué : ${error.message}`);
        if (!preview) process.exitCode = 1;
      }
    }
  } while (rebuildRequested && !shuttingDown);
  rebuilding = false;
}

function scheduleRebuild() {
  if (shuttingDown) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    console.log("\n[Flow Web] Modification détectée, reconstruction…");
    void rebuild();
  }, 250);
}

function startWatchers() {
  for (const relativePath of watchedPaths) {
    const target = join(root, relativePath);
    try {
      watchers.push(watch(target, { recursive: true }, scheduleRebuild));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(rebuildTimer);
  for (const watcher of watchers) watcher.close();

  const tasks = [];
  if (activeCommand) tasks.push(activeCommand.terminate());
  if (preview) tasks.push(preview.terminate());
  await Promise.allSettled(tasks);
  console.log(`[Flow Web] Service arrêté (${signal}).`);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

try {
  await ensurePortIsAvailable();
  await build();
  await startPreview();
  startWatchers();
  console.log(`[Flow Web] Disponible sur http://${WEB_SERVICE_HOST}:${WEB_SERVICE_PORT}`);
  console.log("[Flow Web] Ctrl+C arrête le serveur et la surveillance.");
} catch (error) {
  await shutdown("erreur");
  console.error(`[Flow Web] ${error.message}`);
  process.exit(1);
}
