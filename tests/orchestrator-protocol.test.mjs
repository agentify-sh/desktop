import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAgentifyToolBlocks, normalizeToolRequest, findOldestUnHandled } from '../orchestrator/protocol.mjs';

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

test('orchestrator/protocol: finds oldest unhandled for key', () => {
  const blocks = [
    { agentify_tool: 'codex.run', id: '11111111-1111-4111-8111-111111111111', key: 'k', mode: 'batch', args: {} },
    { agentify_tool: 'codex.run', id: '22222222-2222-4222-8222-222222222222', key: 'k', mode: 'batch', args: {} },
    { agentify_tool: 'codex.run', id: '33333333-3333-4333-8333-333333333333', key: 'other', mode: 'batch', args: {} }
  ];
  const handled = new Set(['11111111-1111-4111-8111-111111111111']);
  const oldest = findOldestUnHandled(blocks, (key, id) => (key === 'k' ? handled.has(id) : false), { keyFilter: 'k' });
  assert.equal(oldest.id, '22222222-2222-4222-8222-222222222222');
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
