const CHATGPT_AUTH_HOST_ALLOWLIST = [
  // OpenAI / ChatGPT auth surfaces.
  'chatgpt.com',
  '.chatgpt.com',
  'openai.com',
  '.openai.com',

  // Common SSO providers used by ChatGPT users.
  'accounts.google.com',
  'accounts.youtube.com',
  'myaccount.google.com',
  'ogs.google.com',
  '.google.com',
  '.googleusercontent.com',
  'login.live.com',
  '.live.com',
  '.microsoft.com',
  '.microsoftonline.com',
  'appleid.apple.com',
  '.apple.com',
  'github.com',
  '.github.com',

  // X/Twitter auth surfaces (used by Grok accounts).
  'x.com',
  '.x.com',
  'twitter.com',
  '.twitter.com',
  'grok.com',
  '.grok.com'
];

const SUPPORTED_VENDOR_IDS = ['chatgpt', 'perplexity', 'claude', 'aistudio', 'gemini', 'grok'];
const VENDOR_HOST_ALLOWLIST = [
  'chatgpt.com',
  '.chatgpt.com',
  'claude.ai',
  '.claude.ai',
  'gemini.google.com',
  '.gemini.google.com',
  'aistudio.google.com',
  '.aistudio.google.com',
  'perplexity.ai',
  '.perplexity.ai',
  'grok.com',
  '.grok.com'
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
  if (!SUPPORTED_VENDOR_IDS.includes(vendor)) return false;

  return CHATGPT_AUTH_HOST_ALLOWLIST.some((pattern) => hostMatchesPattern(host, pattern));
}

function isAllowedBlankAuthPopup({
  url,
  vendorId = 'chatgpt',
  openerUrl = '',
  frameName = '',
  disposition = ''
} = {}) {
  const vendor = String(vendorId || 'chatgpt').trim().toLowerCase();
  if (!SUPPORTED_VENDOR_IDS.includes(vendor)) return false;

  const popupUrl = String(url || '').trim().toLowerCase();
  if (popupUrl !== 'about:blank') return false;

  const disp = String(disposition || '').trim().toLowerCase();
  const frame = String(frameName || '').trim().toLowerCase();
  const looksLikeAuthPopup =
    frame.includes('oauth') ||
    frame.includes('auth') ||
    frame.includes('signin') ||
    frame.includes('login') ||
    disp === 'new-window' ||
    disp === 'foreground-tab' ||
    disp === 'background-tab' ||
    disp === '';
  if (!looksLikeAuthPopup) return false;

  let openerHost = '';
  try {
    openerHost = normalizeHostname(new URL(String(openerUrl || '')).hostname);
  } catch {
    return false;
  }
  if (!openerHost) return false;

  const isVendorHost = VENDOR_HOST_ALLOWLIST.some((pattern) => hostMatchesPattern(openerHost, pattern));
  const isTrustedAuthHost = CHATGPT_AUTH_HOST_ALLOWLIST.some((pattern) => hostMatchesPattern(openerHost, pattern));
  return isVendorHost || isTrustedAuthHost;
}

export function shouldAllowPopup({
  url,
  vendorId = 'chatgpt',
  allowAuthPopups = true,
  openerUrl = '',
  frameName = '',
  disposition = ''
} = {}) {
  if (!allowAuthPopups) return false;
  if (isAllowedAuthPopupUrl(url, { vendorId })) return true;
  return isAllowedBlankAuthPopup({ url, vendorId, openerUrl, frameName, disposition });
}
