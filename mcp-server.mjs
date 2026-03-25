#!/usr/bin/env node
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { defaultStateDir } from './state.mjs';
import { ensureDesktopRunning, requestJson } from './mcp-lib.mjs';

const server = new McpServer({ name: 'agentify-desktop', version: '0.1.0' });
const stateDir = defaultStateDir();
const showTabs = process.argv.includes('--show-tabs');

function resolveLocalPaths(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => (path.isAbsolute(item) ? item : path.resolve(process.cwd(), item)));
}

function registerTool(name, def, handler) {
  server.registerTool(name, def, handler);
}

async function getConn() {
  return await ensureDesktopRunning({ stateDir, showTabs });
}

registerTool(
  'agentify_query',
  {
    description:
      'Send a prompt to the local Agentify Desktop session (ChatGPT web) and return the latest assistant response. If a CAPTCHA/login challenge appears, the desktop window will ask for user intervention and resume automatically.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to use (for parallel jobs).'),
      key: z.string().optional().describe('Stable tab key (e.g., project name); creates a tab if missing.'),
      bundleName: z.string().optional().describe('Named context bundle to merge into this query before sending.'),
      prompt: z.string().describe('Prompt to send to ChatGPT.'),
      promptPrefix: z.string().optional().describe('Optional reusable instruction block prepended before packed context and prompt.'),
      attachments: z.array(z.string()).optional().describe('Local file paths to upload before sending the prompt.'),
      contextPaths: z.array(z.string()).optional().describe('Local files/folders to pack into the prompt and/or attach automatically.'),
      maxContextChars: z.number().optional().describe('Maximum packed inline context characters to add before the prompt.'),
      maxContextFiles: z.number().optional().describe('Maximum number of files to scan from contextPaths.'),
      maxContextFileChars: z.number().optional().describe('Maximum sampled characters per text file before chunking.'),
      maxContextChunkChars: z.number().optional().describe('Maximum characters per inline chunk when a text file is split.'),
      maxContextChunksPerFile: z.number().optional().describe('Maximum number of chunks to inline for any single file.'),
      maxContextInlineFiles: z.number().optional().describe('Maximum number of text files to inline into the prompt.'),
      maxContextAttachments: z.number().optional().describe('Maximum binary/image files auto-attached from contextPaths.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for completion.')
    }
  },
  async ({
    model,
    tabId,
    key,
    bundleName,
    prompt,
    promptPrefix,
    attachments,
    contextPaths,
    maxContextChars,
    maxContextFiles,
    maxContextFileChars,
    maxContextChunkChars,
    maxContextChunksPerFile,
    maxContextInlineFiles,
    maxContextAttachments,
    timeoutMs
  }) => {
    const resolvedAttachments = resolveLocalPaths(attachments || []);
    const resolvedContextPaths = resolveLocalPaths(contextPaths || []);
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/query',
      body: {
        source: 'mcp',
        model,
        tabId,
        key,
        bundleName,
        prompt,
        promptPrefix,
        attachments: resolvedAttachments,
        contextPaths: resolvedContextPaths,
        maxContextChars: maxContextChars || undefined,
        maxContextFiles: maxContextFiles || undefined,
        maxContextFileChars: maxContextFileChars || undefined,
        maxContextChunkChars: maxContextChunkChars || undefined,
        maxContextChunksPerFile: maxContextChunksPerFile || undefined,
        maxContextInlineFiles: maxContextInlineFiles || undefined,
        maxContextAttachments: maxContextAttachments || undefined,
        timeoutMs: timeoutMs || 10 * 60_000
      }
    });
    const structuredContent = {
      text: data.result?.text || '',
      codeBlocks: data.result?.codeBlocks || [],
      meta: data.result?.meta || null,
      packedContext: data.packedContext || null,
      packedContextSummary: data.packedContextSummary || data.packedContext?.summary || null,
      bundle: data.bundle || null
    };
    return {
      content: [{ type: 'text', text: structuredContent.text }],
      structuredContent: { tabId: data.tabId || tabId || null, ...structuredContent }
    };
  }
);

registerTool(
  'agentify_read_page',
  {
    description: 'Read text content from the active tab in the local Agentify Desktop window.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      maxChars: z.number().optional().describe('Maximum characters to return.')
    }
  },
  async ({ model, tabId, key, maxChars }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/read-page',
      body: { model, tabId, key, maxChars: maxChars || 200_000 }
    });
    return { content: [{ type: 'text', text: data.text || '' }] };
  }
);

registerTool(
  'agentify_navigate',
  {
    description: 'Navigate the Agentify Desktop browser window to a URL (local UI automation).',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      url: z.string().describe('URL to navigate to.')
    }
  },
  async ({ model, tabId, key, url }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/navigate', body: { model, tabId, key, url } });
    return { content: [{ type: 'text', text: data.url || 'ok' }], structuredContent: data };
  }
);

registerTool(
  'agentify_ensure_ready',
  {
    description:
      'Wait until ChatGPT is ready for input (e.g., after login/CAPTCHA). Triggers local user handoff if needed and resumes when the prompt textarea is visible.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for readiness.')
    }
  },
  async ({ model, tabId, key, timeoutMs }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/ensure-ready',
      body: { model, tabId, key, timeoutMs: timeoutMs || 10 * 60_000 }
    });
    return { content: [{ type: 'text', text: JSON.stringify(data.state || {}, null, 2) }], structuredContent: data };
  }
);

registerTool(
  'agentify_show',
  { description: 'Bring the Agentify Desktop window to the front.', inputSchema: { model: z.string().optional(), tabId: z.string().optional(), key: z.string().optional() } },
  async ({ model, tabId, key }) => {
    const conn = await getConn();
    await requestJson({ ...conn, method: 'POST', path: '/show', body: { model, tabId, key } });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

registerTool(
  'agentify_hide',
  { description: 'Minimize the Agentify Desktop window.', inputSchema: { model: z.string().optional(), tabId: z.string().optional(), key: z.string().optional() } },
  async ({ model, tabId, key }) => {
    const conn = await getConn();
    await requestJson({ ...conn, method: 'POST', path: '/hide', body: { model, tabId, key } });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

registerTool(
  'agentify_status',
  {
    description: 'Get current URL and blocked/ready status for the Agentify Desktop window.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to inspect.'),
      key: z.string().optional().describe('Stable tab key to inspect.'),
      vendorId: z.string().optional().describe('Target vendor id to inspect.')
    }
  },
  async ({ model, tabId, key, vendorId }) => {
    const conn = await getConn();
    const qs = new URLSearchParams();
    if (tabId) qs.set('tabId', tabId);
    if (key) qs.set('key', key);
    if (vendorId) qs.set('vendorId', vendorId);
    if (model) qs.set('model', model);
    const path = qs.size ? `/status?${qs.toString()}` : '/status';
    const data = await requestJson({ ...conn, method: 'GET', path });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
);

registerTool(
  'agentify_stop_query',
  {
    description: 'Break-glass stop for a running query/send on a tab. Best-effort: requests cancellation and clicks the provider stop button if visible.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to stop.'),
      key: z.string().optional().describe('Stable tab key to stop.'),
      vendorId: z.string().optional().describe('Target vendor id to stop.')
    }
  },
  async ({ model, tabId, key, vendorId }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/query/stop',
      body: { model, tabId, key, vendorId }
    });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
);

registerTool(
  'agentify_image_gen',
  {
    description:
      'Generate images via ChatGPT web UI (best-effort): sends the prompt, then downloads any images from the latest assistant message to a local folder and returns file paths.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      prompt: z.string().describe('Prompt to send to ChatGPT for image generation.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for completion.'),
      maxImages: z.number().optional().describe('Maximum images to download.')
    }
  },
  async ({ model, tabId, key, prompt, timeoutMs, maxImages }) => {
    const conn = await getConn();
    const q = await requestJson({
      ...conn,
      method: 'POST',
      path: '/query',
      body: { source: 'mcp', model, tabId, key, prompt, attachments: [], timeoutMs: timeoutMs || 10 * 60_000 }
    });
    const d = await requestJson({
      ...conn,
      method: 'POST',
      path: '/artifacts/save',
      body: { model, tabId: q.tabId || tabId, key, mode: 'images', maxImages: maxImages || 6 }
    });
    const structuredContent = { text: q.result?.text || '', files: d.artifacts || [], dir: d.dir || null };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent: { tabId: q.tabId || tabId || null, ...structuredContent }
    };
  }
);

registerTool(
  'agentify_download_images',
  {
    description:
      'Download images from the latest assistant message (best-effort). Useful if you generated images manually in the UI or via agentify_query.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      maxImages: z.number().optional().describe('Maximum images to download.')
    }
  },
  async ({ model, tabId, key, maxImages }) => {
    const conn = await getConn();
    const d = await requestJson({
      ...conn,
      method: 'POST',
      path: '/artifacts/save',
      body: { model, tabId, key, mode: 'images', maxImages: maxImages || 6 }
    });
    const structuredContent = { files: d.artifacts || [], dir: d.dir || null };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent: { tabId: d.tabId || tabId || null, ...structuredContent }
    };
  }
);

registerTool(
  'agentify_list_watch_folders',
  {
    description: 'List local watch/ingest folders that Agentify indexes into artifacts automatically.',
    inputSchema: {}
  },
  async () => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'GET', path: '/watch-folders/list' });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.folders || [], null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_add_watch_folder',
  {
    description: 'Add a local folder to Agentify watch/ingest folders.',
    inputSchema: {
      name: z.string().optional().describe('Friendly folder name. If omitted, Agentify derives one from the path.'),
      folderPath: z.string().describe('Local folder path to watch. Relative paths resolve from the MCP client working directory.')
    }
  },
  async ({ name, folderPath }) => {
    const rawPath = String(folderPath || '').trim();
    if (!rawPath) throw new Error('missing_watch_folder_path');
    const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/watch-folders/add',
      body: { name: name || '', path: resolvedPath }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.folder || null, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_remove_watch_folder',
  {
    description: 'Remove a configured watch/ingest folder by name.',
    inputSchema: {
      name: z.string().describe('Configured watch folder name.')
    }
  },
  async ({ name }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/watch-folders/delete',
      body: { name }
    });
    return {
      content: [{ type: 'text', text: data.deleted ? 'deleted' : 'not_found' }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_open_watch_folder',
  {
    description: 'Open the local watch/ingest folder in Finder/Explorer so you can drop files there for automatic indexing.',
    inputSchema: {
      name: z.string().optional().describe('Watch folder name. Defaults to inbox.')
    }
  },
  async ({ name }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/watch-folders/open',
      body: { name: name || 'inbox' }
    });
    return {
      content: [{ type: 'text', text: data.folder?.path || 'ok' }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_scan_watch_folder',
  {
    description: 'Force an immediate scan of the watch/ingest folder and index any newly dropped files as artifacts.',
    inputSchema: {}
  },
  async () => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/watch-folders/scan', body: {} });
    return {
      content: [{ type: 'text', text: JSON.stringify({ folders: data.folders || [], ingested: data.ingested || [] }, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_save_bundle',
  {
    description:
      'Save a named reusable bundle of prompt prefix, attachments, and context paths. Useful for recurring project workflows.',
    inputSchema: {
      name: z.string().describe('Stable bundle name, e.g. repo-review.'),
      promptPrefix: z.string().optional().describe('Reusable instruction prefix.'),
      attachments: z.array(z.string()).optional().describe('Local files to always attach with this bundle.'),
      contextPaths: z.array(z.string()).optional().describe('Local files/folders to pack when this bundle is used.')
    }
  },
  async ({ name, promptPrefix, attachments, contextPaths }) => {
    const resolvedAttachments = resolveLocalPaths(attachments || []);
    const resolvedContextPaths = resolveLocalPaths(contextPaths || []);
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/bundles/save',
      body: { name, promptPrefix, attachments: resolvedAttachments, contextPaths: resolvedContextPaths }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.bundle || {}, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_list_bundles',
  {
    description: 'List saved context bundles.',
    inputSchema: {}
  },
  async () => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'GET', path: '/bundles/list' });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.bundles || [], null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_get_bundle',
  {
    description: 'Fetch a saved context bundle by name.',
    inputSchema: {
      name: z.string().describe('Bundle name.')
    }
  },
  async ({ name }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/bundles/get', body: { name } });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.bundle || null, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_delete_bundle',
  {
    description: 'Delete a saved context bundle by name.',
    inputSchema: {
      name: z.string().describe('Bundle name.')
    }
  },
  async ({ name }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/bundles/delete', body: { name } });
    return {
      content: [{ type: 'text', text: data.deleted ? 'deleted' : 'not_found' }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_save_artifacts',
  {
    description:
      'Save the latest assistant-generated images/files from a tab to the local artifacts folder. Returns local paths you can reuse as attachments in the next prompt.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; uses the existing tab.'),
      mode: z.enum(['images', 'files', 'all']).optional().describe('What to save from the latest assistant response.'),
      maxImages: z.number().optional().describe('Maximum images to save when mode includes images.'),
      maxFiles: z.number().optional().describe('Maximum files/links to save when mode includes files.')
    }
  },
  async ({ model, tabId, key, mode, maxImages, maxFiles }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/artifacts/save',
      body: { model, tabId, key, mode: mode || 'all', maxImages: maxImages || 6, maxFiles: maxFiles || 6 }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ dir: data.dir || null, artifacts: data.artifacts || [] }, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_list_artifacts',
  {
    description: 'List locally saved artifacts for a tab/session so you can reuse their paths in later prompts.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to inspect.'),
      key: z.string().optional().describe('Stable tab key to inspect.'),
      limit: z.number().optional().describe('Maximum number of artifacts to return.')
    }
  },
  async ({ model, tabId, key, limit }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/artifacts/list',
      body: { model, tabId, key, limit: limit || 50 }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.artifacts || [], null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_open_artifacts_folder',
  {
    description: 'Open the local artifacts folder in Finder/Explorer for the whole app or for a specific tab/session.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id whose artifacts folder should open.'),
      key: z.string().optional().describe('Stable tab key whose artifacts folder should open.')
    }
  },
  async ({ model, tabId, key }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/artifacts/open-folder',
      body: { model, tabId, key }
    });
    return {
      content: [{ type: 'text', text: data.folderPath || 'ok' }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_tabs',
  { description: 'List current tabs/sessions (for parallel jobs).', inputSchema: {} },
  async () => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'GET', path: '/tabs' });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
);

registerTool(
  'agentify_tab_create',
  {
    description: 'Create (or ensure) a tab/session for a given key.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      key: z.string().optional(),
      name: z.string().optional(),
      show: z.boolean().optional().describe('Show the tab window immediately.')
    }
  },
  async ({ model, key, name, show }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/tabs/create',
      body: { model, key, name, show: typeof show === 'boolean' ? show : undefined }
    });
    return { content: [{ type: 'text', text: data.tabId || '' }], structuredContent: data };
  }
);

registerTool(
  'agentify_tab_close',
  { description: 'Close a tab/session by tabId.', inputSchema: { tabId: z.string().describe('Tab id to close.') } },
  async ({ tabId }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/tabs/close', body: { tabId } });
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: data };
  }
);

registerTool('agentify_shutdown', { description: 'Gracefully shut down the Agentify Desktop app.', inputSchema: {} }, async () => {
  const conn = await getConn();
  await requestJson({ ...conn, method: 'POST', path: '/shutdown', body: { scope: 'app' } });
  return { content: [{ type: 'text', text: 'ok' }] };
});

registerTool(
  'agentify_rotate_token',
  { description: 'Rotate the local HTTP API bearer token (requires reconnect on subsequent calls).', inputSchema: {} },
  async () => {
    const conn = await getConn();
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
