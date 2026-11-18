import type { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { thoughtData, toolData, type ItemData, type ToolCall } from "./items";
import { foldMessages, turnsChanged, type FoldKey, type Step, type TurnMarks } from "./web";

type Paseo = ReturnType<typeof usePaseo>;
type Timeline = ReturnType<Paseo["agents"]["ref"]>["timeline"];
type Page = Awaited<ReturnType<Timeline["refetch"]>>;
type Entry = Page["entries"][number];

const PAGE_SIZE = 200;

/** The turn the agent is working in when a page is read: null when idle, undefined when the host does not say. */
function activeTurnOf(page: Page) {
  const active = page.agent?.activeTurn;
  return active ? active.turnId : active;
}

/** The agent's whole timeline, read back page by page from its newest entry. */
async function fetchAll(timeline: Timeline) {
  let page = await timeline.refetch({ direction: "tail", limit: PAGE_SIZE, projection: "projected" });
  const active = activeTurnOf(page);
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
  return { entries, active };
}

/** Whether an entry sets the agent to work: a message from a user or another agent, a heartbeat, or word that a background task finished. */
function startsWork(item: Entry["item"]) {
  if (item.type === "user_message") return true;
  if (item.type !== "tool_call") return false;
  const call = item as ToolCall & { agentMessage?: unknown };
  return (
    call.agentMessage !== undefined || call.name === "heartbeat" || call.name === "task_notification"
  );
}

/**
 * For each entry, whether it starts a turn. A user message always does in the chat, and so does
 * the entry after it. The agent also starts turns on its own, when a background task or subagent
 * finishes, which only the turn ID shows. Paseo leaves some entries out of every turn, such as the
 * word that a background task finished: one that sets the agent to work goes with the turn after
 * it, any other with the turn before it, so that no such entry joins two turns into one. Entries
 * from a host that sends no turn IDs run until the next one that sets the agent to work.
 */
function turnStarts(entries: Entry[]) {
  const turns = entries.map((entry) => entry.turnId);
  for (let index = 1; index < turns.length; index += 1) {
    if (turns[index] === undefined && !startsWork(entries[index]!.item)) turns[index] = turns[index - 1];
  }
  for (let index = turns.length - 2; index >= 0; index -= 1) turns[index] ??= turns[index + 1];
  return entries.map((entry, index) => {
    const before = entries[index - 1];
    if (!before || entry.item.type === "user_message" || before.item.type === "user_message") return true;
    const [turn, turnBefore] = [turns[index], turns[index - 1]];
    return turn !== undefined && turnBefore !== undefined ? turn !== turnBefore : startsWork(entry.item);
  });
}

function isAnchor({ item }: Entry, anchor: ItemData) {
  return anchor.kind === "tool"
    ? item.type === "tool_call" && item.callId === anchor.callId
    : item.type === "reasoning" && item.text === anchor.body;
}

function toStep({ item, timestamp }: Entry, shown: boolean): Step<ItemData> | null {
  if (item.type === "assistant_message") return item.text.trim() ? { prose: item.text, shown } : null;
  const data =
    item.type === "reasoning"
      ? thoughtData(item.text, "complete")
      : item.type === "tool_call"
        ? toolData(item as ToolCall, "complete")
        : null;
  return data ? { item: { ...data, at: Date.parse(timestamp) } } : null;
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
      const starts = turnStarts(entries);
      let start = at;
      while (!starts[start]) start -= 1;
      if (start > 0 || !page.hasOlder) {
        let end = at;
        while (end + 1 < entries.length && !starts[end + 1]) end += 1;
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

/** A row's item as the timeline names it: a tool call by its ID, a thought by its text. */
export function itemKey(data: ItemData) {
  return data.kind === "tool" ? data.callId : `thought:${data.body.trim()}`;
}

/** The key of the chat row that shows an entry; null for an entry this plugin does not look for. */
function entryKey(entry: Entry) {
  const { item, timestamp } = entry;
  if (item.type === "assistant_message") {
    return item.text.trim() ? (item.messageId ?? `created:${Date.parse(timestamp)}`) : null;
  }
  const shown = itemOf(entry);
  return shown && shown !== "hidden" ? itemKey(shown) : null;
}

/**
 * What the timeline says about its turns: the last row of each one that has ended, and every agent
 * message that a later message in its own turn supersedes, so the chat can fold those before it
 * shows them. Also notes each message's turn in `messageTurn`. The latest turn has ended when it
 * is not `active`, the turn the agent is working in.
 */
function turnsIn(
  entries: Entry[],
  active: string | null | undefined,
  messageTurn: Map<string, string>,
) {
  const ends = new Set<string>();
  const superseded: FoldKey[] = [];
  // The turn's messages, and which of them is the latest. Paseo stores one message as several
  // entries when something else lands in the middle of it, so entries with one key are one
  // message: its parts stay together, and none of them supersedes another.
  let messages: (FoldKey & { key: string })[] = [];
  let latestMessage: string | null = null;
  let last: string | null = null;
  const closeTurn = (ended: boolean) => {
    if (ended && last) ends.add(last);
    for (const { key, ...message } of messages) {
      if (key !== latestMessage) superseded.push({ ...message, text: message.text.trim() });
    }
    messages = [];
    latestMessage = null;
    last = null;
  };
  const starts = turnStarts(entries);
  entries.forEach((entry, index) => {
    if (index > 0 && starts[index]) closeTurn(true);
    const { item, timestamp } = entry;
    const key = entryKey(entry);
    // A message with no text has no row, so it supersedes nothing.
    if (item.type === "assistant_message" && key) {
      const earlier = messages.find((message) => message.key === key);
      if (earlier) earlier.text += item.text;
      else {
        const id = item.messageId ? { messageId: item.messageId } : { createdAt: Date.parse(timestamp) };
        messages.push({ key, text: item.text, ...id });
      }
      latestMessage = key;
      if (item.messageId && entry.turnId) messageTurn.set(item.messageId, entry.turnId);
    }
    last = key ?? last;
  });
  const latest = entries[entries.length - 1]?.turnId;
  closeTurn(active !== undefined && latest !== undefined && latest !== active);
  return { ends, superseded };
}

// A row cannot see the agent's turns, and off the web it cannot see the page around it either, so
// both come from the agent's timeline: loaded once per agent, shared by its rows, and kept current
// from live events.
const SETTLE_MS = 250;
const IDLE_MS = 30_000;

interface Watched {
  entries: Entry[];
  /** When the timeline was last read; 0 until the first read. */
  readAt: number;
  turns: TurnMarks;
  rows: Set<() => void>;
  idle: ReturnType<typeof setTimeout> | null;
  stop: () => void;
}

const watched = new Map<string, Watched>();

function watch(paseo: Paseo, agentId: string): Watched {
  const existing = watched.get(agentId);
  if (existing) return existing;
  const timeline = paseo.agents.ref(agentId).timeline;
  const state: Watched = {
    entries: [],
    readAt: 0,
    turns: { ends: new Set(), messageTurn: new Map() },
    rows: new Set(),
    idle: null,
    stop: () => {},
  };
  watched.set(agentId, state);
  // Every turn seen so far, so a new one is noticed as it starts.
  const turnsSeen = new Set<string>();
  const read = (entries: Entry[], active: string | null | undefined) => {
    state.entries = entries;
    state.readAt = Date.now();
    for (const { turnId } of entries) if (turnId) turnsSeen.add(turnId);
    const { ends, superseded } = turnsIn(entries, active, state.turns.messageTurn);
    state.turns.ends = ends;
    foldMessages(superseded);
    turnsChanged();
    state.rows.forEach((row) => row());
  };
  const readAll = () =>
    fetchAll(timeline).then(
      ({ entries, active }) => read(entries, active),
      () => {},
    );
  // The newest page replaces what it overlaps; a gap wider than a page reads the whole timeline.
  const readTail = async () => {
    const page = await timeline.refetch({ direction: "tail", limit: PAGE_SIZE, projection: "projected" });
    const first = page.entries[0]?.seqStart;
    const last = state.entries[state.entries.length - 1]?.seqEnd;
    if (first === undefined) return read(page.entries, activeTurnOf(page));
    if (page.hasOlder && last !== undefined && first > last + 1) return readAll();
    read(
      [...state.entries.filter((entry) => entry.seqStart < first), ...page.entries],
      activeTurnOf(page),
    );
  };
  let settle: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = timeline.subscribe((message) => {
    const event = message.event;
    if (event.type === "error") return;
    if (event.type === "replacement" || event.type === "subscription_restored") return void readAll();
    if (settle) clearTimeout(settle);
    const turnId = event.type === "timeline" || event.type === "turn_started" ? event.turnId : undefined;
    if (turnId !== undefined) {
      // A message's turn is known as it starts, so the one before it in that turn folds at once.
      if (event.type === "timeline" && event.item.type === "assistant_message" && event.item.messageId) {
        state.turns.messageTurn.set(event.item.messageId, turnId);
        turnsChanged();
      }
      // A new turn means the one before it has ended. Where it ended is read now, before the
      // new turn's rows show.
      if (!turnsSeen.has(turnId)) {
        turnsSeen.add(turnId);
        return void readTail().catch(() => {});
      }
    }
    settle = setTimeout(() => void readTail().catch(() => {}), SETTLE_MS);
  });
  // The newest page covers what a chat shows when it opens, so it is read before the rest.
  void readTail().then(readAll, readAll);
  state.stop = () => {
    if (settle) clearTimeout(settle);
    unsubscribe();
    watched.delete(agentId);
  };
  return state;
}

/** What the agent's timeline says about its turns; null until a row of that agent is on screen. */
export function turnsOf(agentId: string) {
  return watched.get(agentId)?.turns ?? null;
}

/** The agent's timeline, re-rendering on every read. */
export function useAgentTimeline(paseo: Paseo, agentId: string) {
  const [, setReads] = useState(0);
  useEffect(() => {
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
  }, [paseo, agentId]);
  return watched.get(agentId) ?? null;
}

/**
 * What this plugin shows for a timeline entry: its item; "hidden" for one it shows nothing for (an
 * empty thought or message); null for one Paseo draws itself, which ends a stretch of items.
 */
function itemOf({ item, timestamp }: Entry): ItemData | "hidden" | null {
  if (item.type === "reasoning") {
    const data = thoughtData(item.text, "complete");
    return data ? { ...data, at: Date.parse(timestamp) } : "hidden";
  }
  if (item.type === "tool_call") {
    const call = item as ToolCall;
    const data = toolData(call, call.status === "running" ? "streaming" : "complete");
    return data ? { ...data, at: Date.parse(timestamp) } : null;
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
