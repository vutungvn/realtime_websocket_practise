/**
 * Gia lap xac thuc: token dang "tok_<driverId>", vd "tok_driver-01".
 * Thuc te: verify JWT trong handshake va lay driverId tu claim `sub`.
 */
export function verifyDriverToken(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const match = /^tok_([a-z0-9-]{1,32})$/.exec(token);
  return match ? match[1] : null;
}

/** Cua so truot: toi da `limit` lan / `windowMs` cho moi key. */
export class ConnectRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: this.windowMs - (now - recent[0]) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { ok: true };
  }
}
