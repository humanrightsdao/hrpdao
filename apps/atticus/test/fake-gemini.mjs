// test/fake-gemini.mjs — preloaded with `node --import` by index.test.js.
// Replaces global fetch for Google's API so the real server runs offline.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (!String(url).includes("generativelanguage.googleapis.com")) return realFetch(url, options);
  const body = JSON.parse(options.body);
  const prompt = body.contents[0].parts[0].text;
  const key = options.headers["x-goog-api-key"];
  let text;
  if (prompt.includes("ITEMS TO CLASSIFY")) {
    const ids = [...prompt.matchAll(/<item id="(\d+)"[^>]*>\n?(?:<context>[\s\S]*?<\/context>\n?)?<text>([\s\S]*?)<\/text>/g)];
    text = JSON.stringify({
      results: ids.map((m) => ({
        id: m[1],
        severity: /HATEFUL/.test(m[2]) ? 2 : 0,
        confidence: 0.95,
        categories: /HATEFUL/.test(m[2]) ? ["hate_speech"] : [],
        reason: `key=${key}`,
      })),
    });
  } else {
    text = "Chat answer from fake Gemini";
  }
  return new Response(
    JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] }),
    { status: 200 },
  );
};
