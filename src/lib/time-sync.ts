// time-sync.ts: Millisecond wallclock reference helpers
// Note: Host and listener wallclocks are assumed synchronized to millisecond precision.
// Avoid HTTP Date header offsets because HTTP Date truncates to 1-second integer resolution,
// which introduces up to 1000ms artificial skew between tabs on the same machine.

let clockOffsetMs = 0;
let isSynced = false;

export async function syncNetworkTime(): Promise<number> {
  clockOffsetMs = 0;
  isSynced = true;
  return 0;
}

export function getSyncedTime(): number {
  return Date.now() + clockOffsetMs;
}

export function getIsSynced(): boolean {
  return isSynced;
}
