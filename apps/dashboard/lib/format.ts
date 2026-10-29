// Import-free so client components can use it too. Times are the server's local timezone.

/** -17.956 → "-$17.96". */
export function usd(n: number): string {
  const abs = Math.abs(n).toFixed(2);
  return `${n < 0 && abs !== '0.00' ? '-' : ''}$${abs}`;
}

/** Signed USD for PnL: "+$1.20" / "-$1.20". */
export const signedUsd = (n: number) => (n > 0 && usd(n) !== '$0.00' ? `+${usd(n)}` : usd(n));

/** 0.123 → "12.3%". */
export const pct = (n: number | null, digits = 1) =>
  n === null ? '—' : `${(n * 100).toFixed(digits)}%`;

/** A value already in percent, signed: 12.3 → "+12.3%". */
export const signedPct = (n: number | null) =>
  n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;

export const short = (s: string) => (s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

/** Token prices span 1e-9..1e3: keep 4 significant digits. */
export const price = (n: number | null) => (n === null ? '—' : `$${n.toPrecision(4)}`);

/** Seconds → "45s", "12m", "3h 05m", "2d 4h". */
export const dur = (s: number) => {
  const v = Math.max(0, Math.round(s));
  if (v < 60) return `${v}s`;
  if (v < 3600) return `${Math.floor(v / 60)}m`;
  if (v < 86_400)
    return `${Math.floor(v / 3600)}h ${String(Math.floor((v % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(v / 86_400)}d ${Math.floor((v % 86_400) / 3600)}h`;
};

export const ago = (t: number | null, now = Date.now()) =>
  t === null ? 'never' : `${dur((now - t) / 1000)} ago`;

const p2 = (n: number) => String(n).padStart(2, '0');

/** Local "YYYY-MM-DD". */
export const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};

/** Local "MM-DD HH:MM" (with ":SS" when asked). */
export const clock = (t: number, seconds = false) => {
  const d = new Date(t);
  const s = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return seconds ? `${s}:${p2(d.getSeconds())}` : s;
};

/** Local midnight of the day containing `now`, `back` days earlier. */
export const localDayStart = (now: number, back = 0) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return d.getTime();
};

/** "UTC+3" for labels. */
export const tzLabel = (now = Date.now()) => {
  const m = -new Date(now).getTimezoneOffset();
  const h = Math.trunc(Math.abs(m) / 60);
  const rest = Math.abs(m) % 60;
  return `UTC${m < 0 ? '−' : '+'}${h}${rest ? `:${p2(rest)}` : ''}`;
};

/** Stale when older than the limit; an unknown age or limit also reads as stale (fail closed). */
export const stale = (ageMs: number | null, limitMs: number | null) =>
  ageMs === null || limitMs === null || ageMs > limitMs;
