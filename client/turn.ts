import type { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { thoughtData, toolData, type ItemData, type ToolCall } from "./items";
import type { FoldKey, Step } from "./web";

type Paseo = ReturnType<typeof usePaseo>;
type Timeline = ReturnType<Paseo["agents"]["ref"]>["timeline"];
type Page = Awaited<ReturnType<Timeline["refetch"]>>;
type Entry = Page["entries"][number];

const PAGE_SIZE = 200;

/** The agent's whole timeline, read back page by page from its newest entry. */
async function fetchAll(timeline: Timeline) {
  let page = await timeline.refetch({ direction: "tail", limit: PAGE_SIZE, projection: "projected" });
  let entries = page.entries;
  while (page.hasOlder && page.startCursor) {
    page = await timeline.refetch({
      direction: "before",
      cursor: page.startCursor,
      limit: PAGE_SIZE,
      projection: "projected",
    });
    entries = [...page.entries, ...entries];
  }
  return entries;
}

function isAnchor({ item }: Entry, anchor: ItemData) {
  return anchor.kind === "tool"
    ? item.type === "tool_call" && item.callId === anchor.callId
    : item.type === "reasoning" && item.text === anchor.body;
}

function toStep({ item }: Entry, shown: boolean): Step<ItemData> | null {
  if (item.type === "assistant_message") return item.text.trim() ? { prose: item.text, shown } : null;
  const data =
    item.type === "reasoning"
      ? thoughtData(item.text, "complete")
      : item.type === "tool_call"
        ? toolData(item as ToolCall, "complete")
        : null;
  return data ? { item: data } : null;
}

/**
 * Reads the agent's timeline back from its newest entry until it holds the whole turn around
 * `anchor`, for turns that start above what the chat has loaded. Returns [] if it is not found.
 */
export async function fetchTurn(paseo: Paseo, agentId: string, anchor: ItemData) {
  const timeline = paseo.agents.ref(agentId).timeline;
  let page = await timeline.refetch({ direction: "tail", limit: PAGE_SIZE, projection: "projected" });
  let entries = page.entries;
  for (;;) {
    const at = entries.findLastIndex((entry) => isAnchor(entry, anchor));
    if (at >= 0) {
      let start = at;
      while (start > 0 && entries[start - 1]!.item.type !== "user_message") start -= 1;
      if (start > 0 || !page.hasOlder) {
        let end = at;
        while (end + 1 < entries.length && entries[end + 1]!.item.type !== "user_message") end += 1;
        const turn = entries.slice(start, end + 1);
        const latest = turn.findLastIndex(
          ({ item }) => item.type === "assistant_message" && !!item.text.trim(),
        );
        return turn.flatMap((entry, index) => toStep(entry, index === latest) ?? []);
      }
    }
    if (!page.hasOlder || !page.startCursor) return [];
    page = await timeline.refetch({
      direction: "before",
      cursor: page.startCursor,
      limit: PAGE_SIZE,
      projection: "projected",
    });
    entries = [...page.entries, ...entries];
  }
}

/**
 * Every agent message that a later message in its turn supersedes, read from the agent's whole
 * timeline, so the chat can fold those messages before it shows them.
 */
export async function fetchSupersededMessages(paseo: Paseo, agentId: string) {
  const entries = await fetchAll(paseo.agents.ref(agentId).timeline);
  const superseded: FoldKey[] = [];
  let messages: Entry[] = [];
  const endTurn = () => {
    for (const { item, timestamp } of messages.slice(0, -1)) {
      if (item.type !== "assistant_message") continue;
      const text = item.text.trim();
      superseded.push(
        item.messageId
          ? { messageId: item.messageId, text }
          : { createdAt: Date.parse(timestamp), text },
      );
    }
    messages = [];
  };
  for (const entry of entries) {
    if (entry.item.type === "user_message") endTurn();
    else if (entry.item.type === "assistant_message") messages.push(entry);
  }
  endTurn();
  return superseded;
}

// Off the web a row cannot see the page around it, so it reads its neighbors from the agent's
// timeline: loaded once per agent, shared by its rows, and kept current from live events.
const SETTLE_MS = 250;
const IDLE_MS = 30_000;

interface Watched {
  entries: Entry[];
  /** When the timeline was last read; 0 until the first read. */
  readAt: number;
  rows: Set<() => void>;
  idle: ReturnType<typeof setTimeout> | null;
  stop: () => void;
}

const watched = new Map<string, Watched>();

function watch(paseo: Paseo, agentId: string): Watched {
  const existing = watched.get(agentId);
  if (existing) return existing;
  const timeline = paseo.agents.ref(agentId).timeline;
  const state: Watched = { entries: [], readAt: 0, rows: new Set(), idle: null, stop: () => {} };
  watched.set(agentId, state);
  const read = (entries: Entry[]) => {
    state.entries = entries;
    state.readAt = Date.now();
    state.rows.forEach((row) => row());
  };
  const readAll = () => fetchAll(timeline).then(read, () => {});
  // The newest page replaces what it overlaps; a gap wider than a page reads the whole timeline.
  const readTail = async () => {
    const page = await timeline.refetch({ direction: "tail", limit: PAGE_SIZE, projection: "projected" });
    const first = page.entries[0]?.seqStart;
    const last = state.entries[state.entries.length - 1]?.seqEnd;
    if (first === undefined) return read(page.entries);
    if (page.hasOlder && last !== undefined && first > last + 1) return readAll();
    read([...state.entries.filter((entry) => entry.seqStart < first), ...page.entries]);
  };
  let settle: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = timeline.subscribe((message) => {
    const type = message.event.type;
    if (type === "error") return;
    if (type === "replacement" || type === "subscription_restored") return void readAll();
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => void readTail().catch(() => {}), SETTLE_MS);
  });
  void readAll();
  state.stop = () => {
    if (settle) clearTimeout(settle);
    unsubscribe();
    watched.delete(agentId);
  };
  return state;
}

/** The agent's timeline, re-rendering on every read. Off the web only: null when not `enabled`. */
export function useAgentTimeline(paseo: Paseo, agentId: string, enabled: boolean) {
  const [, setReads] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const state = watch(paseo, agentId);
    if (state.idle) clearTimeout(state.idle);
    state.idle = null;
    const row = () => setReads((reads) => reads + 1);
    state.rows.add(row);
    if (state.readAt) row();
    return () => {
      state.rows.delete(row);
      // Rows unmount and mount again as the chat scrolls, so the timeline is kept a while.
      if (!state.rows.size) state.idle = setTimeout(state.stop, IDLE_MS);
    };
  }, [paseo, agentId, enabled]);
  return enabled ? (watched.get(agentId) ?? null) : null;
}

/**
 * What this plugin shows for a timeline entry: its item; "hidden" for one it shows nothing for (an
 * empty thought or message); null for one Paseo draws itself, which ends a stretch of items.
 */
function itemOf({ item }: Entry): ItemData | "hidden" | null {
  if (item.type === "reasoning") return thoughtData(item.text, "complete") ?? "hidden";
  if (item.type === "tool_call") {
    const call = item as ToolCall;
    return toolData(call, call.status === "running" ? "streaming" : "complete");
  }
  if (item.type === "assistant_message" && !item.text.trim()) return "hidden";
  return null;
}

/** Where a row's item is in the timeline: a tool call by its ID, a thought by its text and time. */
function findItem(entries: Entry[], data: ItemData, at: number) {
  if (data.kind === "tool") {
    return entries.findLastIndex(
      ({ item }) => item.type === "tool_call" && (item as ToolCall).callId === data.callId,
    );
  }
  let found = -1;
  let best = Infinity;
  entries.forEach(({ item, timestamp }, index) => {
    if (item.type !== "reasoning") return;
    const gap = Math.abs(Date.parse(timestamp) - at);
    const same = item.text.trim() === data.body.trim();
    // A thought still streaming may not match its text yet, so a close time stands in for it.
    if (!same && gap > 5_000) return;
    const score = (same ? 0 : 1e9) + gap;
    if (score < best) [found, best] = [index, score];
  });
  return found;
}

/**
 * The stretch of items around a row's item: everything this plugin draws, up to the nearest entry
 * Paseo draws itself. Its first item leads and draws the stretch as one line. Null when the item
 * is not in the timeline (yet).
 */
export function stretchOf(entries: Entry[], data: ItemData, at: number) {
  const index = findItem(entries, data, at);
  if (index < 0) return null;
  let start = index;
  while (start > 0 && itemOf(entries[start - 1]!) !== null) start -= 1;
  let end = index;
  while (end + 1 < entries.length && itemOf(entries[end + 1]!) !== null) end += 1;
  const items: ItemData[] = [];
  let first = -1;
  for (let i = start; i <= end; i += 1) {
    const item = itemOf(entries[i]!);
    if (!item || item === "hidden") continue;
    if (first < 0) first = i;
    items.push(item);
  }
  return { leads: first === index, items };
}
