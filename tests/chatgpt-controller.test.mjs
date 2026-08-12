import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatGPTController } from '../chatgpt-controller.mjs';

function readyState() {
  return {
    url: 'https://chatgpt.com/',
    title: 'ChatGPT',
    readyState: 'complete',
    blocked: false,
    promptVisible: true,
    kind: null,
    indicators: {
      hasTurnstile: false,
      hasArkose: false,
      hasVerifyButton: false,
      looks403: false,
      loginLike: false,
      rawPromptVisible: true,
      sendVisible: true
    }
  };
}

test('chatgpt-controller: a new user turn confirms send without duplicate fallbacks', async () => {
  const events = [];
  let waitForSendChecks = 0;

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.trim() === `document.querySelectorAll('[data-message-author-role="user"]').length`) return 1;
      if (js.includes('already_generating')) return { ok: true, rect: { x: 220, y: 10, w: 40, h: 40 }, host: 'chatgpt.com' };
      if (js.includes('promptLen')) {
        waitForSendChecks += 1;
        return { stopVisible: false, sendDisabled: false, promptLen: 7, userCount: 2 };
      }
      if (js.includes('form.requestSubmit')) {
        events.push('requestSubmit');
        return true;
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/';
    },
    async sendKey(key) {
      events.push(`key:${key}`);
    },
    async insertText(text) {
      events.push(`text:${text}`);
    },
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });

  const result = await controller.send({ text: 'agentify', timeoutMs: 5_000 });
  assert.deepEqual(result, { ok: true });
  assert.equal(waitForSendChecks, 1);
  assert.equal(events.includes('requestSubmit'), false);
  assert.equal(events.includes('key:Enter'), false);
});

test('chatgpt-controller: waits for finalized ChatGPT assistant turn instead of transient Thinking text', async () => {
  let responseSnapshots = 0;

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.trim() === `document.querySelectorAll('[data-message-author-role="user"]').length`) return 1;
      if (js.includes('already_generating')) return { ok: true, rect: { x: 220, y: 10, w: 40, h: 40 }, host: 'chatgpt.com' };
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: false, promptLen: 0, userCount: 2 };
      if (js.includes('const codes =')) return { codeBlocks: [] };
      if (js.includes('assistantActionsReady')) {
        responseSnapshots += 1;
        if (responseSnapshots === 1) {
          return {
            stop: false,
            sendEnabled: true,
            txt: 'Thinking',
            count: 1,
            usedFallback: false,
            hasError: false,
            hasContinue: false,
            hasRegenerate: false,
            isChatgpt: true,
            assistantActionsReady: false
          };
        }
        return {
          stop: false,
          sendEnabled: true,
          txt: 'FINAL_OK',
          count: 1,
          usedFallback: false,
          hasError: false,
          hasContinue: false,
          hasRegenerate: true,
          isChatgpt: true,
          assistantActionsReady: true
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });

  const result = await controller.query({ prompt: 'x', timeoutMs: 5_000 });
  assert.equal(result.text, 'FINAL_OK');
  assert.ok(responseSnapshots >= 4);
});

test('chatgpt-controller: send falls back to requestSubmit on the active composer before Enter', async () => {
  const events = [];
  let waitForSendChecks = 0;

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes("form.requestSubmit")) {
        events.push('requestSubmit');
        return true;
      }
      if (js.includes('already_generating')) return { ok: true, requestSubmit: true, host: 'chatgpt.com' };
      if (js.includes('promptLen')) {
        waitForSendChecks += 1;
        return waitForSendChecks >= 2
          ? { stopVisible: false, sendDisabled: true, promptLen: 0 }
          : { stopVisible: false, sendDisabled: false, promptLen: 7 };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/';
    },
    async sendKey(key) {
      events.push(`key:${key}`);
    },
    async insertText(text) {
      events.push(`text:${text}`);
    },
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });

  const result = await controller.send({ text: 'agentify', timeoutMs: 5_000 });
  assert.deepEqual(result, { ok: true });
  assert.equal(events.includes('requestSubmit'), true);
  assert.equal(events.includes('key:Enter'), false);
});
