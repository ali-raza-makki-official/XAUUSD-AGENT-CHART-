/**
 * WhatsApp renders *bold*, _italic_, ~strike~ and `mono`, plus plain "- " and "1." lists. It does not render
 * markdown headings, **double-star bold**, tables, links in [text](url) form or code fences. This turns
 * typical model markdown into text that reads cleanly in a chat bubble. It never changes numbers or wording.
 */
export function formatForWhatsApp(input: string): string {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  for (let line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) { out.push(line); continue; }
    if (/^\s*\|?[\s:|-]{3,}\|?\s*$/.test(line) && line.includes('-')) continue; // table separator row
    if (line.includes('|') && /^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean);
      line = `- ${cells.join(' · ')}`;
    }
    line = line
      .replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/, '*$1*')
      .replace(/^\s*[*•]\s+/, '- ')
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/__(.+?)__/g, '_$1_')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
      .replace(/[ \t]+$/g, '');
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
