import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('mcp-server registers agentify_* tools only', async () => {
  const src = await fs.readFile(path.join(__dirname, '..', 'mcp-server.mjs'), 'utf8');

  assert.ok(src.includes("'agentify_query'"), 'expected agentify_query tool');
  assert.ok(src.includes("'agentify_download_images'"), 'expected agentify_download_images tool');
  assert.ok(src.includes("'agentify_list_watch_folders'"), 'expected agentify_list_watch_folders tool');
  assert.ok(src.includes("'agentify_add_watch_folder'"), 'expected agentify_add_watch_folder tool');
  assert.ok(src.includes("'agentify_remove_watch_folder'"), 'expected agentify_remove_watch_folder tool');
  assert.ok(src.includes("'agentify_open_watch_folder'"), 'expected agentify_open_watch_folder tool');
  assert.ok(src.includes("'agentify_save_bundle'"), 'expected agentify_save_bundle tool');
  assert.ok(src.includes("'agentify_list_bundles'"), 'expected agentify_list_bundles tool');
  assert.ok(src.includes("'agentify_save_artifacts'"), 'expected agentify_save_artifacts tool');
  assert.ok(src.includes("'agentify_list_artifacts'"), 'expected agentify_list_artifacts tool');
  assert.ok(src.includes('model,'), 'expected model hint to be forwarded to HTTP query');
  assert.ok(src.includes("body: { model, key, name, show: typeof show === 'boolean' ? show : undefined }"), 'expected model hint on tab_create');
  assert.ok(src.includes("body: { model, tabId, key, maxChars: maxChars || 200_000 }"), 'expected model hint on read_page');
  assert.ok(src.includes("body: { model, tabId, key, timeoutMs: timeoutMs || 10 * 60_000 }"), 'expected model hint on ensure_ready');
  assert.ok(src.includes("body: { model, tabId, key, mode: mode || 'all', maxImages: maxImages || 6, maxFiles: maxFiles || 6 }"), 'expected model hint on save_artifacts');
  assert.ok(src.includes("if (key) qs.set('key', key);"), 'expected status key selector forwarding');
  assert.ok(src.includes("if (vendorId) qs.set('vendorId', vendorId);"), 'expected status vendorId selector forwarding');
  assert.ok(src.includes("if (model) qs.set('model', model);"), 'expected status model selector forwarding');
  assert.ok(src.includes('resolveLocalPaths(attachments || [])'), 'expected attachments to be normalized relative to MCP cwd');
  assert.ok(src.includes('resolveLocalPaths(contextPaths || [])'), 'expected contextPaths to be normalized relative to MCP cwd');
  assert.ok(src.includes("source: 'mcp'"), 'expected MCP calls to mark runtime source');
  assert.ok(src.includes('folderPath: z.string()'), 'expected add_watch_folder to use folderPath field name');
  assert.ok(src.includes("throw new Error('missing_watch_folder_path')"), 'expected blank watch-folder path guard');
  assert.ok(src.includes('maxContextChunkChars: z.number().optional()'), 'expected maxContextChunkChars input');
  assert.ok(src.includes('maxContextChunksPerFile: z.number().optional()'), 'expected maxContextChunksPerFile input');
  assert.ok(src.includes('maxContextInlineFiles: z.number().optional()'), 'expected maxContextInlineFiles input');
  assert.ok(!src.includes('void model;'), 'model hint should not be dropped');

  assert.ok(!src.includes('browser_'), 'should not contain browser_* tools/aliases');
  assert.ok(!src.includes('registerToolWithAliases'), 'should not contain alias helper');
});
