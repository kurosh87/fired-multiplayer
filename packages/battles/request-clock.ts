// Exact GBA timing. Persisted credit is in CPU-clock * microsecond units;
// reconnecting or recreating a worker cannot reset the credit allowance.
export const FRAME_CREDIT = 280896n * 1000000n;
const CLOCK_HZ = 16777216n;
export const MAX_REQUEST_CREDIT = FRAME_CREDIT * 75n;
export type RequestClock = { atUs: bigint; credit: bigint };
export function refillRequestClock(previous: RequestClock, nowUs: bigint): RequestClock {
  if (previous.atUs < 0n || previous.credit < 0n || previous.credit > MAX_REQUEST_CREDIT || nowUs < 0n) throw new Error('Invalid durable battle clock.');
  const atUs = nowUs > previous.atUs ? nowUs : previous.atUs;
  const credit = previous.credit + (atUs - previous.atUs) * CLOCK_HZ;
  return { atUs, credit: credit > MAX_REQUEST_CREDIT ? MAX_REQUEST_CREDIT : credit };
}
export function requestClockFrames(clock: RequestClock, limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 60) throw new Error('Invalid battle frame limit.');
  return Math.min(limit, Number(clock.credit / FRAME_CREDIT));
}
export function spendRequestClock(clock: RequestClock, frames: number): RequestClock {
  if (!Number.isSafeInteger(frames) || frames < 0 || frames > 60 || BigInt(frames) * FRAME_CREDIT > clock.credit) throw new Error('Battle clock credit exceeded.');
  return { atUs: clock.atUs, credit: clock.credit - BigInt(frames) * FRAME_CREDIT };
}
