/**
 * Plain-text excerpt from a markdown body for card previews. Skips a leading
 * H1 (it duplicates the title), takes the first non-empty line, strips the
 * common inline/line markers, and truncates. Intentionally cheap — not a full
 * markdown parser.
 */
export function bodyExcerpt(body: string, maxLen = 120): string {
  const lines = body.split('\n').map((l) => l.trim());
  for (const line of lines) {
    if (!line) continue;
    if (/^#\s/.test(line)) continue;
    const text = line
      .replace(/^[-*+]\s+/, '')
      .replace(/^>\s+/, '')
      .replace(/^#+\s+/, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/`(.*?)`/g, '$1')
      .replace(/\[(.*?)\]\(.*?\)/g, '$1')
      .trim();
    if (!text) continue;
    return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  }
  return '';
}
