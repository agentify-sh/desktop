import crypto from 'node:crypto';

function isUuidLike(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.trim());
}

export function parseAgentifyToolBlocks(pageText) {
  const text = String(pageText || '');
  const blocks = [];
  const re = /```json\s*([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(text))) {
    const raw = String(m[1] || '').trim();
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && typeof obj.agentify_tool === 'string') {
        blocks.push({ obj, raw, index: m.index });
      }
    } catch {
      // ignore
    }
  }
  blocks.sort((a, b) => a.index - b.index);
  return blocks.map((b) => b.obj);
}

export function normalizeToolRequest(obj, { defaultKey = null } = {}) {
  if (!obj || typeof obj !== 'object') throw new Error('invalid_tool_request');
  const tool = String(obj.agentify_tool || '').trim();
  const id = String(obj.id || '').trim();
  const key = String(obj.key || defaultKey || '').trim();
  const mode = String(obj.mode || 'interactive').trim();
  const args = obj.args && typeof obj.args === 'object' ? obj.args : {};
  if (!tool) throw new Error('missing_tool');
  if (!key) throw new Error('missing_key');
  if (!isUuidLike(id)) throw new Error('missing_or_invalid_id');
  if (mode !== 'interactive' && mode !== 'batch') throw new Error('invalid_mode');
  return { tool, id, key, mode, args };
}

export function createToolRequest({ tool, key, mode = 'interactive', args = {} }) {
  const id = crypto.randomUUID();
  return { agentify_tool: tool, id, key, mode, args };
}

