import { useCallback } from "react";
import { nostrPool, DEFAULT_RELAYS } from "../lib/nostrRelay";

/**
 * Thin wrapper around the shared nostrPool (see lib/nostrRelay.js) for
 * publishing already-signed events and subscribing to live feeds.
 * Deliberately does NOT handle signing — pass in events already
 * produced by useNostrIdentity's signEvent(), keeping "who signs" and
 * "where it gets sent" as separate concerns.
 */
export function useNostrRelay(relays = DEFAULT_RELAYS) {
  /**
   * Publishes an already-signed event to all configured relays.
   * pool.publish() returns one Promise per relay (each resolving with
   * that relay's response, or rejecting if that specific relay
   * refused/failed) — Promise.allSettled so one bad relay doesn't
   * throw away results from the others.
   * @param {import('nostr-tools').Event} event
   * @returns {Promise<{url: string, ok: boolean, reason?: string}[]>}
   */
  const publishToNostr = useCallback(
    async (event) => {
      const publishPromises = nostrPool.publish(relays, event);
      const settled = await Promise.allSettled(publishPromises);
      return settled.map((result, i) => ({
        url: relays[i],
        ok: result.status === "fulfilled",
        reason: result.status === "rejected" ? String(result.reason) : undefined,
      }));
    },
    [relays],
  );

  /**
   * Subscribes to a live feed matching the given filter (see
   * nostr-tools' Filter type — e.g. { kinds: [1], authors: [pubkeyHex],
   * limit: 20 }). Calls onEvent for each event received (past matches
   * on connect, then live as new ones arrive). Returns a cleanup
   * function — call it (e.g. in a useEffect's return) to close the
   * subscription.
   * @param {import('nostr-tools').Filter} filter
   * @param {(event: import('nostr-tools').Event) => void} onEvent
   * @returns {() => void} unsubscribe
   */
  const subscribeToNostr = useCallback(
    (filter, onEvent) => {
      const sub = nostrPool.subscribeMany(relays, filter, {
        onevent: onEvent,
      });
      return () => sub.close();
    },
    [relays],
  );

  /**
   * One-shot fetch — resolves once with whatever each relay currently
   * has matching the filter (does not stay open for live updates).
   * Useful for "load the last N posts" without managing a live
   * subscription's lifecycle.
   * @param {import('nostr-tools').Filter} filter
   */
  const queryNostr = useCallback(
    async (filter) => {
      return nostrPool.querySync(relays, filter);
    },
    [relays],
  );

  return { publishToNostr, subscribeToNostr, queryNostr, relays };
}

export default useNostrRelay;
