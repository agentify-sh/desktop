#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { defaultStateDir } from './state.mjs';
import { ensureDesktopRunning, requestJson } from './mcp-lib.mjs';

const server = new McpServer({ name: 'agentify-desktop', version: '0.1.0' });
const stateDir = defaultStateDir();

server.registerTool(
  'browser_query',
  {
    description:
      'Send a prompt to the local Agentify Desktop session (ChatGPT web) and return the latest assistant response. If a CAPTCHA/login challenge appears, the desktop window will ask for user intervention and resume automatically.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to use (for parallel jobs).'),
      key: z.string().optional().describe('Stable tab key (e.g., project name); creates a tab if missing.'),
      prompt: z.string().describe('Prompt to send to ChatGPT.'),
      attachments: z.array(z.string()).optional().describe('Local file paths to upload before sending the prompt.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for completion.')
    }
  },
  async ({ model, tabId, key, prompt, attachments, timeoutMs }) => {
    void model;
    const conn = await ensureDesktopRunning({ stateDir });
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/query',
      body: { tabId, key, prompt, attachments: attachments || [], timeoutMs: timeoutMs || 10 * 60_000 }
    });
    const structuredContent = {
      text: data.result?.text || '',
      codeBlocks: data.result?.codeBlocks || [],
      meta: data.result?.meta || null
    };
    return {
      content: [{ type: 'text', text: structuredContent.text }],
      structuredContent: { tabId: data.tabId || tabId || null, ...structuredContent }
    };
  }
);

server.registerTool(
  'browser_read_page',
  {
    description: 'Read text content from the active tab in the local Agentify Desktop window.',
    inputSchema: {
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      maxChars: z.number().optional().describe('Maximum characters to return.')
    }
  },
  async ({ tabId, key, maxChars }) => {
    const conn = await ensureDesktopRunning({ stateDir });
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/read-page',
      body: { tabId, key, maxChars: maxChars || 200_000 }
    });
    return { content: [{ type: 'text', text: data.text || '' }] };
  }
);

server.registerTool(
  'browser_navigate',
  {
    description: 'Navigate the Agentify Desktop browser window to a URL (local UI automation).',
    inputSchema: {
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      url: z.string().describe('URL to navigate to.')
    }
  },
  async ({ tabId, key, url }) => {
    const conn = await ensureDesktopRunning({ stateDir });
    const data = await requestJson({ ...conn, method: 'POST', path: '/navigate', body: { tabId, key, url } });
    return { content: [{ type: 'text', text: data.url || 'ok' }], structuredContent: data };
  }
);

server.registerTool(
  'browser_ensure_ready',
  {
    description:
      'Wait until ChatGPT is ready for input (e.g., after login/CAPTCHA). Triggers local user handoff if needed and resumes when the prompt textarea is visible.',
    inputSchema: {
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for readiness.')
    }
  },
  async ({ tabId, key, timeoutMs }) => {
    const conn = await ensureDesktopRunning({ stateDir });
    const data = await requestJson({ ...conn, method: 'POST', path: '/ensure-ready', body: { tabId, key, timeoutMs: timeoutMs || 10 * 60_000 } });
    return { content: [{ type: 'text', text: JSON.stringify(data.state || {}, null, 2) }], structuredContent: data };
  }
);

server.registerTool(
  'browser_show',
  {
    description: 'Bring the Agentify Desktop window to the front.',
    inputSchema: { tabId: z.string().optional(), key: z.string().optional() }
  },
  async ({ tabId, key }) => {
    const conn = await ensureDesktopRunning({ stateDir });
    await requestJson({ ...conn, method: 'POST', path: '/show', body: { tabId, key } });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

server.registerTool(
  'browser_hide',
  { description: 'Minimize the Agentify Desktop window.', inputSchema: { tabId: z.string().optional(), key: z.string().optional() } },
  async ({ tabId, key }) => {
    const conn = await ensureDesktopRunning({ stateDir });
    await requestJson({ ...conn, method: 'POST', path: '/hide', body: { tabId, key } });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

server.registerTool(
  'browser_status',
  {
    description: 'Get current URL and blocked/ready status for the Agentify Desktop window.',
    inputSchema: { tabId: z.string().optional().describe('Tab/session id to query.') }
  },
  async ({ tabId }) => {
    const conn = await ensureDesktopRunning({ stateDir });
    const path = tabId ? `/status?tabId=${encodeURIComponent(tabId)}` : '/status';
    const data = await requestJson({ ...conn, method: 'GET', path });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
);

server.registerTool(
  'browser_image_gen',
  {
    description:
      'Generate images via ChatGPT web UI (best-effort): sends the prompt, then downloads any images from the latest assistant message to a local folder and returns file paths.',
    inputSchema: {
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      prompt: z.string().describe('Prompt to send to ChatGPT for image generation.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for completion.'),
      maxImages: z.number().optional().describe('Maximum images to download.')
    }
  },
  async ({ tabId, key, prompt, timeoutMs, maxImages }) => {
    const conn = await ensureDesktopRunning({ stateDir });
    const q = await requestJson({
      ...conn,
      method: 'POST',
      path: '/query',
      body: { tabId, key, prompt, attachments: [], timeoutMs: timeoutMs || 10 * 60_000 }
    });
    const d = await requestJson({ ...conn, method: 'POST', path: '/download-images', body: { tabId: q.tabId || tabId, maxImages: maxImages || 6 } });
    const structuredContent = { text: q.result?.text || '', files: d.files || [] };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent: { tabId: q.tabId || tabId || null, ...structuredContent }
    };
  }
);

server.registerTool(
  'browser_tabs',
  {
    description: 'List current tabs/sessions (for parallel jobs).',
    inputSchema: {}
  },
  async () => {
    const conn = await ensureDesktopRunning({ stateDir });
    const data = await requestJson({ ...conn, method: 'GET', path: '/tabs' });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
);

server.registerTool(
  'browser_tab_create',
  {
    description: 'Create (or ensure) a tab/session for a given key.',
    inputSchema: { key: z.string().optional(), name: z.string().optional() }
  },
  async ({ key, name }) => {
    const conn = await ensureDesktopRunning({ stateDir });
    const data = await requestJson({ ...conn, method: 'POST', path: '/tabs/create', body: { key, name } });
    return { content: [{ type: 'text', text: data.tabId || '' }], structuredContent: data };
  }
);

server.registerTool(
  'browser_tab_close',
  {
    description: 'Close a tab/session by tabId.',
    inputSchema: { tabId: z.string().describe('Tab id to close.') }
  },
  async ({ tabId }) => {
    const conn = await ensureDesktopRunning({ stateDir });
    const data = await requestJson({ ...conn, method: 'POST', path: '/tabs/close', body: { tabId } });
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: data };
  }
);

server.registerTool(
  'browser_shutdown',
  {
    description: 'Gracefully shut down the Agentify Desktop app.',
    inputSchema: {}
  },
  async () => {
    const conn = await ensureDesktopRunning({ stateDir });
    await requestJson({ ...conn, method: 'POST', path: '/shutdown', body: { scope: 'app' } });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

server.registerTool(
  'browser_rotate_token',
  {
    description: 'Rotate the local HTTP API bearer token (requires reconnect on subsequent calls).',
    inputSchema: {}
  },
  async () => {
    const conn = await ensureDesktopRunning({ stateDir });
    await requestJson({ ...conn, method: 'POST', path: '/rotate-token' });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('agentify-desktop MCP server running on stdio');
}

main().catch((e) => {
  console.error('agentify-desktop MCP fatal:', e);
  process.exit(1);
});
