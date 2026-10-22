// Small fetch helpers shared by the Qloo, LLM and image clients.
export class UpstreamError extends Error {
  constructor(message, status = 502, details) { super(message); this.status = status; this.details = details; }
}

// Never let a credential leak into an error payload that reaches the browser.
export function redact(value, secrets) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length > 6)) text = text.split(secret).join('[redacted]');
  return typeof value === 'string' ? text : JSON.parse(text);
}

export async function fetchJson(fetcher, url, options, { label, secrets = [], timeout = 30000 } = {}) {
  let response;
  try { response = await fetcher(url, { ...options, signal: AbortSignal.timeout(timeout), redirect: 'error' }); }
  catch (error) { throw new UpstreamError(`${label} could not be reached (${error.name === 'TimeoutError' ? 'timed out' : 'network error'}).`); }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new UpstreamError(`${label} returned a non-JSON response (HTTP ${response.status}).`, 502, redact(text.slice(0, 500), secrets)); }
  if (!response.ok || data?.success === false) {
    const hint = response.status === 401 || response.status === 403 ? ' Check the API key.' : response.status === 429 ? ' Rate limit reached; wait a moment.' : '';
    throw new UpstreamError(`${label} returned HTTP ${response.status}.${hint}`, response.ok ? 502 : response.status, redact(data, secrets));
  }
  return data;
}
