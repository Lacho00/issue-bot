export function splitMessage(text, max = 4096) {
  if (text.length <= max) return [text];
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > max) {
      if (current) { parts.push(current); current = ''; }
      for (let i = 0; i < line.length; i += max) parts.push(line.slice(i, i + max));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > max) { parts.push(current); current = line; }
    else current = candidate;
  }
  if (current) parts.push(current);
  return parts;
}
