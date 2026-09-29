// scripts/run-client-tests.mjs
// Bundles tests/client/*.test.jsx with esbuild (already a Vite dependency),
// stubbing the Lens SDK, and runs them with the Node test runner.
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

const lensStub = path.join(testsDir, "stubs/lens.mjs");
const mediaPrepStub = path.join(testsDir, "stubs/aiMediaPrep.mjs");
const stubPlugin = {
  name: "stub-modules",
  setup(b) {
    b.onResolve({ filter: /^@lens-protocol\/client(\/actions)?$/ }, () => ({ path: lensStub }));
    b.onResolve({ filter: /\/lib\/lens$/ }, () => ({ path: lensStub }));
    // Real image/video decoding needs Canvas/<video>, unavailable in jsdom —
    // tests control the outcome via globalThis.__prepareMedia (see the stub).
    b.onResolve({ filter: /aiMediaPrep(\.js)?$/ }, () => ({ path: mediaPrepStub }));
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
    external: ["jsdom", "node:*"],
    loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
    // Vite always provides the whole import.meta.env object; mirror that (individual
    // keys such as VITE_AI_MODERATION_MODE are simply absent = production defaults).
    define: { "import.meta.env": JSON.stringify({ VITE_LENS_APP_ADDRESS: "0x40524A13927c95646D2E86bC1A4FA14bE74AfaB5" }) },
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    plugins: [stubPlugin],
    nodePaths: [path.join(root, "node_modules")],
  });
  outputs.push(outfile);
}

// --test-force-exit: React/i18n components can leave timers running after the
// last assertion; without it the runner would wait for them forever.
// --test-timeout: a hung test fails after 60 s instead of blocking CI.
const r = spawnSync(process.execPath, ["--import", path.join(testsDir, "setup-dom.mjs"), "--test", "--test-force-exit", "--test-timeout=60000", ...outputs], {
  stdio: "inherit",
  cwd: root,
});
process.exit(r.status ?? 1);
