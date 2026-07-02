// Seeds the Azure Functions runtime keys that `func start` requires into
// `rayfin/functions/local.settings.json`. That file is gitignored (it may also
// hold Rayfin deployment identifiers), so a fresh clone won't have it — and the
// Rayfin CLI's `dev functions apply` writes deployment values without the worker
// runtime, leaving `func start` to fail with "Worker runtime cannot be 'None'".
//
// Runs as the `prebuild` hook, so `npm run build` (which `rayfin dev functions
// apply` invokes) always leaves the runtime keys in place. It only ADDS missing
// keys — existing deployment values are preserved untouched. It deliberately
// does NOT shell out to the `rayfin` CLI, so it's safe in any build environment.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const file = join(dirname(fileURLToPath(import.meta.url)), "..", "local.settings.json");

const REQUIRED = {
  FUNCTIONS_WORKER_RUNTIME: "node",
  AzureWebJobsStorage: "UseDevelopmentStorage=true",
};

const isObjectRecord = (value) => value != null && typeof value === "object" && !Array.isArray(value);

let settings = { IsEncrypted: false, Values: {} };
if (existsSync(file)) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    settings = isObjectRecord(parsed) ? parsed : settings;
    if (!isObjectRecord(settings.Values)) settings.Values = {};
  } catch {
    // Corrupt/unreadable — start from a clean default rather than crashing the build.
    settings = { IsEncrypted: false, Values: {} };
  }
}

let changed = !existsSync(file);
for (const [key, value] of Object.entries(REQUIRED)) {
  if (settings.Values[key] === undefined) {
    settings.Values[key] = value;
    changed = true;
  }
}

if (changed) {
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  console.log("[ensure-local-settings] seeded Azure Functions runtime keys into local.settings.json");
}
