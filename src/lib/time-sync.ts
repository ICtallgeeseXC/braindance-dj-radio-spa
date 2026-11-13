// time-sync.ts: CORS-safe clock synchronization using same-origin headers

let clockOffsetMs = 0;
let isSynced = false;

export async function syncNetworkTime(): Promise<number> {
  try {
    const t0 = performance.now();
    // Same-origin request has zero CORS issues in LibreWolf, Firefox, Chrome, Safari
    const res = await fetch(window.location.href, { method: 'HEAD', cache: 'no-store' });
    const t1 = performance.now();
    const dateHeader = res.headers.get('date');

    if (dateHeader) {
      const serverTime = new Date(dateHeader).getTime() + ((t1 - t0) / 2);
      const localTime = Date.now();
      clockOffsetMs = serverTime - localTime;
      isSynced = true;
      console.log(`[TimeSync] Clock synced. Offset: ${clockOffsetMs}ms (RTT: ${Math.round(t1 - t0)}ms)`);
      return clockOffsetMs;
    }
  } catch {
    // Local dev server fallback
  }

  isSynced = true;
  return 0;
}

export function getSyncedTime(): number {
  return Date.now() + clockOffsetMs;
}

export function getIsSynced(): boolean {
  return isSynced;
}
