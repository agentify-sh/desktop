function chunkByChars(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return [s];
  const out = [];
  let i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + maxChars));
    i += maxChars;
  }
  return out;
}

export function formatResultBlock(resultObj) {
  return `\n\`\`\`json\n${JSON.stringify(resultObj, null, 2)}\n\`\`\`\n`;
}

export function makeChunkedMessages({ header, body, maxChars = 25_000 }) {
  const parts = chunkByChars(body, maxChars);
  if (parts.length === 1) return [`${header}\n\n${parts[0]}`.trim()];
  return parts.map((p, idx) => `${header} (Part ${idx + 1}/${parts.length})\n\n${p}`.trim());
}

