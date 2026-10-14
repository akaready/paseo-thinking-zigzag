import type { usePaseo } from "@getpaseo/plugin/client";
import { thoughtData, toolData, type ItemData, type ToolCall } from "./items";
import type { FoldKey, Step } from "./web";

type Paseo = ReturnType<typeof usePaseo>;
type Page = Awaited<ReturnType<ReturnType<Paseo["agents"]["ref"]>["timeline"]["refetch"]>>;
type Entry = Page["entries"][number];

const PAGE_SIZE = 200;

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
  const timeline = paseo.agents.ref(agentId).timeline;
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
