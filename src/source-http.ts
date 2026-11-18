/** Read small public documents without accepting redirects outside the caller's allowlist. */
export async function readPublicSource(url: string, fetcher: typeof fetch, options: {
  allowed: (url: string) => boolean;
  maxBytes: number;
  redirects?: number;
  /** Only feed readers may accept a prefix and ignore the last incomplete entry. */
  prefix?: boolean;
}): Promise<string | null> {
  const signal = AbortSignal.timeout(5000);
  try {
    for (let hop = 0; hop <= (options.redirects ?? 0); hop++) {
      if (!options.allowed(url)) return null;
      const response = await fetcher(url, { redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status) && hop < (options.redirects ?? 0)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) return null;
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok || !response.body || (!options.prefix && Number(response.headers.get('content-length')) > options.maxBytes)) {
        await response.body?.cancel();
        return null;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parts: string[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const left = options.maxBytes - size;
          if (value.length > left) {
            await reader.cancel();
            if (!options.prefix) return null;
            parts.push(decoder.decode(value.subarray(0, left), { stream: true }), decoder.decode());
            return parts.join('');
          }
          size += value.length;
          parts.push(decoder.decode(value, { stream: true }));
        }
        parts.push(decoder.decode());
        return parts.join('');
      } finally {
        reader.releaseLock();
      }
    }
  } catch { /* A source failure skips the item. */ }
  return null;
}
