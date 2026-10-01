// Preloaded (node --import) for client tests. No DOM needed here (these
// tests exercise lib/aiModeration.js's fetch/localStorage-based logic, not
// React components) — a minimal localStorage polyfill is enough.
const store = new Map();
if (typeof globalThis.localStorage === "undefined") {
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

// Several modules print informational lines prefixed with emoji (🛡️/⚠️/✅/🔍…).
// Node's test runner reads the SAME stdout stream for its own protocol, and a
// burst of multi-byte unicode output can occasionally corrupt a frame
// boundary — see dossier's tests/client/setup-dom.mjs for the same fix.
for (const level of ["log", "info", "warn"]) {
  const real = console[level].bind(console);
  console[level] = (...args) => {
    if (/^[\u{1F300}-\u{1FAFF}\u2190-\u2BFF]/u.test(String(args[0]))) return;
    real(...args);
  };
}
