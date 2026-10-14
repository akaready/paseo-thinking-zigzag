import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ITEM_KIND, itemSchema, thoughtItem, toolItem } from "./client/items";
import { ItemRow } from "./client/run";
import { installStyles } from "./client/web";

export default function contribute(client: PluginClientContext) {
  const removeStyles = installStyles();
  client.addTimelineTransformer({
    id: "thoughts",
    query: { itemType: "reasoning" },
    transform: ({ item, phase }) => thoughtItem(item, phase),
  });
  client.addTimelineTransformer({
    id: "tool-calls",
    query: { itemType: "tool_call" },
    transform: ({ item, phase }) => toolItem(item, phase),
  });
  client.addTimelineRenderer({
    kind: ITEM_KIND,
    version: 1,
    schema: itemSchema,
    Component: ItemRow,
  });
  return removeStyles;
}
