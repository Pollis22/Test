export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data as { message?: string }).message ?? (data as { error?: string }).error ?? `HTTP ${res.status}`);
    (err as Error & { code?: string; status?: number }).code = (data as { error?: string }).error;
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return data as T;
}

export function money(cents: number, currency = 'usd'): string {
  const symbol = currency === 'usd' ? '$' : '';
  return `${symbol}${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export function fmtLocal(iso: string, timezone: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...opts,
  }).format(new Date(iso));
}

export function fmtTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}
