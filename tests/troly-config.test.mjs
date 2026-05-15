import test from 'node:test';
import assert from 'node:assert/strict';

import { readTrolyConfig, trolyEndpoints, validateTrolyConfig } from '../troly-config.mjs';

test('troly-config: readTrolyConfig applies defaults and normalizes paths', () => {
  const config = readTrolyConfig({
    TROLY_API_BASE_URL: 'https://troly.me',
    TROLY_AUTH_LOGIN_PATH: 'v1/custom-login',
    TROLY_KEY_SYNC_PATH: '/v2/key-sync',
    TROLY_API_TIMEOUT_MS: '800',
    TROLY_REQUIRE_TLS: 'true'
  });

  assert.equal(config.apiBaseUrl, 'https://troly.me');
  assert.equal(config.loginPath, '/v1/custom-login');
  assert.equal(config.keySyncPath, '/v2/key-sync');
  assert.equal(config.timeoutMs, 1000);
  assert.equal(config.requireTls, true);
});

test('troly-config: validate warns when api base url is missing in non-strict mode', () => {
  const config = readTrolyConfig({});
  const result = validateTrolyConfig(config, { strict: false });

  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length > 0, true);
});

test('troly-config: validate errors on invalid URL', () => {
  const config = readTrolyConfig({ TROLY_API_BASE_URL: 'not-a-url' });
  const result = validateTrolyConfig(config, { strict: true });

  assert.equal(result.errors.length > 0, true);
});

test('troly-config: validate enforces https for non-local host in strict mode', () => {
  const config = readTrolyConfig({
    TROLY_API_BASE_URL: 'http://troly.me',
    TROLY_REQUIRE_TLS: 'true'
  });
  const result = validateTrolyConfig(config, { strict: true });

  assert.equal(result.errors.length > 0, true);
});

test('troly-config: trolyEndpoints builds login and key URLs', () => {
  const config = readTrolyConfig({
    TROLY_API_BASE_URL: 'https://troly.me/',
    TROLY_AUTH_LOGIN_PATH: '/v1/windows-client/login',
    TROLY_KEY_SYNC_PATH: '/v1/keys'
  });
  const urls = trolyEndpoints(config);

  assert.equal(urls.loginUrl, 'https://troly.me/v1/windows-client/login');
  assert.equal(urls.keySyncUrl, 'https://troly.me/v1/keys');
});
