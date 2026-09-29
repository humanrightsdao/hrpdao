// index.test.js — runs the REAL Express server as a child process with a fake
// Gemini (test/fake-gemini.mjs) and talks to it over HTTP.
//   npm test        (runs moderation.test.js and this file)

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

let child;
let base;

function start(env = {}) {
  const port = 39000 + Math.floor(Math.random() * 900);
  const proc = spawn(process.execPath, ["--import", "./test/fake-gemini.mjs", "index.js"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), GEMINI_API_KEY: "chat-key", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 8000);
    proc.stdout.on("data", (d) => {
      if (String(d).includes("running")) {
        clearTimeout(timer);
        resolve({ proc, base: `http://localhost:${port}` });
      }
    });
    proc.on("exit", (code) => reject(new Error(`server exited early (${code})`)));
  });
}

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let imgSeq = 0;
const image = (id = "0") => ({ id, kind: "image", parts: [{ mime: "image/png", data: PNG_1PX.slice(0, -4) + String(++imgSeq).padStart(4, "0") }] });

before(async () => {
  ({ proc: child, base } = await start({ GEMINI_MODERATION_API_KEY: "mod-key" }));
});
after(() => child?.kill());

test("POST /api/moderate: verdicts, ids, dedicated key, no-store", async () => {
  const res = await post(
    "/api/moderate",
    { items: [{ id: "a", kind: "comment", text: "They detained my brother without a warrant." }, { id: "b", kind: "comment", text: "HATEFUL words" }] },
    { Origin: "http://localhost:5174" },
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const data = await res.json();
  assert.deepEqual(data.results.map((r) => [r.id, r.verdict]), [["a", "allow"], ["b", "block"]]);
  assert.match(data.results[1].reason, /key=mod-key/); // moderation key, not the chat key
});

test("rules answer without Gemini", async () => {
  const res = await post("/api/moderate", { text: "send your seed phrase to claim the prize" });
  const data = await res.json();
  assert.equal(data.results[0].source, "rules");
  assert.equal(data.results[0].verdict, "block");
});

test("foreign Origin → 403; Vite dev origins are allowed", async () => {
  assert.equal((await post("/api/moderate", { text: "hello there" }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/api/moderate", { text: "hello there" }, { Origin: "http://localhost:5173" })).status, 200);
});

test("validation errors", async () => {
  assert.equal((await post("/api/moderate", {})).status, 400);
  assert.equal((await post("/api/moderate", { items: Array.from({ length: 21 }, () => ({ text: "x" })) })).status, 413);
});

test("rate limit: 240 items/min per IP → 429 + Retry-After", async () => {
  const items = Array.from({ length: 20 }, () => ({ text: "send your seed phrase to claim" }));
  let last;
  let ok = 0;
  for (let i = 0; i < 14; i++) {
    last = await post("/api/moderate", { items });
    if (last.status === 200) ok++;
  }
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("retry-after")) >= 1);
  assert.ok(ok >= 1 && ok <= 12);
});

test("/api/health exposes moderation status without secrets", async () => {
  const text = await (await fetch(base + "/api/health")).text();
  const data = JSON.parse(text);
  assert.equal(data.moderation.enabled, true);
  assert.equal(data.moderation.configured, true);
  assert.doesNotMatch(text, /mod-key|chat-key/);
});

test("existing chat endpoint still works (no regression)", async () => {
  const res = await post("/api/chat", { message: "What is Article 3 ECHR?" });
  const data = await res.json();
  assert.equal(data.success, true);
  assert.match(data.message, /Chat answer from fake Gemini/);
  assert.match(data.message, /From Atticus, AI Advisor/);
});

test("MODERATION_ENABLED=false kill switch", async () => {
  const { proc, base: b } = await start({ MODERATION_ENABLED: "false" });
  try {
    const res = await fetch(b + "/api/moderate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "send your seed phrase" }) });
    const data = await res.json();
    assert.equal(data.disabled, true);
    assert.deepEqual(data.results, []);
  } finally {
    proc.kill();
  }
});


test("POST /api/moderate/media: image analysed with the media prompt", async () => {
  const res = await post("/api/moderate/media", { items: [image("img1")] }, { Origin: "http://localhost:5174" });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.results[0].id, "img1");
  assert.equal(data.results[0].verdict, "allow");
});

test("media: a disguised file is blocked without calling Gemini", async () => {
  const disguised = { id: "x", kind: "image", parts: [{ mime: "image/png", data: Buffer.from("not really a png").toString("base64") }] };
  const res = await post("/api/moderate/media", { items: [disguised] });
  const data = await res.json();
  assert.equal(data.results[0].verdict, "block");
  assert.equal(data.results[0].source, "rules");
});

test("media: validation and origin checks", async () => {
  assert.equal((await post("/api/moderate/media", {})).status, 400);
  assert.equal((await post("/api/moderate/media", { items: [image()] }, { Origin: "https://evil.example" })).status, 403);
});

test("/api/health reports media availability", async () => {
  const data = await (await fetch(base + "/api/health")).json();
  assert.equal(data.moderation.media, true);
});
