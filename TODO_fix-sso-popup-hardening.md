# TODO (fix-sso-popup-hardening)

## Goal
- Improve Google SSO reliability in embedded auth flows for ChatGPT/Gemini by fixing popup gating edge cases and popup window fingerprint consistency.

## Planned changes
- Expand popup allowlist for Google auth-related hosts seen in real OAuth redirects.
- Allow `about:blank` auth popups only for supported vendors (strictly gated) to handle OAuth flows that open a blank popup before redirect.
- Ensure auth popup windows inherit the same spoofed Chrome user agent as primary tabs.
- Add/extend popup-policy tests for the above.

## Verification
- `npm test` pass.
- Manual smoke checklist:
  - Enable `Allow auth popups`.
  - Try ChatGPT Google SSO popup.
  - Try Gemini Google SSO popup.
  - Confirm popup opens and can progress to Google auth (provider may still block embedded webviews on policy grounds).
