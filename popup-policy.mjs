const CHATGPT_AUTH_HOST_ALLOWLIST = [
  // OpenAI / ChatGPT auth surfaces.
  'chatgpt.com',
  '.chatgpt.com',
  'openai.com',
  '.openai.com',

  // Common SSO providers used by ChatGPT users.
  'accounts.google.com',
  '.google.com',
  '.googleusercontent.com',
  'login.live.com',
  '.live.com',
  '.microsoft.com',
  '.microsoftonline.com',
  'appleid.apple.com',
  '.apple.com',
  'github.com',
  '.github.com'
];

function normalizeHostname(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
}

function hostMatchesPattern(hostname, pattern) {
  const h = normalizeHostname(hostname);
  const p = normalizeHostname(pattern);
  if (!h || !p) return false;
  if (p.startsWith('.')) return h === p.slice(1) || h.endsWith(p);
  return h === p;
}

export function isAllowedAuthPopupUrl(url, { vendorId = 'chatgpt' } = {}) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;

  const host = normalizeHostname(u.hostname);
  if (!host) return false;

  // Keep behavior conservative: only explicitly allow supported vendor auth flows.
  const vendor = String(vendorId || 'chatgpt').trim().toLowerCase();
  if (!['chatgpt', 'perplexity'].includes(vendor)) return false;

  return CHATGPT_AUTH_HOST_ALLOWLIST.some((pattern) => hostMatchesPattern(host, pattern));
}

export function shouldAllowPopup({
  url,
  vendorId = 'chatgpt',
  allowAuthPopups = true
} = {}) {
  if (!allowAuthPopups) return false;
  return isAllowedAuthPopupUrl(url, { vendorId });
}
