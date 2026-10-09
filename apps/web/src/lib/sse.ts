export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** Splits what has arrived of an event stream into whole events and the unfinished rest (to be joined with the next chunk). */
export const takeSseEvents = (buffer: string): { events: SseEvent[]; rest: string } => {
  const events: SseEvent[] = [];
  const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
};
