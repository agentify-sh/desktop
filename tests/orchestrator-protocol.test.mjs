import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAgentifyToolBlocks, normalizeToolRequest } from '../orchestrator/protocol.mjs';

test('orchestrator/protocol: extracts last agentify_tool block', () => {
  const page = `
hello
\`\`\`json
{"agentify_tool":"codex.run","id":"11111111-1111-4111-8111-111111111111","key":"a","mode":"batch","args":{"prompt":"x"}}
\`\`\`
blah
\`\`\`json
{"agentify_tool":"codex.run","id":"22222222-2222-4222-8222-222222222222","key":"b","mode":"interactive","args":{"prompt":"y"}}
\`\`\`
`;
  const blocks = parseAgentifyToolBlocks(page);
  assert.equal(blocks.length, 2);
  const req = normalizeToolRequest(blocks[1]);
  assert.equal(req.id, '22222222-2222-4222-8222-222222222222');
  assert.equal(req.key, 'b');
  assert.equal(req.mode, 'interactive');
  assert.equal(req.tool, 'codex.run');
});

test('orchestrator/protocol: ignores malformed blocks', () => {
  const page = `
\`\`\`json
{not json}
\`\`\`
\`\`\`json
{"x":1}
\`\`\`
`;
  const blocks = parseAgentifyToolBlocks(page);
  assert.equal(blocks.length, 0);
});

test('orchestrator/protocol: normalize validates required fields', () => {
  assert.throws(
    () => normalizeToolRequest({ agentify_tool: 'codex.run', id: 'nope', key: 'k', mode: 'batch', args: {} }),
    /missing_or_invalid_id/
  );
  assert.throws(() => normalizeToolRequest({ agentify_tool: '', id: '11111111-1111-4111-8111-111111111111', key: 'k' }), /missing_tool/);
});

