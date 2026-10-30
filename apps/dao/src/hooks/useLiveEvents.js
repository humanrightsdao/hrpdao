// src/hooks/useLiveEvents.js
//
// Loads external feed events (GDACS …) from the Worker's /api/events and
// refreshes them in the background. Failures are silent by design: the map
// must keep working when a feed is down — and in `vite dev` there is no
// Worker, so the request simply fails and the layer stays empty.

import { useState, useEffect, useCallback, useRef } from "react";

const useLiveEvents = ({
  refreshIntervalMs = 5 * 60 * 1000,
  url = "/api/events",
} = {}) => {
  const [events, setEvents] = useState([]);
  const [sources, setSources] = useState({});
  const lastLoadRef = useRef(0);

  const load = useCallback(async (signal) => {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data?.events)) throw new Error("unexpected response");
      setEvents(data.events);
      setSources(data.sources || {});
      lastLoadRef.current = Date.now();
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.warn("Live events unavailable:", err?.message || err);
      }
    }
  }, [url]);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal);

    const tick = () => {
      if (!document.hidden) load(controller.signal);
    };
    const onVisibility = () => {
      if (
        !document.hidden &&
        Date.now() - lastLoadRef.current >= refreshIntervalMs / 2
      ) {
        load(controller.signal);
      }
    };

    const id = setInterval(tick, refreshIntervalMs);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, refreshIntervalMs]);

  return { events, sources };
};

export default useLiveEvents;
