import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";

/**
 * Keeps a page's loader data current without a reload
 * (docs/ui-conventions.md § Live pages).
 *
 * While something is happening (`active`) the page re-reads every five
 * seconds; otherwise every thirty, so what changed elsewhere — a scheduled
 * run starting, a count growing, a row someone else dealt with — reaches
 * the page on its own. Nothing is read while the tab is hidden, and the
 * page re-reads the moment it is shown or focused again. A read never
 * overlaps another — unless it has been waiting `STUCK_MS`: a request that
 * never answers (a dropped connection, a session check that hangs) would
 * otherwise stop every later read and freeze the page on its last answer
 * until a reload. A new read replaces it; the router abandons the old one.
 *
 * The revalidator is held in a ref: it is a new object whenever its state
 * changes, and as an effect dependency it would rebuild the timer on
 * every read.
 */
const STUCK_MS = 15_000;

export function useLiveRevalidation({
  active,
  activeEveryMs = 5_000,
  idleEveryMs = 30_000,
}: {
  active: boolean;
  activeEveryMs?: number;
  /** `null` for a page that cannot change once nothing is happening. */
  idleEveryMs?: number | null;
}): void {
  const revalidator = useRevalidator();
  const ref = useRef(revalidator);
  ref.current = revalidator;
  // When the read now in flight started, or null while none is.
  const busySince = useRef<number | null>(null);
  if (revalidator.state === "idle") busySince.current = null;
  else busySince.current ??= Date.now();

  useEffect(() => {
    if (!active && idleEveryMs === null) return;
    const read = () => {
      if (document.visibilityState !== "visible") return;
      const since = busySince.current;
      if (since !== null && Date.now() - since < STUCK_MS) return;
      busySince.current = Date.now();
      void ref.current.revalidate();
    };
    const timer = setInterval(
      read,
      active ? activeEveryMs : (idleEveryMs ?? activeEveryMs),
    );
    const onShown = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onShown);
    window.addEventListener("focus", onShown);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShown);
      window.removeEventListener("focus", onShown);
    };
  }, [active, activeEveryMs, idleEveryMs]);
}

/**
 * A short watch after an action whose effect the next read may not show
 * yet — a run the portal has queued but not listed, a sync that finishes
 * in the background. `watch()` makes it true for `ms`; it clears early
 * once `settled` says the effect is visible.
 */
export function useWatchWindow(
  ms: number,
  settled = false,
): [watching: boolean, watch: () => void] {
  const [until, setUntil] = useState(0);
  useEffect(() => {
    if (until === 0) return;
    if (settled) {
      setUntil(0);
      return;
    }
    const timer = setTimeout(
      () => setUntil(0),
      Math.max(0, until - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [until, settled]);
  return [until > 0, () => setUntil(Date.now() + ms)];
}
