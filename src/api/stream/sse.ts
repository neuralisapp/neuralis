export type SseFrame = { event?: string; data?: unknown };

export function parseSseFrames(chunk: string): SseFrame[] {
  const frames: SseFrame[] = [];
  const blocks = chunk.split('\n\n');
  for (const block of blocks) {
    if (!block.trim()) continue;
    let eventName: string | undefined;
    let dataRaw = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        if (dataRaw.length > 0) dataRaw += '\n';
        let content = line.slice(5);
        if (content.startsWith(' ')) content = content.slice(1);
        dataRaw += content;
      }
    }
    if (dataRaw.length === 0) {
      frames.push({ event: eventName });
      continue;
    }
    let data: unknown = dataRaw;
    try { data = JSON.parse(dataRaw); } catch { /* keep raw string */ }
    frames.push({ event: eventName, data });
  }
  return frames;
}

export async function* iterateSseStream(res: Response): AsyncGenerator<SseFrame, void, unknown> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lastSep = buffer.lastIndexOf('\n\n');
      if (lastSep >= 0) {
        const chunk = buffer.slice(0, lastSep + 2);
        buffer = buffer.slice(lastSep + 2);
        for (const frame of parseSseFrames(chunk)) yield frame;
      }
    }
    if (buffer.trim()) {
      for (const frame of parseSseFrames(buffer)) yield frame;
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}
