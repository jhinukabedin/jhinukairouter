// SSRF guard for custom provider base URLs (CONTRACT.md security rules).
// Rejects localhost / private ranges / link-local / metadata addresses
// unless the admin explicitly allows local providers (SystemSetting
// allowLocalProviders=true). Never log the URL's credentials, if any.

export interface BaseUrlCheck {
  ok: boolean;
  reason?: string;
}

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

function isPrivateOrReservedIp(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]' || h === '0.0.0.0') return true;
  if (h.endsWith('.localhost')) return true;
  const o = ipv4Octets(h);
  if (!o) return false;
  const a = o[0];
  const b = o[1];
  if (a === undefined || b === undefined) return false;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 0) return true;
  return false;
}

/**
 * Validate a custom provider base URL. Only http/https, no embedded
 * credentials, no private/loopback/link-local host unless allowLocal.
 * DNS rebinding is out of scope for Phase 1 (no DNS resolution here);
 * the gateway only ever fetches the validated base URL host.
 */
export function validateBaseUrl(raw: string, allowLocal = false): BaseUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'baseUrl is not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'baseUrl must use http or https' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'baseUrl must not embed credentials' };
  }
  if (!url.hostname) {
    return { ok: false, reason: 'baseUrl must have a host' };
  }
  if (!allowLocal && isPrivateOrReservedIp(url.hostname)) {
    return {
      ok: false,
      reason: `baseUrl host ${url.hostname} is localhost/private/link-local; set allowLocalProviders=true to allow it`,
    };
  }
  return { ok: true };
}
