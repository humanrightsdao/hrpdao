// Preloaded (node --import) for DOM tests. jsdom is an OPTIONAL dev tool:
//   npm i -D jsdom   (or: npm i --no-save jsdom)
// Without it, DOM tests report themselves as skipped.
let JSDOM = null;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  globalThis.__NO_DOM__ = true;
}
if (JSDOM) {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  for (const k of ["navigator", "HTMLElement", "Node", "MouseEvent", "Event", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage"]) {
    try {
      Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
    } catch {
      /* ignore */
    }
  }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Several modules print informational lines prefixed with emoji (🛡️/⚠️/✅/🔍…)
// for real-world debugging. Node's test runner reads the SAME stdout stream to
// carry its own TAP/JSON protocol between child and parent; a burst of
// multi-byte unicode output can occasionally corrupt a frame boundary
// ("Unable to deserialize cloned data..."). Since the tests assert on return
// values, not on console output, these informational lines are muted here.
for (const level of ["log", "info", "warn"]) {
  const real = console[level].bind(console);
  console[level] = (...args) => {
    if (/^[\u{1F300}-\u{1FAFF}\u2190-\u2BFF]/u.test(String(args[0]))) return;
    real(...args);
  };
}
