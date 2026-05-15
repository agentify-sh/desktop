function asBool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  }
  return fallback;
}

function normalizePath(v, fallback) {
  const s = String(v || '').trim();
  if (!s) return fallback;
  return s.startsWith('/') ? s : `/${s}`;
}

export function defaultTrolyConfig() {
  return {
    apiBaseUrl: '',
    loginPath: '/v1/windows-client/login',
    keySyncPath: '/v1/keys',
    timeoutMs: 15_000,
    requireTls: true,
    environment: 'development'
  };
}

export function readTrolyConfig(env = process.env) {
  const d = defaultTrolyConfig();
  const timeoutRaw = Number(env.TROLY_API_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutRaw) ? Math.min(120_000, Math.max(1_000, timeoutRaw)) : d.timeoutMs;
  return {
    apiBaseUrl: String(env.TROLY_API_BASE_URL || env.TROLY_BASE_URL || d.apiBaseUrl).trim(),
    loginPath: normalizePath(env.TROLY_AUTH_LOGIN_PATH, d.loginPath),
    keySyncPath: normalizePath(env.TROLY_KEY_SYNC_PATH, d.keySyncPath),
    timeoutMs,
    requireTls: asBool(env.TROLY_REQUIRE_TLS, d.requireTls),
    environment: String(env.NODE_ENV || d.environment).trim() || d.environment
  };
}

function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

export function validateTrolyConfig(config, { strict = false } = {}) {
  const errors = [];
  const warnings = [];

  if (!config.apiBaseUrl) {
    const msg = 'Missing TROLY_API_BASE_URL. Troly auth/key integration is not configured yet.';
    if (strict) errors.push(msg);
    else warnings.push(msg);
    return { errors, warnings };
  }

  let parsed = null;
  try {
    parsed = new URL(config.apiBaseUrl);
  } catch {
    errors.push('TROLY_API_BASE_URL is not a valid URL.');
    return { errors, warnings };
  }

  if (config.requireTls && parsed.protocol !== 'https:' && !isLocalHost(parsed.hostname)) {
    const msg = 'TROLY_API_BASE_URL should use https in non-local environments.';
    if (strict) errors.push(msg);
    else warnings.push(msg);
  }

  return { errors, warnings };
}

export function trolyEndpoints(config) {
  if (!config.apiBaseUrl) {
    return {
      loginUrl: '',
      keySyncUrl: ''
    };
  }

  const base = new URL(config.apiBaseUrl);
  const loginUrl = new URL(config.loginPath, base).toString();
  const keySyncUrl = new URL(config.keySyncPath, base).toString();
  return { loginUrl, keySyncUrl };
}
