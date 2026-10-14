import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, useRevealedText } from "@getpaseo/plugin/client/react-native";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Animated, Easing, Platform, Pressable, Text, View } from "react-native";
import { CATEGORIES, type ItemData } from "./items";
import { fetchSupersededMessages, fetchTurn, stretchOf, useAgentTimeline } from "./turn";
import {
  ITEM_ROW_TEST_ID,
  foldMessages,
  holdChatScroll,
  markRunOpen,
  measureClearance,
  onPressOutside,
  publishItem,
  trackRun,
  watchLayout,
  type Run,
  type Step,
} from "./web";

const OPEN_MS = 280;
const CLOSE_MS = 200;
/** Distance from the middle of a closed line to the content shown above it and below it. */
const CLEARANCE = 30;
/** The furthest a line's margins move, which bounds any misreading of the layout. */
const clamp = (margin: number) => Math.max(-64, Math.min(64, margin));
const EASE_OPEN = Easing.bezier(0.2, 0, 0, 1);
const EASE_CLOSE = Easing.bezier(0.3, 0, 1, 1);
/** Paseo's phone and tablet apps, where a row cannot see the page around it. */
const NATIVE = Platform.OS !== "web";
const useNativeDriver = NATIVE;
const MONOSPACE = Platform.select({
  web: "ui-monospace, SFMono-Regular, Menlo, monospace",
  ios: "Menlo",
  default: "monospace",
});

/** Side of the square whose two borders, turned 45 degrees, draw one peak of the zig-zag. */
const PEAK = 6;
const PEAK_STEP = PEAK * Math.SQRT2;
const ZIGZAG_HEIGHT = PEAK_STEP / 2 + 2;

const NOUNS: Record<ItemData["category"], [string, string]> = {
  thought: ["thought", "thoughts"],
  command: ["command", "commands"],
  edit: ["edit", "edits"],
  read: ["read", "reads"],
  search: ["search", "searches"],
  agent: ["subagent", "subagents"],
  tool: ["tool call", "tool calls"],
};

/** Counts get a "+" when the turn starts above what is loaded. */
function summarize(items: ItemData[], partial: boolean, messages = 0) {
  const counts = new Map<ItemData["category"], number>();
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  const count = (n: number, [one, many]: [string, string]) =>
    `${n}${partial ? "+" : ""} ${n === 1 && !partial ? one : many}`;
  return [
    ...(messages ? [count(messages, ["message", "messages"])] : []),
    ...CATEGORIES.flatMap((category) => {
      const n = counts.get(category);
      return n ? [count(n, NOUNS[category])] : [];
    }),
  ].join(" · ");
}

/** A stretch of work and the agent message that announced it. */
interface Section {
  heading: string;
  /** The announcing message, when it folded out of the chat; empty when it is still shown. */
  message: string;
  items: ItemData[];
}

// Agents usually end a message by saying what they will do next, so the last sentence of the
// message before a stretch of work names it best.
function headingFrom(prose: string) {
  const plain = prose
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.split(/(?<=[.!?:])\s+(?=[A-Z0-9"'(])/);
  return sentences[sentences.length - 1] ?? plain;
}

function sectionize(steps: Step<ItemData>[]) {
  const sections: Section[] = [];
  let blocks: Extract<Step<ItemData>, { prose: string }>[] = [];
  let current: Section | null = null;
  const open = () => {
    const last = blocks[blocks.length - 1];
    current = {
      heading: last ? headingFrom(last.prose) : "",
      message: blocks
        .filter((block) => !block.shown)
        .map((block) => block.prose)
        .join("\n\n"),
      items: [],
    };
    sections.push(current);
    blocks = [];
    return current;
  };
  for (const step of steps) {
    if ("prose" in step) {
      // A message that is only an image does not start a new section.
      if (!headingFrom(step.prose)) continue;
      current = null;
      blocks.push(step);
      continue;
    }
    (current ?? open()).items.push(step.item);
  }
  // A folded message with no work after it still belongs in the thread.
  if (blocks.some((block) => !block.shown)) open();
  return sections;
}

type Styles = ReturnType<typeof createStyles>;

/**
 * Off the web: the row's stretch of items, read from the agent's timeline. Its first row draws it.
 * A row not found in a timeline read since it mounted draws itself, as each row once did.
 */
function nativeSteps(
  timeline: ReturnType<typeof useAgentTimeline>,
  data: ItemData,
  at: number,
  mountedAt: number,
): Step<ItemData>[] {
  if (!timeline?.readAt) return [];
  const stretch = stretchOf(timeline.entries, data, at);
  if (stretch) return stretch.leads ? stretch.items.map((item) => ({ item })) : [];
  return timeline.readAt > mountedAt ? [{ item: data }] : [];
}

// Every thought and tool call is its own timeline row. Rows stay empty and take no space, except
// the first row of each turn, which draws the whole turn as one line. Off the web, where messages
// stay in the chat, the first row of each stretch between messages draws that stretch.
export function ItemRow({ agentId, item, timestamp, theme, layout }: PluginTimelineItemProps<ItemData>) {
  const rowRef = useRef<View>(null);
  // undefined until measured; null off the web.
  const [run, setRun] = useState<Run<ItemData> | null>();
  const runKey = useRef("");
  const dataKey = JSON.stringify(item.data);
  // Messages that later ones supersede fold before Paseo shows them, so scrolling through history
  // does not show each one and then collapse it. Read once per agent.
  const paseo = usePaseo();
  const superseded = useQuery({
    queryKey: ["thinking-zigzag", "superseded", agentId],
    queryFn: () => fetchSupersededMessages(paseo, agentId),
    enabled: !NATIVE,
    staleTime: Infinity,
  });
  const timeline = useAgentTimeline(paseo, agentId, NATIVE);
  const mountedAt = useRef(Date.now());
  useEffect(() => {
    if (superseded.data) foldMessages(superseded.data);
  }, [superseded.data]);

  // dataKey stands in for item.data, which is a fresh object on every render.
  useEffect(() => publishItem(rowRef.current, item.data), [dataKey]);
  useEffect(
    () =>
      trackRun<ItemData>(rowRef.current, (next) => {
        const key = JSON.stringify(next);
        if (key === runKey.current) return;
        runKey.current = key;
        setRun(next);
      }),
    [],
  );

  const steps = NATIVE
    ? nativeSteps(timeline, item.data, timestamp.getTime(), mountedAt.current)
    : run?.leads
      ? run.steps
      : [];
  return (
    <View ref={rowRef} testID={ITEM_ROW_TEST_ID}>
      {steps.some((step) => "item" in step) ? (
        <RunLine
          agentId={agentId}
          steps={steps}
          partial={run?.partial ?? false}
          rowRef={rowRef}
          theme={theme}
          compact={layout.compact}
        />
      ) : null}
    </View>
  );
}

function RunLine({
  agentId,
  steps: loaded,
  partial: loadedPartial,
  rowRef,
  theme,
  compact,
}: {
  agentId: string;
  steps: Step<ItemData>[];
  partial: boolean;
  rowRef: RefObject<View | null>;
  theme: PluginTheme;
  compact: boolean;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  // A turn that starts above what the chat has loaded is read whole from the agent's timeline.
  const paseo = usePaseo();
  const anchor = loaded.flatMap((step) => ("item" in step ? [step.item] : [])).at(-1)!;
  const fetched = useQuery({
    queryKey: ["thinking-zigzag", "turn", agentId, anchor.kind, anchor.callId || anchor.body],
    queryFn: () => fetchTurn(paseo, agentId, anchor),
    enabled: loadedPartial,
    staleTime: Infinity,
  });
  const whole = loadedPartial && fetched.data?.length ? fetched.data : null;
  const steps = whole ?? loaded;
  const partial = loadedPartial && !whole;
  const items = steps.flatMap((step) => ("item" in step ? [step.item] : []));
  const sections = sectionize(steps);
  const summary = summarize(items, partial, sections.filter((section) => section.message).length);
  const failed = items.filter((item) => item.failed).length;
  const running = items.some((item) => item.phase === "streaming");
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(false);
  // The panel stays mounted until its close animation ends.
  const [mounted, setMounted] = useState(false);
  const [panelHeight, setPanelHeight] = useState(0);
  const [height] = useState(() => new Animated.Value(0));
  const lineRef = useRef<View>(null);
  // Margins that center the closed line between the content around it, whatever padding
  // Paseo gives those rows. Each measurement moves them by the remaining difference.
  const [space, setSpace] = useState({ top: 0, bottom: 16 });
  const [reveal] = useState(() => new Animated.Value(0));
  const [pulse] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (!running) return;
    const breathe = (toValue: number) =>
      Animated.timing(pulse, {
        toValue,
        duration: 650,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver,
      });
    const loop = Animated.loop(Animated.sequence([breathe(0.35), breathe(1)]));
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(1);
    };
  }, [pulse, running]);

  useEffect(() => {
    if (!open) return;
    const row = rowRef.current;
    const release = holdChatScroll(row);
    const unsubscribe = onPressOutside(row, () => setOpen(false));
    return () => {
      unsubscribe();
      release(CLOSE_MS);
    };
  }, [open, rowRef]);

  useEffect(() => {
    if (mounted) return;
    return watchLayout(rowRef.current, () => {
      const clearance = measureClearance(rowRef.current, lineRef.current);
      if (!clearance) return;
      // The same distance on both sides, as close as hover-only controls above allow.
      const target = Math.max(CLEARANCE, clearance.leastAbove);
      setSpace((current) => {
        const adjust = (value: number, distance: number | null) =>
          distance === null ? value : clamp(value + target - distance);
        const top = adjust(current.top, clearance.above);
        const bottom = adjust(current.bottom, clearance.below);
        const settled = Math.abs(top - current.top) < 1 && Math.abs(bottom - current.bottom) < 1;
        return settled ? current : { top, bottom };
      });
    });
  }, [mounted, rowRef]);

  // This row keeps the turn's line until the panel has fully closed, even if the turn grows.
  useEffect(() => {
    if (!mounted) return;
    const row = rowRef.current;
    markRunOpen(row, true);
    return () => markRunOpen(row, false);
  }, [mounted, rowRef]);

  // Opening mounts the panel and waits for its measured height before moving anything, and
  // any later change in that height, from a section or tool output opening, animates too.
  useEffect(() => {
    if (open) {
      setMounted(true);
      if (!panelHeight) return;
    }
    const target = open ? 1 : 0;
    const timing = (value: Animated.Value, toValue: number) =>
      Animated.timing(value, {
        toValue,
        duration: open ? OPEN_MS : CLOSE_MS,
        easing: open ? EASE_OPEN : EASE_CLOSE,
        useNativeDriver: false,
      });
    const animation = Animated.parallel([
      timing(height, open ? panelHeight : 0),
      timing(reveal, target),
    ]);
    animation.start(({ finished }) => {
      if (finished && !open) {
        setMounted(false);
        setPanelHeight(0);
      }
    });
    return () => animation.stop();
  }, [open, panelHeight, height, reveal]);

  const lit = hovered || open;
  const zigzagColor = lit ? theme.colors.foregroundMuted : theme.colors.border;
  const slide = reveal.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] });

  return (
    <View style={{ marginTop: space.top, marginBottom: space.bottom }}>
      <Pressable
        ref={lineRef}
        accessibilityRole="button"
        accessibilityLabel={failed ? `${summary}, ${failed} failed` : summary}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={styles.line}
      >
        <Zigzag color={zigzagColor} fromLabel="right" />
        <Animated.View style={[styles.label, lit ? styles.labelLit : null, { opacity: pulse }]}>
          <Text numberOfLines={1} style={styles.labelText}>
            {summary}
            {failed ? <Text style={styles.failed}>{` · ${failed} failed`}</Text> : null}
          </Text>
        </Animated.View>
        <Zigzag color={zigzagColor} fromLabel="left" />
      </Pressable>
      <Animated.View style={[styles.reveal, { height, opacity: reveal }]}>
        {mounted ? (
          <Animated.View
            style={[styles.measure, { transform: [{ translateY: slide }] }]}
            onLayout={(event) => setPanelHeight(event.nativeEvent.layout.height)}
          >
            <View style={[styles.panel, sections.length > 1 ? styles.contents : null]}>
              {partial ? (
                <Text style={styles.note}>
                  This turn starts above what is loaded. Scroll up to include its earlier steps.
                </Text>
              ) : null}
              {sections.length === 1 ? (
                <SectionBody section={sections[0]!} styles={styles} theme={theme} />
              ) : (
                sections.map((section, index) => (
                  <SectionRow key={index} section={section} styles={styles} theme={theme} />
                ))
              )}
            </View>
          </Animated.View>
        ) : null}
      </Animated.View>
    </View>
  );
}

/** Peaks run from the label out to the edge, which clips them. */
function Zigzag({ color, fromLabel }: { color: string; fromLabel: "left" | "right" }) {
  const [width, setWidth] = useState(0);
  const peaks = Math.ceil(width / PEAK_STEP);
  return (
    <View style={zigzagStyles.track} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {Array.from({ length: peaks }, (_, index) => (
        <View
          key={index}
          style={[
            zigzagStyles.peak,
            { borderColor: color, [fromLabel]: index * PEAK_STEP + PEAK_STEP / 2 - PEAK / 2 },
          ]}
        />
      ))}
    </View>
  );
}

// Collapsed sections read as the turn's table of contents; open one to see its steps.
function SectionRow({
  section,
  styles,
  theme,
}: {
  section: Section;
  styles: Styles;
  theme: PluginTheme;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const failed = section.items.filter((item) => item.failed).length;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={[styles.sectionHeader, hovered ? styles.sectionHeaderLit : null]}
      >
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
        <Text numberOfLines={1} style={styles.sectionTitle}>
          {section.heading || "Before the first reply"}
        </Text>
        <Text numberOfLines={1} style={styles.sectionCounts}>
          {summarize(section.items, false)}
          {failed ? <Text style={styles.failed}>{` · ${failed} failed`}</Text> : null}
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.sectionItems}>
          <SectionBody section={section} styles={styles} theme={theme} />
        </View>
      ) : null}
    </View>
  );
}

function SectionBody({
  section,
  styles,
  theme,
}: {
  section: Section;
  styles: Styles;
  theme: PluginTheme;
}) {
  return (
    <>
      {section.message ? (
        <Text selectable style={styles.message}>
          {section.message}
        </Text>
      ) : null}
      <Items items={section.items} styles={styles} theme={theme} />
    </>
  );
}

function Items({ items, styles, theme }: { items: ItemData[]; styles: Styles; theme: PluginTheme }) {
  return (
    <>
      {items.map((item, index) =>
        item.kind === "thought" ? (
          <Thought key={index} item={item} styles={styles} />
        ) : (
          <Tool key={index} item={item} styles={styles} theme={theme} />
        ),
      )}
    </>
  );
}

function Thought({ item, styles }: { item: ItemData; styles: Styles }) {
  const text = useRevealedText(item.body, item.phase).trim();
  return text ? (
    <Text selectable style={styles.thought}>
      {text}
    </Text>
  ) : null;
}

function Tool({ item, styles, theme }: { item: ItemData; styles: Styles; theme: PluginTheme }) {
  const [open, setOpen] = useState(false);
  const color = item.failed ? theme.colors.statusDanger : theme.colors.foreground;
  return (
    <View style={styles.tool}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        disabled={!item.body}
        onPress={() => setOpen((value) => !value)}
        style={styles.toolHeader}
      >
        <View style={item.body ? null : styles.hidden}>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={color} />
        </View>
        <Text selectable numberOfLines={open ? undefined : 1} style={[styles.toolTitle, { color }]}>
          {item.title}
        </Text>
      </Pressable>
      {open ? (
        <Text selectable style={styles.toolBody}>
          {item.body}
        </Text>
      ) : null}
    </View>
  );
}

const zigzagStyles = {
  track: { flex: 1, height: ZIGZAG_HEIGHT, overflow: "hidden" as const },
  peak: {
    position: "absolute" as const,
    top: PEAK_STEP / 2 - PEAK / 2 + 1,
    width: PEAK,
    height: PEAK,
    borderTopWidth: 1.25,
    borderLeftWidth: 1.25,
    transform: [{ rotate: "45deg" }],
  },
};

function createStyles(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  return {
    line: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      paddingVertical: 4,
    },
    label: {
      marginHorizontal: 8,
      paddingHorizontal: 10,
      paddingVertical: 3,
      borderRadius: 999,
    },
    labelLit: { backgroundColor: colors.surface2 },
    labelText: { color: colors.foregroundMuted, fontSize: 12.5, lineHeight: 18 },
    failed: { color: colors.statusDanger },
    reveal: { overflow: "hidden" as const },
    // Laid out out of flow so its height can be measured while the reveal is still closed.
    measure: { position: "absolute" as const, top: 0, left: 0, right: 0, paddingVertical: 6 },
    panel: {
      gap: 10,
      paddingHorizontal: compact ? 12 : 14,
      paddingVertical: compact ? 10 : 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface1,
    },
    note: { color: colors.foregroundMuted, fontSize: 12.5, lineHeight: 18 },
    message: { color: colors.foreground, fontSize: 14, lineHeight: 21 },
    sectionHeader: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      marginHorizontal: -6,
      paddingHorizontal: 6,
      paddingVertical: 5,
      borderRadius: 6,
    },
    contents: { gap: 2 },
    sectionHeaderLit: { backgroundColor: colors.surface2 },
    sectionTitle: { flex: 1, color: colors.foreground, fontSize: 13.5, lineHeight: 19 },
    sectionCounts: { flexShrink: 0, color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    sectionItems: { gap: 10, paddingTop: 6, paddingBottom: 8, paddingLeft: 22 },
    thought: { color: colors.foregroundMuted, fontSize: 14, lineHeight: 21 },
    tool: { gap: 6 },
    toolHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    hidden: { opacity: 0 },
    toolTitle: { flex: 1, fontSize: 12.5, lineHeight: 18, fontFamily: MONOSPACE },
    toolBody: {
      marginLeft: 20,
      color: colors.foregroundMuted,
      fontSize: 12,
      lineHeight: 17,
      fontFamily: MONOSPACE,
    },
  };
}
