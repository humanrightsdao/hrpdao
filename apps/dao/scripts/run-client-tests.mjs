// scripts/run-client-tests.mjs — ported from dossier's version.
// Bundles tests/client/*.test.jsx with esbuild (a Vite transitive dependency,
// already installed), stubbing Nostr, and runs them with the Node test runner.
//   node scripts/run-client-tests.mjs
import { build } from "esbuild";
import { readdirSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "tests/client");
const outDir = path.join(root, "node_modules/.cache/client-tests");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const nostrStub = path.join(testsDir, "stubs/nostr.mjs");
const stubPlugin = {
  name: "stub-modules",
  setup(b) {
    b.onResolve({ filter: /\/lib\/nostrLookup(\.js)?$/ }, () => ({ path: nostrStub }));
  },
};

const files = readdirSync(testsDir).filter((f) => f.endsWith(".test.jsx"));
const outputs = [];
for (const f of files) {
  const outfile = path.join(outDir, f.replace(/\.jsx$/, ".mjs"));
  await build({
    entryPoints: [path.join(testsDir, f)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    logLevel: "error",
    external: ["node:*"],
    define: { "import.meta.env": JSON.stringify({}) },
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    plugins: [stubPlugin],
    nodePaths: [path.join(root, "node_modules")],
  });
  outputs.push(outfile);
}

// --test-force-exit: modules can leave timers running after the last
// assertion; without it the runner would wait for them forever.
const r = spawnSync(
  process.execPath,
  ["--import", path.join(testsDir, "setup.mjs"), "--test", "--test-force-exit", "--test-timeout=60000", ...outputs],
  { stdio: "inherit", cwd: root },
);
process.exit(r.status ?? 1);
