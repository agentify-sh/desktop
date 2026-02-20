import test from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedAuthPopupUrl, shouldAllowPopup } from '../popup-policy.mjs';

test('popup-policy: allows Google auth popup URL for chatgpt vendor', () => {
  assert.equal(isAllowedAuthPopupUrl('https://accounts.google.com/signin/v2/identifier', { vendorId: 'chatgpt' }), true);
});

test('popup-policy: allows OpenAI auth popup URL for chatgpt vendor', () => {
  assert.equal(isAllowedAuthPopupUrl('https://auth.openai.com/u/login', { vendorId: 'chatgpt' }), true);
});

test('popup-policy: allows Google auth popup URL for perplexity vendor', () => {
  assert.equal(isAllowedAuthPopupUrl('https://accounts.google.com/signin/v2/identifier', { vendorId: 'perplexity' }), true);
});

test('popup-policy: allows Google auth popup URL for claude vendor', () => {
  assert.equal(isAllowedAuthPopupUrl('https://accounts.google.com/signin/v2/identifier', { vendorId: 'claude' }), true);
});

test('popup-policy: allows Google auth popup URL for aistudio vendor', () => {
  assert.equal(isAllowedAuthPopupUrl('https://accounts.google.com/signin/v2/identifier', { vendorId: 'aistudio' }), true);
});

test('popup-policy: allows Google auth popup URL for gemini vendor', () => {
  assert.equal(isAllowedAuthPopupUrl('https://accounts.google.com/signin/v2/identifier', { vendorId: 'gemini' }), true);
});

test('popup-policy: allows x.com auth popup URL for grok vendor', () => {
  assert.equal(isAllowedAuthPopupUrl('https://x.com/i/flow/login', { vendorId: 'grok' }), true);
});

test('popup-policy: allows additional Google auth host used in SSO chains', () => {
  assert.equal(isAllowedAuthPopupUrl('https://myaccount.google.com/', { vendorId: 'gemini' }), true);
});

test('popup-policy: allows about:blank popup for known vendor opener (OAuth pre-open)', () => {
  assert.equal(
    shouldAllowPopup({
      url: 'about:blank',
      vendorId: 'chatgpt',
      openerUrl: 'https://chatgpt.com/auth/login',
      frameName: 'oauth_popup'
    }),
    true
  );
});

test('popup-policy: blocks about:blank popup for unknown opener', () => {
  assert.equal(
    shouldAllowPopup({
      url: 'about:blank',
      vendorId: 'chatgpt',
      openerUrl: 'https://evil.example.com',
      frameName: 'oauth_popup'
    }),
    false
  );
});

test('popup-policy: blocks non-https popup URL', () => {
  assert.equal(isAllowedAuthPopupUrl('http://accounts.google.com/signin/v2/identifier', { vendorId: 'chatgpt' }), false);
});

test('popup-policy: blocks unknown popup URL', () => {
  assert.equal(isAllowedAuthPopupUrl('https://evil.example.com/login', { vendorId: 'chatgpt' }), false);
});

test('popup-policy: can globally disable auth popups via setting', () => {
  assert.equal(
    shouldAllowPopup({
      url: 'https://accounts.google.com/signin/v2/identifier',
      vendorId: 'chatgpt',
      allowAuthPopups: false
    }),
    false
  );
});
