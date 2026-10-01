// Stub for lib/nostrLookup.js so pure moderation/gate logic can be
// unit-tested offline, without touching real relays.
export const RELAYS = ["wss://stub.invalid"];
export const pool = {
  querySync: async () => (globalThis.__querySync ? globalThis.__querySync() : []),
};
export const publishEvent = async (signed) =>
  globalThis.__publishEvent ? globalThis.__publishEvent(signed) : { ok: true };
