import type { PaseoAgentHandle } from "@getpaseo/client";
import { hash } from "./contracts.ts";

export type TimelineObservation = Awaited<ReturnType<PaseoAgentHandle["timeline"]["refetch"]>>;
export function timelineReadbackHash(page: TimelineObservation): string {
  return hash({ entries: page.entries, head: page.endCursor, start: page.startCursor });
}
export async function observedTimeline(
  handle: PaseoAgentHandle,
  projection: "canonical" | "projected",
  reached?: (entries: TimelineObservation["entries"]) => boolean,
): Promise<TimelineObservation> {
  let page = await handle.timeline.refetch({ direction: "tail", limit: 200, projection });
  if (page.error || page.gap || page.hasNewer) throw Error("TIMELINE_HISTORY_INCOMPLETE");
  const tail = page;
  const entries = [...page.entries];
  const cursors = new Set<string>();
  while (page.hasOlder) {
    if (reached?.(entries)) break;
    const cursor = page.startCursor;
    if (!cursor || cursors.has(hash(cursor)) || cursors.size >= 20)
      throw Error("TIMELINE_HISTORY_INCOMPLETE");
    cursors.add(hash(cursor));
    const older = await handle.timeline.refetch({
      direction: "before",
      cursor,
      limit: 200,
      projection,
    });
    if (older.error || older.gap || (older.startCursor && older.startCursor.epoch !== cursor.epoch))
      throw Error("TIMELINE_HISTORY_INCOMPLETE");
    entries.unshift(...older.entries);
    page = older;
  }
  return {
    ...tail,
    agent: page.agent,
    entries,
    startCursor: page.startCursor,
    hasOlder: page.hasOlder,
  };
}
