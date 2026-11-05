import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import {
  Fragment,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Animated, Dimensions, Easing, Image, Platform, Pressable, ScrollView, Text, TextInput, View, type ImageStyle, type StyleProp, type ViewStyle } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { ItemData } from "./items";
import { readScreenshot } from "../shared/screenshot";
import type { ReactNode } from "react";
import { chatColumn, onKeys, onPressOutside, readSetting, writeSetting } from "./web";

export type Category = ItemData["category"];

/** A stretch of work and the agent message that announced it. */
export interface Section {
  heading: string;
  message: string;
  items: ItemData[];
}

export interface FocusRequest {
  /** A type of step to focus on. */
  kind: Category;
  id: number;
}

const MONO = Platform.select({
  web: "ui-monospace, SFMono-Regular, Menlo, monospace",
  ios: "Menlo",
  default: "monospace",
});

export const TYPE_ORDER: Category[] = [
  "read",
  "thought",
  "command",
  "edit",
  "search",
  "agent",
  "tool",
];

const GROUP_LABEL: Record<Category, string> = {
  read: "Reads",
  thought: "Thinking",
  command: "Commands",
  edit: "Edits",
  search: "Searches",
  agent: "Subagents",
  tool: "Other",
};

const NOUNS: Record<Category, [string, string]> = {
  read: ["read", "reads"],
  thought: ["thought", "thoughts"],
  command: ["command", "commands"],
  edit: ["edit", "edits"],
  search: ["search", "searches"],
  agent: ["subagent", "subagents"],
  tool: ["tool call", "tool calls"],
};

type Target = "icon" | "text" | "code" | "zigs";
const TARGETS: Target[] = ["icon", "text", "code", "zigs"];
const TARGET_LABEL: Record<Target, string> = {
  icon: "Icon",
  text: "Text",
  code: "Code",
  zigs: "Zigs",
};

interface ThemePalette {
  name: string;
  colors: Record<Category, string>;
}

export const THEMES: Record<string, ThemePalette> = {
  paseo: {
    name: "Paseo",
    colors: {
      read: "#7fb3e8", thought: "#a89bf0", command: "#7ccba0", edit: "#e0b374",
      search: "#6fc9c1", agent: "#d59be0", tool: "#c9a3a3",
    },
  },
  github: {
    name: "GitHub Dark",
    colors: {
      read: "#79c0ff", thought: "#d2a8ff", command: "#7ee787", edit: "#ffa657",
      search: "#56d4dd", agent: "#ff9bce", tool: "#c9d1d9",
    },
  },
  dracula: {
    name: "Dracula",
    colors: {
      read: "#8be9fd", thought: "#bd93f9", command: "#50fa7b", edit: "#f1fa8c",
      search: "#ff79c6", agent: "#ffb86c", tool: "#f8f8f2",
    },
  },
  nord: {
    name: "Nord",
    colors: {
      read: "#88c0d0", thought: "#b48ead", command: "#a3be8c", edit: "#ebcb8b",
      search: "#8fbcbb", agent: "#d08770", tool: "#d8dee9",
    },
  },
  solarized: {
    name: "Solarized Dark",
    colors: {
      read: "#268bd2", thought: "#6c71c4", command: "#859900", edit: "#b58900",
      search: "#2aa198", agent: "#d33682", tool: "#93a1a1",
    },
  },
  oneDark: {
    name: "One Dark",
    colors: {
      read: "#61afef", thought: "#c678dd", command: "#98c379", edit: "#e5c07b",
      search: "#56b6c2", agent: "#e06c75", tool: "#abb2bf",
    },
  },
  tokyo: {
    name: "Tokyo Night",
    colors: {
      read: "#7aa2f7", thought: "#bb9af7", command: "#9ece6a", edit: "#e0af68",
      search: "#7dcfff", agent: "#ff9e64", tool: "#a9b1d6",
    },
  },
};

export interface Prefs {
  view: "timeline" | "type";
  previews: boolean;
  durations: boolean;
  shots: boolean;
  theme: string;
  colors: string[];
  overrides: Record<string, string>;
}

const PREFS_KEY = "thinking-zigzag:prefs";

function loadPrefs(): Prefs {
  const fallback: Prefs = {
    view: "timeline",
    previews: false,
    durations: true,
    shots: false,
    theme: "paseo",
    colors: [],
    overrides: {},
  };
  const raw = readSetting(PREFS_KEY);
  if (!raw) return fallback;
  try {
    const saved = JSON.parse(raw) as Partial<Prefs>;
    return {
      view: saved.view === "type" ? "type" : "timeline",
      previews: !!saved.previews,
      durations: saved.durations !== false,
      shots: !!saved.shots,
      theme: saved.theme && THEMES[saved.theme] ? saved.theme : "paseo",
      colors: Array.isArray(saved.colors) ? saved.colors.filter((key) => typeof key === "string") : [],
      overrides: saved.overrides && typeof saved.overrides === "object" ? saved.overrides : {},
    };
  } catch {
    return fallback;
  }
}

const PREFS = loadPrefs();
const prefsListeners = new Set<() => void>();

function savePrefs(patch: Partial<Prefs>, notify = true) {
  Object.assign(PREFS, patch);
  writeSetting(PREFS_KEY, JSON.stringify(PREFS));
  if (notify) prefsListeners.forEach((listener) => listener());
}

export function usePrefs(): Prefs {
  const [, force] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const listener = () => force();
    prefsListeners.add(listener);
    return () => {
      prefsListeners.delete(listener);
    };
  }, []);
  return PREFS;
}

export function isOn(prefs: Prefs, kind: Category, target: Target) {
  return prefs.colors.includes(kind + ":" + target);
}

export function typeColor(prefs: Prefs, kind: Category) {
  return prefs.overrides[kind] ?? (THEMES[prefs.theme] ?? THEMES.paseo!).colors[kind];
}

export function summaryPartColor(prefs: Prefs, kind: SummaryKind, fallback: string) {
  return kind !== "screenshot" && isOn(prefs, kind, "zigs") ? typeColor(prefs, kind) : fallback;
}

/** A summary part: a type of step to focus on, or the turn's screenshots, which only count. */
export type SummaryKind = Category | "screenshot";

function shotNoun(count: number) {
  return count + (count === 1 ? " screenshot" : " screenshots");
}

export function summaryParts(sections: Section[]): { kind: SummaryKind; text: string }[] {
  const counts = new Map<Category, number>();
  let shots = 0;
  for (const section of sections) {
    for (const item of visibleItems(section.items)) {
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
      if (item.screenshot) shots += 1;
    }
  }
  const parts: { kind: SummaryKind; text: string }[] = TYPE_ORDER.flatMap((kind) => {
    const count = counts.get(kind);
    if (!count) return [];
    return [{ kind, text: count + " " + NOUNS[kind][count === 1 ? 0 : 1] }];
  });
  if (shots) parts.push({ kind: "screenshot", text: shotNoun(shots) });
  return parts;
}

function countsText(items: ItemData[]) {
  const counts = new Map<Category, number>();
  let shots = 0;
  for (const item of visibleItems(items)) {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    if (item.screenshot) shots += 1;
  }
  const parts = TYPE_ORDER.flatMap((kind) => {
    const count = counts.get(kind);
    return count ? [count + " " + NOUNS[kind][count === 1 ? 0 : 1]] : [];
  });
  if (shots) parts.push(shotNoun(shots));
  return parts.join(" · ");
}

function formatDuration(seconds: number) {
  if (seconds < 60) return Math.max(1, Math.round(seconds)) + "s";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? minutes + "m " + rest + "s" : minutes + "m";
}

function splitTitle(item: ItemData) {
  if (item.category === "command") return { label: "", code: item.title };
  if (item.category === "read" || item.category === "edit" || item.category === "search") {
    const match = /^(\S+)\s+(.*)$/.exec(item.title);
    if (match) return { label: match[1]!, code: match[2]! };
  }
  return { label: item.title, code: "" };
}

function thoughtPreview(item: ItemData) {
  const full = item.body.trim();
  if (!full) return item.title;
  const first = /^.*?[.!?:](?=\s|$)/.exec(full)?.[0] ?? full;
  return first.trim();
}

function thoughtRest(item: ItemData) {
  if (item.kind !== "thought") return "";
  const full = item.body.trim();
  if (!full) return "";
  const start = thoughtPreview(item);
  if (full.startsWith(start)) return full.slice(start.length).trim();
  return full;
}

function visibleItems(items: ItemData[]) {
  return items.filter((item) => item.kind !== "thought" || thoughtPreview(item) !== "");
}

function hexToRgb(hex: string) {
  let body = hex.replace("#", "");
  if (body.length === 3) body = body.split("").map((c) => c + c).join("");
  const value = parseInt(body, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255] as const;
}

function rgbToHsl(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)] as const;
}

function hexToHsla(hex: string) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  return "hsla(" + h + ", " + s + "%, " + l + "%, 1)";
}

function hslToHex(h: number, s: number, l: number) {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0; let g = 0; let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (value: number) => Math.round((value + m) * 255).toString(16).padStart(2, "0");
  return "#" + to(r) + to(g) + to(b);
}

function parseHsla(value: string) {
  const match = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(value.trim());
  if (!match) return null;
  return hslToHex(Number(match[1]), Number(match[2]), Number(match[3]));
}

interface DiffLine { text: string; no: number }
interface DiffRow { kind: "hunk" | "pair"; text?: string; left?: DiffLine | null; right?: DiffLine | null }

function parseDiff(text: string): DiffRow[] {
  const lines = text.split("\n");
  const rows: DiffRow[] = [];
  let leftNo = 0;
  let rightNo = 0;
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  let hunks = 0;
  const flush = () => {
    const count = Math.max(dels.length, adds.length);
    for (let i = 0; i < count; i += 1) {
      rows.push({ kind: "pair", left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("@@")) {
      flush();
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      leftNo = match ? Number(match[1]) : 1;
      rightNo = match ? Number(match[2]) : 1;
      rows.push({ kind: "hunk", text: line });
      hunks += 1;
      continue;
    }
    if (line.startsWith("-")) {
      dels.push({ text: line.slice(1), no: leftNo++ });
      continue;
    }
    if (line.startsWith("+")) {
      adds.push({ text: line.slice(1), no: rightNo++ });
      continue;
    }
    flush();
    const clean = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({
      kind: "pair",
      left: { text: clean, no: leftNo++ },
      right: { text: clean, no: rightNo++ },
    });
  }
  flush();
  return hunks ? rows : [];
}

export function Panel({
  agentId,
  sections,
  theme,
  compact,
  focusRequest,
  shotsOnly = false,
}: {
  agentId: string;
  sections: Section[];
  theme: PluginTheme;
  compact: boolean;
  focusRequest: FocusRequest | null;
  /** Only the screenshot strip, whose thumbnails open the lightbox directly on the web. */
  shotsOnly?: boolean;
}) {
  const prefs = usePrefs();
  const cwd = useAgent(agentId, (agent) => agent.cwd) ?? "";
  const [openShot, setOpenShot] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [view, setViewState] = useState<"timeline" | "type">(PREFS.view);
  const [previews, setPreviewsState] = useState(PREFS.previews);
  const [durations, setDurationsState] = useState(PREFS.durations);
  const [shots, setShotsState] = useState(PREFS.shots);
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const [, bump] = useReducer((value: number) => value + 1, 0);
  const allItems = useMemo(() => sections.flatMap((section) => visibleItems(section.items)), [sections]);
  const shotItems = useMemo(() => allItems.filter((item) => item.screenshot && item.path), [allItems]);
  const shotPaths = useMemo(() => [...new Set(shotItems.map((item) => item.path))], [shotItems]);
  const shotIndex = lightbox ? shotPaths.indexOf(lightbox) : -1;
  // The lightbox covers the chat column only, measured when it opens.
  const [column, setColumn] = useState<{ left: number; width: number } | null>(null);
  const openLightbox = (path: string) => {
    setColumn(chatColumn(panelRef.current));
    setLightbox(path);
  };

  // Arrow keys step through the turn's screenshots while the lightbox is open; Escape closes it.
  useEffect(() => {
    if (!lightbox) return;
    return onKeys((key) => {
      if (key === "Escape") return setLightbox(null);
      const next = shotPaths[shotIndex + (key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0)];
      if (next) setLightbox(next);
    });
  }, [lightbox, shotIndex, shotPaths]);
  const sectionsOpen = useRef(new Set<number>(view === "type" ? sections.map((_, i) => i) : []));
  // Sections the Type view has already opened. A section that arrives later, while the turn
  // streams, opens too, so Type shows every section's kinds as the mock does.
  const seenSections = useRef(new Set<number>(view === "type" ? sections.map((_, i) => i) : []));
  const groupsOpen = useRef(new Set<string>());
  const itemsOpen = useRef(new Set<string>());
  const layerDir = useRef<"expand" | "collapse">("expand");
  const focused = useRef<Category | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const settingsAnim = useRef(new Animated.Value(0)).current;
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuUp, setMenuUp] = useState(false);
  const [menuMax, setMenuMax] = useState(340);
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const paletteRef = useRef<View>(null);
  const cogRef = useRef<View>(null);
  const [picker, setPicker] = useState<Category | null>(null);
  const [hexValue, setHexValue] = useState("#ffffff");
  const [hslaValue, setHslaValue] = useState("hsla(0, 0%, 100%, 1)");
  const toast = useToast();
  const panelRef = useRef<View>(null);
  const menuRef = useRef<View>(null);
  const [portalToBody, setPortalToBody] = useState<((node: ReactNode) => ReactNode) | null>(null);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    let alive = true;
    import("react-dom").then((mod) => {
      if (!alive) return;
      setPortalToBody(() => (node: ReactNode) => mod.createPortal(node, document.body));
    }, () => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    return onPressOutside(menuRef.current, () => setMenuOpen(false), [paletteRef.current, cogRef.current]);
  }, [menuOpen]);

  function toggleSettings() {
    if (settingsOpen) {
      setSettingsOpen(false);
      setMenuOpen(false);
      Animated.timing(settingsAnim, {
        toValue: 0,
        duration: 120,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start(({ finished }) => {
        if (finished) setSettingsMounted(false);
      });
    } else {
      setSettingsOpen(true);
      setSettingsMounted(true);
      Animated.timing(settingsAnim, {
        toValue: 1,
        duration: 160,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start();
    }
  }

  const groupKey = (si: number, kind: Category) => si + ":" + kind;
  const itemKey = (si: number, ii: number) => si + ":" + ii;
  const kindsOf = (section: Section) =>
    TYPE_ORDER.filter((kind) => visibleItems(section.items).some((item) => item.category === kind));
  const sectionItemKeys = (si: number) => sections[si]!.items.map((_, ii) => itemKey(si, ii));
  const sectionGroupKeys = (si: number) => kindsOf(sections[si]!).map((kind) => groupKey(si, kind));
  const groupItemKeys = (si: number, kind: Category) => itemIndices(si, kind).map((ii) => itemKey(si, ii));
  const itemIndices = (si: number, kind: Category) =>
    sections[si]!.items.flatMap((item, ii) =>
      item.category === kind && visibleItems([item]).length ? [ii] : [],
    );

  const labelColor = (kind: Category, failed: boolean) =>
    failed
      ? theme.colors.statusDanger
      : isOn(prefs, kind, "text")
        ? typeColor(prefs, kind)
        : kind === "thought"
          ? theme.colors.foregroundMuted
          : theme.colors.foreground;
  const codeColor = (kind: Category, failed: boolean) =>
    failed
      ? theme.colors.statusDanger
      : isOn(prefs, kind, "code")
        ? typeColor(prefs, kind)
        : theme.colors.foregroundMuted;
  const iconColor = (kind: Category, failed: boolean) =>
    failed
      ? theme.colors.statusDanger
      : isOn(prefs, kind, "icon")
        ? typeColor(prefs, kind)
        : theme.colors.foregroundMuted;

  // A header click walks one layer down, and once everything under it is open, the next click
  // closes all of it at once. The icon beside the title always opens or closes everything.
  function sectionFull(si: number) {
    return sectionsOpen.current.has(si) &&
      sectionItemKeys(si).every((key) => itemsOpen.current.has(key)) &&
      (view === "timeline" || sectionGroupKeys(si).every((key) => groupsOpen.current.has(key)));
  }
  function setSectionAll(si: number, open: boolean) {
    const groups = sectionGroupKeys(si);
    const items = sectionItemKeys(si);
    const apply = (set: Set<string | number>, keys: (string | number)[]) =>
      keys.forEach((key) => (open ? set.add(key) : set.delete(key)));
    if (open) sectionsOpen.current.add(si);
    else sectionsOpen.current.delete(si);
    apply(groupsOpen.current, groups);
    apply(itemsOpen.current, items);
  }
  function advanceSection(si: number) {
    if (sectionFull(si)) return setSectionAll(si, false);
    if (!sectionsOpen.current.has(si)) return sectionsOpen.current.add(si);
    if (view === "type" && sectionGroupKeys(si).some((key) => !groupsOpen.current.has(key))) {
      return sectionGroupKeys(si).forEach((key) => groupsOpen.current.add(key));
    }
    sectionItemKeys(si).forEach((key) => itemsOpen.current.add(key));
  }

  function groupFull(si: number, kind: Category) {
    return groupsOpen.current.has(groupKey(si, kind)) &&
      groupItemKeys(si, kind).every((key) => itemsOpen.current.has(key));
  }
  function setGroupAll(si: number, kind: Category, open: boolean) {
    if (open) groupsOpen.current.add(groupKey(si, kind));
    else groupsOpen.current.delete(groupKey(si, kind));
    groupItemKeys(si, kind).forEach((key) => (open ? itemsOpen.current.add(key) : itemsOpen.current.delete(key)));
  }
  function advanceGroup(si: number, kind: Category) {
    if (groupFull(si, kind)) return setGroupAll(si, kind, false);
    if (!groupsOpen.current.has(groupKey(si, kind))) return groupsOpen.current.add(groupKey(si, kind));
    groupItemKeys(si, kind).forEach((key) => itemsOpen.current.add(key));
  }

  function focusKind(kind: Category) {
    if (view !== "type" || focused.current !== kind) {
      setViewState("type");
      savePrefs({ view: "type" }, false);
      sectionsOpen.current = new Set(sections.map((_, i) => i));
      seenSections.current = new Set(sections.map((_, i) => i));
      groupsOpen.current = new Set();
      itemsOpen.current = new Set();
      sections.forEach((section, si) => {
        if (section.items.some((item) => item.category === kind)) {
          groupsOpen.current.add(groupKey(si, kind));
        }
      });
      focused.current = kind;
      layerDir.current = "expand";
    } else {
      sections.forEach((section, si) => {
        if (section.items.some((item) => item.category === kind)) advanceGroup(si, kind);
      });
      syncLayer();
    }
    bump();
  }

  useEffect(() => {
    if (view !== "type") return;
    let added = false;
    sections.forEach((_, i) => {
      if (seenSections.current.has(i)) return;
      seenSections.current.add(i);
      sectionsOpen.current.add(i);
      added = true;
    });
    if (added) bump();
  }, [sections, view]);

  useEffect(() => {
    if (!focusRequest) return;
    focusKind(focusRequest.kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.id]);

  // Opening the turn from its line should show work, not an empty carriage.
  useEffect(() => {
    if (focusRequest) return;
    if (view === "timeline" && sections.length && sectionsOpen.current.size === 0) {
      sectionsOpen.current.add(0);
      bump();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function syncLayer() {
    if (fullyExpanded()) layerDir.current = "collapse";
    else if (fullyCollapsed()) layerDir.current = "expand";
  }

  function allSectionsOpen() {
    return sections.every((_, i) => sectionsOpen.current.has(i));
  }
  function allGroupsOpen() {
    return sections.every((section, si) =>
      kindsOf(section).every((kind) => groupsOpen.current.has(groupKey(si, kind))),
    );
  }
  function allItemsOpen() {
    return sections.every((section, si) =>
      section.items.every((_, ii) => itemsOpen.current.has(itemKey(si, ii))),
    );
  }
  function fullyExpanded() {
    return allSectionsOpen() && allItemsOpen() && (view === "timeline" || allGroupsOpen());
  }
  function fullyCollapsed() {
    return sectionsOpen.current.size === 0 && groupsOpen.current.size === 0 && itemsOpen.current.size === 0;
  }
  function expandOneLayer() {
    if (!allSectionsOpen()) {
      sectionsOpen.current = new Set(sections.map((_, i) => i));
      return true;
    }
    if (view === "type" && !allGroupsOpen()) {
      sections.forEach((section, si) => kindsOf(section).forEach((kind) => groupsOpen.current.add(groupKey(si, kind))));
      return true;
    }
    if (!allItemsOpen()) {
      sections.forEach((section, si) => section.items.forEach((_, ii) => itemsOpen.current.add(itemKey(si, ii))));
      return true;
    }
    return false;
  }
  // Expands one layer at a time. Once everything is open, the next click closes it all at once.
  function stepEverything() {
    if (fullyExpanded()) {
      sectionsOpen.current.clear();
      groupsOpen.current.clear();
      itemsOpen.current.clear();
    } else {
      expandOneLayer();
    }
    syncLayer();
    bump();
  }

  function setView(next: "timeline" | "type") {
    if (next === view) return;
    setViewState(next);
    savePrefs({ view: next }, false);
    focused.current = null;
    groupsOpen.current = new Set();
    itemsOpen.current = new Set();
    sectionsOpen.current = new Set(next === "type" ? sections.map((_, i) => i) : []);
    seenSections.current = new Set(next === "type" ? sections.map((_, i) => i) : []);
    layerDir.current = "expand";
    bump();
  }

  function toggleItem(si: number, ii: number) {
    const key = itemKey(si, ii);
    if (itemsOpen.current.has(key)) itemsOpen.current.delete(key);
    else itemsOpen.current.add(key);
    syncLayer();
    bump();
  }

  function togglePreview(si: number) {
    sectionsOpen.current.add(si);
    layerDir.current = "expand";
    bump();
  }

  function toggleTarget(kind: Category, target: Target) {
    const key = kind + ":" + target;
    const next = prefs.colors.includes(key)
      ? prefs.colors.filter((entry) => entry !== key)
      : [...prefs.colors, key];
    savePrefs({ colors: next });
  }
  function toggleColumn(target: Target) {
    const kinds = TYPE_ORDER.filter((kind) => !(kind === "thought" && target === "code"));
    const all = kinds.every((kind) => prefs.colors.includes(kind + ":" + target));
    const next = new Set(prefs.colors);
    kinds.forEach((kind) => {
      const key = kind + ":" + target;
      if (all) next.delete(key); else next.add(key);
    });
    savePrefs({ colors: [...next] });
  }
  function toggleRow(kind: Category) {
    const targets = TARGETS.filter((target) => !(kind === "thought" && target === "code"));
    const all = targets.every((target) => prefs.colors.includes(kind + ":" + target));
    const next = new Set(prefs.colors);
    targets.forEach((target) => {
      const key = kind + ":" + target;
      if (all) next.delete(key); else next.add(key);
    });
    savePrefs({ colors: [...next] });
  }

  function openPicker(kind: Category) {
    setPicker(kind);
    const hex = typeColor(prefs, kind);
    setHexValue(hex);
    setHslaValue(hexToHsla(hex));
  }
  function setOverride(kind: Category, value: string) {
    savePrefs({ overrides: { ...prefs.overrides, [kind]: value } });
  }
  function revert(kind: Category) {
    const overrides = { ...prefs.overrides };
    delete overrides[kind];
    savePrefs({ overrides });
    const hex = typeColor(prefs, kind);
    setHexValue(hex);
    setHslaValue(hexToHsla(hex));
  }
  function onHexChange(value: string) {
    setHexValue(value);
    if (!picker) return;
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())) return;
    setOverride(picker, value.trim());
    setHslaValue(hexToHsla(value.trim()));
  }
  function onHslaChange(value: string) {
    setHslaValue(value);
    if (!picker) return;
    const hex = parseHsla(value);
    if (!hex) return;
    setOverride(picker, value.trim());
    setHexValue(hex);
  }

  function renderItems(section: Section, si: number, level: number, only?: Category) {
    const source = section.items.flatMap((item, ii) =>
      visibleItems([item]).length ? [{ item, ii }] : [],
    );
    const items = source.filter(({ item }) => (only ? item.category === only : true));
    return items.map(({ item, ii }, position) => {
      const next = items[position + 1]?.item;
      const seconds = item.at && next?.at ? Math.max(0, (next.at - item.at) / 1000) : null;
      return renderItem(item, si, ii, level, seconds);
    });
  }

  function renderItem(item: ItemData, si: number, ii: number, level: number, seconds: number | null) {
    const key = itemKey(si, ii);
    const shot = item.screenshot;
    if (shot && !shots) return null;
    const rest = thoughtRest(item);
    const expandable = item.kind === "thought" ? !!rest : !!(item.body.trim() || item.diff || shot);
    const open = expandable && itemsOpen.current.has(key);
    const title = item.kind === "thought" ? { label: thoughtPreview(item), code: "" } : splitTitle(item);
    const linkable = item.category === "read" || item.category === "edit";
    const duration = durations && seconds !== null && seconds >= 1 ? formatDuration(seconds) : null;
    const indent = 6 + level * 24;
    return (
      <View key={key}>
        <Pressable
          accessibilityRole={expandable ? "button" : undefined}
          accessibilityState={{ expanded: expandable ? open : undefined }}
          onPress={expandable ? () => toggleItem(si, ii) : undefined}
          style={({ pressed }) => [styles.itemRow, { paddingLeft: indent }, pressed && expandable ? styles.rowPressed : null]}
        >
          <View style={styles.iconSlot}>
            <Icon name={iconName(item.category)} size={14} color={iconColor(item.category, item.failed)} />
          </View>
          <View style={styles.titleRow}>
            {title.label ? (
              <Text numberOfLines={1} style={[styles.itemLabel, { color: labelColor(item.category, item.failed) }]}>
                {title.label}
              </Text>
            ) : null}
            {title.code ? (
              linkable ? (
                <FileLink
                  path={item.path || title.code}
                  color={codeColor(item.category, item.failed)}
                  styles={styles}
                  onPress={(path) => toast.show("Opening files from plugins isn't available yet: " + path)}
                />
              ) : (
                <Text numberOfLines={1} style={[styles.itemCode, { color: codeColor(item.category, item.failed) }]}>
                  {title.code}
                </Text>
              )
            ) : null}
          </View>
          {duration ? <Text style={styles.duration}>{duration}</Text> : null}
        </Pressable>
        {open ? (
          <View style={[styles.body, { paddingLeft: indent + 24 }]}>
            {shot ? (
              <ShotImage
                cwd={cwd}
                path={item.path}
                variant="full"
                onPress={Platform.OS === "web" ? () => openLightbox(item.path) : undefined}
                styles={styles}
              />
            ) : item.kind === "thought" ? (
              <Text style={[styles.thoughtBody, { color: labelColor(item.category, item.failed) }]}>{rest}</Text>
            ) : item.category === "edit" && item.diff ? (
              <DiffView text={item.diff} styles={styles} theme={theme} />
            ) : (
              <Text style={styles.pre}>{item.body}</Text>
            )}
          </View>
        ) : null}
      </View>
    );
  }

  function renderSection(section: Section, si: number) {
    const open = sectionsOpen.current.has(si);
    const sectionItems = visibleItems(section.items);
    return (
      <View key={si}>
        <Pressable
          onPress={() => { advanceSection(si); syncLayer(); bump(); }}
          style={({ pressed }) => [styles.sectionRow, pressed ? styles.rowPressed : null]}
        >
          <View style={styles.chevronSlot}>
            <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
          </View>
          <Text numberOfLines={1} style={styles.sectionTitle}>{section.heading || "Before the first reply"}</Text>
          <Text style={styles.counts}>{countsText(sectionItems)}</Text>
        </Pressable>
        {view === "timeline" ? (
          open ? (
            <View>{renderItems(section, si, 1)}</View>
          ) : previews && sectionItems.length ? (
            <View>
              {renderItems({ ...section, items: sectionItems.slice(0, 3) }, si, 1)}
              {sectionItems.length > 3 ? (
                <Pressable onPress={() => { togglePreview(si); }} style={styles.moreRow}>
                  <View style={styles.iconSlot}>
                    <Icon name="Plus" size={12} color={theme.colors.foregroundMuted} />
                  </View>
                  <Text style={styles.moreText}>
                    {sectionItems.length - 3} more · {countsText(sectionItems.slice(3))}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null
        ) : open ? (
          <View>
            {kindsOf(section).map((kind) => {
              const key = groupKey(si, kind);
              const groupOpen = groupsOpen.current.has(key);
              return (
                <Fragment key={kind}>
                  <Pressable
                    onPress={() => { advanceGroup(si, kind); syncLayer(); bump(); }}
                    style={({ pressed }) => [styles.groupRow, pressed ? styles.rowPressed : null]}
                  >
                    <View style={styles.chevronSlot}>
                      <Icon name={groupOpen ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
                    </View>
                    <View style={styles.iconSlot}>
                      <Icon name={iconName(kind)} size={14} color={iconColor(kind, false)} />
                    </View>
                    <Text style={[styles.groupLabel, { color: labelColor(kind, false) }]}>{GROUP_LABEL[kind]}</Text>
                    <Text style={styles.groupCount}>{sectionItems.filter((item) => item.category === kind).length}</Text>
                  </Pressable>
                  {groupOpen ? <View>{renderItems(section, si, 2, kind)}</View> : null}
                </Fragment>
              );
            })}
          </View>
        ) : null}
      </View>
    );
  }

  const windowSize = Dimensions.get("window");
  const menuStyle = (Platform.OS === "web" && anchor
    ? {
        ...styles.menu,
        position: "fixed" as const,
        right: "auto" as const,
        left: Math.max(12, Math.min(anchor.x + anchor.w - 300, windowSize.width - 312)),
        top: menuUp ? undefined : anchor.y + anchor.h + 6,
        bottom: menuUp ? windowSize.height - anchor.y + 6 : undefined,
        zIndex: 10000,
        elevation: 10000,
        maxHeight: menuMax,
      }
    : [styles.menu, menuUp ? { bottom: 34 } : { top: 34 }, { maxHeight: menuMax }]) as unknown as StyleProp<ViewStyle>;
  const menuBody = menuOpen ? (
    <View ref={menuRef} style={menuStyle}>
      <ScrollView style={[styles.menuScroll, { maxHeight: menuMax - 2 }]} contentContainerStyle={styles.menuContent} nestedScrollEnabled showsVerticalScrollIndicator={false}>
      <View style={styles.matrixHead}>
        <View style={styles.matrixType} />
        {TARGETS.map((target) => (
          <Pressable key={target} accessibilityLabel={"Toggle all " + TARGET_LABEL[target]} onPress={() => toggleColumn(target)} style={styles.headCell}>
            <Text style={styles.headText}>{TARGET_LABEL[target]}</Text>
          </Pressable>
        ))}
      </View>
      {TYPE_ORDER.map((kind) => (
        <Fragment key={kind}>
          <View style={styles.matrixRow}>
            <View style={styles.matrixType}>
              <Pressable accessibilityLabel={GROUP_LABEL[kind] + " colour"} onPress={() => openPicker(kind)} style={[styles.dot, { backgroundColor: typeColor(prefs, kind) }]} />
              <Pressable accessibilityLabel={"Toggle " + GROUP_LABEL[kind]} onPress={() => toggleRow(kind)} style={styles.typeButton}>
                <Text style={styles.typeLabel}>{GROUP_LABEL[kind]}</Text>
              </Pressable>
            </View>
            {TARGETS.map((target) => {
              const disabled = kind === "thought" && target === "code";
              const on = isOn(prefs, kind, target);
              return (
                <Pressable
                  key={target}
                  accessibilityLabel={GROUP_LABEL[kind] + " " + TARGET_LABEL[target]}
                  disabled={disabled}
                  onPress={() => toggleTarget(kind, target)}
                  style={[styles.cell, disabled ? styles.cellDisabled : null]}
                >
                  <View style={[styles.checkBox, on ? styles.checkBoxOn : null]}>
                    {on ? <Icon name="Check" size={10} color={theme.colors.surface0} /> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
          {picker === kind ? (
            <View style={styles.picker}>
              <View style={styles.pickerHead}>
                <View style={[styles.pickerSwatch, { backgroundColor: typeColor(prefs, kind) }]} />
                <Text style={styles.pickerTitle}>{GROUP_LABEL[kind]}</Text>
                <Pressable accessibilityLabel="Close colour picker" onPress={() => setPicker(null)} style={styles.pickerClose}>
                  <Icon name="X" size={13} color={theme.colors.foregroundMuted} />
                </Pressable>
              </View>
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Hex</Text>
                <TextInput
                  accessibilityLabel="Hex colour"
                  value={hexValue}
                  onChangeText={onHexChange}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  style={styles.fieldInput}
                />
              </View>
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>HSLA</Text>
                <TextInput
                  accessibilityLabel="HSLA colour"
                  value={hslaValue}
                  onChangeText={onHslaChange}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  style={styles.fieldInput}
                />
              </View>
              <Pressable
                accessibilityLabel="Revert colour"
                onPress={() => revert(kind)}
                disabled={!prefs.overrides[kind]}
                style={[styles.revert, !prefs.overrides[kind] ? styles.revertDisabled : null]}
              >
                <Text style={styles.revertText}>Revert</Text>
              </Pressable>
            </View>
          ) : null}
        </Fragment>
      ))}
      <View style={styles.themes}>
        <Text style={styles.themesLabel}>Theme</Text>
        <View style={styles.chips}>
          {Object.entries(THEMES).map(([key, palette]) => (
            <Pressable
              key={key}
              accessibilityLabel={palette.name + " theme"}
              onPress={() => {
                savePrefs({ theme: key, overrides: {} });
                setPicker(null);
              }}
              style={[styles.chip, prefs.theme === key ? styles.chipOn : null]}
            >
              <Text style={[styles.chipText, prefs.theme === key ? styles.chipTextOn : null]}>{palette.name}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      </ScrollView>
    </View>
  ) : null;
  const menu = menuBody ? (portalToBody ? portalToBody(menuBody) : menuBody) : null;
  // Web only: the enlarged screenshot sits in a layer over the whole window, so the chat cannot cover it.
  const lightboxArrow = (step: -1 | 1) => {
    const target = shotPaths[shotIndex + step];
    return (
      <Pressable
        accessibilityLabel={step < 0 ? "Previous screenshot" : "Next screenshot"}
        accessibilityState={{ disabled: !target }}
        onPress={(event) => {
          event.stopPropagation?.();
          if (target) setLightbox(target);
        }}
        style={[styles.lightboxArrow, target ? null : styles.lightboxArrowOff]}
      >
        <Icon name={step < 0 ? "ChevronLeft" : "ChevronRight"} size={24} color={target ? "#ffffff" : "#5c5c5c"} />
      </Pressable>
    );
  };
  const lightboxBody = lightbox ? (
    <Pressable
      accessibilityLabel="Close screenshot"
      onPress={() => setLightbox(null)}
      style={[styles.lightbox, column ? { left: column.left, right: undefined, width: column.width } : null]}
    >
      {/* Clicks on the image or its controls stay; only the backdrop around them closes. */}
      <Pressable accessible={false} onPress={(event) => event.stopPropagation?.()} style={styles.lightboxStage}>
        <ShotImage cwd={cwd} path={lightbox} variant="lightbox" styles={styles} />
        {shotPaths.length > 1 ? (
          // Arrows and count sit together under the image; an arrow at either end dims but keeps its place.
          <View style={styles.lightboxNav}>
            {lightboxArrow(-1)}
            <Text style={styles.lightboxCount}>{shotIndex + 1} / {shotPaths.length}</Text>
            {lightboxArrow(1)}
          </View>
        ) : null}
      </Pressable>
      <Pressable
        accessibilityLabel="Close"
        onPress={() => setLightbox(null)}
        style={[styles.lightboxArrow, styles.lightboxClose]}
      >
        <Icon name="X" size={22} color="#ffffff" />
      </Pressable>
    </Pressable>
  ) : null;
  const lightboxLayer = lightboxBody && portalToBody ? portalToBody(lightboxBody) : null;

  const strip = shotItems.length ? (
    <View style={[styles.strip, shotsOnly ? { marginBottom: 0 } : null]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stripRow}>
        {shotItems.map((item, index) => (
          <ShotPress
            key={index}
            thumb
            label={"Show screenshot " + item.path}
            selected={openShot === item.path || lightbox === item.path}
            onPress={() =>
              shotsOnly && Platform.OS === "web"
                ? openLightbox(item.path)
                : setOpenShot(openShot === item.path ? null : item.path)
            }
            styles={styles}
          >
            <ShotImage cwd={cwd} path={item.path} variant="thumb" styles={styles} />
          </ShotPress>
        ))}
      </ScrollView>
      {openShot ? (
        <ShotImage
          cwd={cwd}
          path={openShot}
          variant="full"
          onPress={Platform.OS === "web" ? () => openLightbox(openShot) : undefined}
          styles={styles}
        />
      ) : null}
    </View>
  ) : null;

  if (shotsOnly) {
    return (
      <View ref={panelRef} style={styles.root}>
        {strip}
        {lightboxLayer}
      </View>
    );
  }

  return (
    <View ref={panelRef} style={styles.root}>
      <View style={styles.panelbar}>
        <Text style={styles.stepCount}>{allItems.length} steps</Text>
        <View style={styles.controls}>
          {settingsMounted ? (
            <Animated.View
              style={[
                styles.settings,
                {
                  opacity: settingsAnim,
                  transform: [
                    {
                      translateX: settingsAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [10, 0],
                      }),
                    },
                  ],
                },
              ]}
            >
              <View style={styles.seg}>
                <View style={[styles.segHalf, view === "timeline" ? styles.segHalfOn : null]}>
                  <Pressable accessibilityLabel="Timeline view" onPress={() => setView("timeline")} style={styles.segBtn}>
                    <Icon name="List" size={13} color={view === "timeline" ? theme.colors.foreground : theme.colors.foregroundMuted} />
                    <Text style={[styles.segText, view === "timeline" ? styles.segTextOn : null]}>Timeline</Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel="Toggle step previews"
                    onPress={() => setPreviewsState((value) => { savePrefs({ previews: !value }, false); return !value; })}
                    disabled={view !== "timeline"}
                    style={[styles.eye, view !== "timeline" ? styles.eyeDisabled : null]}
                  >
                    <Icon name="Eye" size={14} color={previews && view === "timeline" ? theme.colors.foreground : theme.colors.foregroundMuted} />
                  </Pressable>
                </View>
                <Pressable accessibilityLabel="Type view" onPress={() => setView("type")} style={styles.segBtn}>
                  <Icon name="Layers" size={13} color={view === "type" ? theme.colors.foreground : theme.colors.foregroundMuted} />
                  <Text style={[styles.segText, view === "type" ? styles.segTextOn : null]}>Type</Text>
                </Pressable>
              </View>
              <View ref={paletteRef} style={styles.menuAnchor}>
                <Pressable
                  accessibilityLabel="Colour options"
                  onPress={() => {
                    if (menuOpen) {
                      setMenuOpen(false);
                      return;
                    }
                    paletteRef.current?.measureInWindow((_x, y, _w, h) => {
                      const viewport = Dimensions.get("window").height;
                      const below = viewport - (y + h) - 16;
                      const above = y - 16;
                      const up = below < 340 && above > below;
                      setAnchor({ x: _x, y, w: _w, h });
                      setMenuUp(up);
                      setMenuMax(Math.max(220, Math.min(420, up ? above : below)));
                      setMenuOpen(true);
                    });
                  }}
                  style={styles.toolBtn}
                >
                  <Icon name="Palette" size={14} color={menuOpen ? theme.colors.foreground : theme.colors.foregroundMuted} />
                </Pressable>
                {menu}
              </View>
              <Pressable
                accessibilityLabel="Toggle step durations"
                onPress={() => setDurationsState((value) => { savePrefs({ durations: !value }, false); return !value; })}
                style={styles.toolBtn}
              >
                <Icon name="Timer" size={14} color={durations ? theme.colors.foreground : theme.colors.foregroundMuted} />
              </Pressable>
              <Pressable
                accessibilityLabel="Toggle screenshots"
                onPress={() => setShotsState((value) => { savePrefs({ shots: !value }, false); return !value; })}
                style={styles.toolBtn}
              >
                <Icon name="Image" size={14} color={shots ? theme.colors.foreground : theme.colors.foregroundMuted} />
              </Pressable>
            </Animated.View>
          ) : null}
          <View ref={cogRef}>
            <Pressable
              accessibilityLabel="Turn settings"
              onPress={toggleSettings}
              style={[styles.toolBtn, settingsOpen ? styles.toolBtnOn : null]}
            >
              <Icon name="Settings" size={14} color={settingsOpen ? theme.colors.foreground : theme.colors.foregroundMuted} />
            </Pressable>
          </View>
          <Pressable accessibilityLabel={layerDir.current === "expand" ? "Expand one layer" : "Collapse all"} onPress={stepEverything} style={styles.toolBtn}>
            <Icon
              name={layerDir.current === "expand" ? "ChevronsDown" : "ChevronsUp"}
              size={14}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>
        </View>
      </View>
      {shots ? strip : null}
      <View>{sections.map((section, si) => renderSection(section, si))}</View>
      {lightboxLayer}
    </View>
  );
}

/** A screenshot the turn produced, read from the agent's directory on the daemon. */
function ShotImage({
  cwd,
  path,
  variant,
  onPress,
  styles,
}: {
  cwd: string;
  path: string;
  variant: "thumb" | "full" | "lightbox";
  onPress?: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  const read = useRpc(readScreenshot);
  const [ratio, setRatio] = useState(16 / 10);
  const maxEdge = variant === "thumb" ? 320 : undefined;
  const shot = useQuery({
    queryKey: ["thinking-zigzag", "shot", cwd, path, maxEdge ?? 0],
    queryFn: () => read({ cwd, path, maxEdge }),
    enabled: !!cwd,
    staleTime: Infinity,
  });
  if (!shot.data) {
    const name = path.split("/").pop() ?? path;
    const note = shot.isError ? "Could not load " + name : variant === "thumb" ? "" : "Loading";
    return (
      <View style={variant === "thumb" ? styles.thumbEmpty : [styles.shotFull, { aspectRatio: ratio }]}>
        <View style={styles.shotEmpty}>
          <Text numberOfLines={2} style={styles.shotNote}>{note}</Text>
        </View>
      </View>
    );
  }
  const image = (
    <Image
      accessibilityLabel={path}
      source={{ uri: "data:" + shot.data.mime + ";base64," + shot.data.base64 }}
      resizeMode={variant === "thumb" ? "cover" : "contain"}
      onLoad={(event) => {
        const size = event.nativeEvent.source;
        if (size?.width && size?.height) setRatio(size.width / size.height);
      }}
      style={
        variant === "thumb"
          ? styles.thumbImage
          : variant === "lightbox"
            ? styles.lightboxImage
            : [styles.shotFull, { aspectRatio: ratio }]
      }
    />
  );
  if (!onPress) return image;
  return (
    <ShotPress label={"Enlarge " + path} onPress={onPress} styles={styles}>
      {image}
    </ShotPress>
  );
}

/** A screenshot button that rings when the pointer is over it. */
function ShotPress({
  label,
  onPress,
  selected = false,
  thumb = false,
  styles,
  children,
}: {
  label: string;
  onPress: () => void;
  selected?: boolean;
  thumb?: boolean;
  styles: ReturnType<typeof createStyles>;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[
        thumb ? styles.thumb : styles.shotPress,
        styles.noOutline,
        hovered || focused ? styles.ringHover : null,
        selected ? styles.ringOn : null,
      ]}
    >
      {children}
    </Pressable>
  );
}

function FileLink({
  path,
  color,
  styles,
  onPress,
}: {
  path: string;
  color: string;
  styles: ReturnType<typeof createStyles>;
  onPress: (path: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={(event) => {
        event.stopPropagation?.();
        onPress(path);
      }}
    >
      <Text numberOfLines={1} style={[styles.itemCode, { color, textDecorationLine: hovered ? "underline" : "none" }]}>
        {path}
      </Text>
    </Pressable>
  );
}

function DiffView({
  text,
  styles,
  theme,
}: {
  text: string;
  styles: ReturnType<typeof createStyles>;
  theme: PluginTheme;
}) {
  const rows = useMemo(() => parseDiff(text), [text]);
  if (!rows.length) return <Text style={styles.pre}>{text}</Text>;
  return (
    <View style={styles.diff}>
      <View style={styles.diffHead}>
        <Text style={styles.diffHeadText}>Before</Text>
        <Text style={styles.diffHeadText}>After</Text>
      </View>
      {rows.map((row, index) => {
        if (row.kind === "hunk") {
          return (
            <View key={index} style={styles.diffHunk}>
              <Text style={styles.diffHunkText}>{row.text}</Text>
            </View>
          );
        }
        return (
          <View key={index} style={styles.diffRow}>
            <View style={[styles.diffCell, styles.diffCellLeft]}>
              {row.left ? (
                <>
                  <Text style={styles.diffNo}>{row.left.no}</Text>
                  <Text style={[styles.diffCode, { color: row.right ? theme.colors.foregroundMuted : theme.colors.statusDanger }]}>
                    {row.left.text}
                  </Text>
                </>
              ) : null}
            </View>
            <View style={styles.diffCell}>
              {row.right ? (
                <>
                  <Text style={styles.diffNo}>{row.right.no}</Text>
                  <Text style={[styles.diffCode, { color: row.left ? theme.colors.foregroundMuted : theme.colors.statusSuccess }]}>
                    {row.right.text}
                  </Text>
                </>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function iconName(kind: Category) {
  switch (kind) {
    case "thought": return "Brain";
    case "command": return "SquareTerminal";
    case "edit": return "FilePen";
    case "read": return "Eye";
    case "search": return "Search";
    case "agent": return "Bot";
    default: return "Wrench";
  }
}

function createStyles(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  return {
    panelbar: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      flexWrap: "wrap" as const,
      gap: 8,
      minHeight: 32,
      paddingHorizontal: 6,
      marginBottom: 2,
    },
    stepCount: { color: colors.foregroundMuted, fontSize: 11.5 },
    controls: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
    settings: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    toolBtnOn: { backgroundColor: colors.surface2 },
    seg: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      padding: 2,
      gap: 2,
      backgroundColor: colors.surface2,
      borderRadius: 9,
      height: 28,
    },
    segHalf: { flexDirection: "row" as const, alignItems: "center" as const, height: 24, borderRadius: 7 },
    segHalfOn: { backgroundColor: colors.surface1 },
    segBtn: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      height: 24,
      paddingHorizontal: 10,
      borderRadius: 7,
    },
    segText: { color: colors.foregroundMuted, fontSize: 12.5 },
    segTextOn: { color: colors.foreground },
    eye: { width: 26, height: 24, alignItems: "center" as const, justifyContent: "center" as const },
    eyeDisabled: { opacity: 0.4 },
    toolBtn: { width: 28, height: 28, alignItems: "center" as const, justifyContent: "center" as const, borderRadius: 7 },
    root: { position: "relative" as const },
    menuAnchor: { position: "relative" as const },
    menu: {
      position: "absolute" as const,
      right: 0,
      width: 300,
      zIndex: 30,
      elevation: 30,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      backgroundColor: colors.surface1,
      overflow: "hidden" as const,
    },
    menuScroll: {},
    menuContent: { padding: 10 },
    matrixHead: { flexDirection: "row" as const, alignItems: "center" as const },
    matrixType: { flex: 1, flexDirection: "row" as const, alignItems: "center" as const, gap: 7, minHeight: 24 },
    headCell: { width: 34, alignItems: "center" as const, paddingVertical: 4 },
    headText: { color: colors.foregroundMuted, fontSize: 9.5, letterSpacing: 0.5, textTransform: "uppercase" as const },
    matrixRow: { flexDirection: "row" as const, alignItems: "center" as const, minHeight: 26 },
    typeButton: { flex: 1 },
    typeLabel: { color: colors.foregroundMuted, fontSize: 12 },
    dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1, borderColor: colors.border },
    cell: { width: 34, height: 26, alignItems: "center" as const, justifyContent: "center" as const },
    cellDisabled: { opacity: 0.3 },
    checkBox: {
      width: 13,
      height: 13,
      borderRadius: 3,
      borderWidth: 1,
      borderColor: colors.foregroundMuted,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    checkBoxOn: { backgroundColor: colors.foreground, borderColor: colors.foreground },
    picker: {
      marginVertical: 4,
      padding: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      backgroundColor: colors.surface2,
      gap: 6,
    },
    pickerHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    pickerSwatch: { width: 18, height: 18, borderRadius: 9 },
    pickerTitle: { flex: 1, color: colors.foreground, fontSize: 11.5 },
    pickerClose: { padding: 3 },
    fieldRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    fieldLabel: { width: 32, color: colors.foregroundMuted, fontSize: 9.5, letterSpacing: 0.5, textTransform: "uppercase" as const },
    fieldInput: {
      flex: 1,
      minHeight: 26,
      paddingHorizontal: 6,
      paddingVertical: 3,
      borderRadius: 5,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface1,
      color: colors.foreground,
      fontSize: 11,
      fontFamily: MONO,
    },
    revert: {
      alignSelf: "flex-start" as const,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 5,
      borderWidth: 1,
      borderColor: colors.border,
    },
    revertDisabled: { opacity: 0.4 },
    revertText: { color: colors.foregroundMuted, fontSize: 11 },
    themes: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border, gap: 6 },
    themesLabel: { color: colors.foregroundMuted, fontSize: 9.5, letterSpacing: 0.5, textTransform: "uppercase" as const },
    chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    chip: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5, borderWidth: 1, borderColor: colors.border },
    chipOn: { backgroundColor: colors.surface2, borderColor: colors.foregroundMuted },
    chipText: { color: colors.foregroundMuted, fontSize: 10.5 },
    chipTextOn: { color: colors.foreground },
    sectionRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      minHeight: 28,
      paddingHorizontal: 6,
      borderRadius: 6,
    },
    rowPressed: { backgroundColor: colors.surface2 },
    chevronSlot: { width: 16, alignItems: "center" as const, justifyContent: "center" as const },
    sectionTitle: { flex: 1, minWidth: 0, color: colors.foreground, fontSize: 13.5, lineHeight: 20 },
    counts: { color: colors.foregroundMuted, fontSize: 12 },
    groupRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      minHeight: 28,
      paddingLeft: 30,
      paddingRight: 6,
      borderRadius: 6,
    },
    groupLabel: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 20 },
    groupCount: { color: colors.foregroundMuted, fontSize: 12, minWidth: 22, textAlign: "right" as const },
    itemRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      minHeight: 28,
      paddingRight: 6,
      borderRadius: 6,
    },
    iconSlot: { width: 16, alignItems: "center" as const, justifyContent: "center" as const },
    titleRow: { flex: 1, minWidth: 0, flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
    itemLabel: { fontSize: 13, lineHeight: 20, flexShrink: 1 },
    itemCode: { fontSize: 11.5, lineHeight: 20, fontFamily: MONO, flexShrink: 1 },
    duration: { color: colors.foregroundMuted, fontSize: 11, minWidth: 52, textAlign: "right" as const, marginLeft: 6 },
    body: { paddingTop: 2, paddingBottom: 6 },
    thoughtBody: { color: colors.foreground, fontSize: 13, lineHeight: 20 },
    strip: { gap: 8, marginBottom: 6 },
    stripRow: { gap: 6, paddingHorizontal: 6 },
    thumb: {
      width: 96,
      height: 60,
      borderRadius: 8,
      borderWidth: 2,
      borderColor: colors.border,
      backgroundColor: colors.surface2,
      overflow: "hidden" as const,
    },
    shotPress: {
      borderRadius: 8,
      borderWidth: 2,
      borderColor: "transparent",
      overflow: "hidden" as const,
    },
    // The browser's focus outline sits outside the thumbnail, where the strip clips it; the ring shows focus instead.
    noOutline: { outlineStyle: "none" } as object,
    ringHover: { borderColor: colors.foregroundMuted },
    ringOn: { borderColor: colors.foreground },
    thumbImage: { width: "100%" as const, height: "100%" as const },
    thumbEmpty: { width: "100%" as const, height: "100%" as const, alignItems: "center" as const, justifyContent: "center" as const },
    shotFull: { width: "100%" as const, borderRadius: 6, backgroundColor: colors.surface2 },
    lightbox: {
      position: "fixed" as unknown as "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 10000,
      padding: 32,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: "rgba(0, 0, 0, 0.72)",
      // Web only: the chat behind blurs rather than showing through.
      backdropFilter: "blur(14px)",
      WebkitBackdropFilter: "blur(14px)",
    } as object,
    lightboxStage: {
      width: "100%" as const,
      maxWidth: 960,
      height: "82%" as const,
      alignItems: "center" as const,
      cursor: "default",
    } as object,
    lightboxImage: { width: "100%" as const, flex: 1 },
    lightboxNav: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 16,
      marginTop: 16,
    },
    lightboxArrow: {
      width: 52,
      height: 52,
      borderRadius: 26,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: "#3a3a3a",
    },
    lightboxClose: { position: "absolute" as unknown as "relative", top: 16, right: 16 },
    lightboxArrowOff: { backgroundColor: "#242424" },
    lightboxCount: {
      minWidth: 52,
      textAlign: "center" as const,
      color: "rgba(255, 255, 255, 0.85)",
      fontSize: 13,
      fontVariant: ["tabular-nums" as const],
    },
    shotEmpty: { alignItems: "center" as const, justifyContent: "center" as const, padding: 8 },
    shotNote: { color: colors.foregroundMuted, fontSize: 11.5, textAlign: "center" as const },
    pre: {
      marginTop: 2,
      marginBottom: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 6,
      backgroundColor: colors.surface2,
      color: colors.foregroundMuted,
      fontSize: 11.5,
      lineHeight: 17,
      fontFamily: MONO,
    },
    moreRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, minHeight: 28, paddingLeft: 30, borderRadius: 6 },
    moreText: { color: colors.foregroundMuted, fontSize: 12 },
    diff: {
      marginTop: 2,
      marginBottom: 6,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      overflow: "hidden" as const,
      backgroundColor: colors.surface1,
    },
    diffHead: {
      flexDirection: "row" as const,
      backgroundColor: colors.surface2,
      paddingVertical: 3,
    },
    diffHeadText: { flex: 1, paddingHorizontal: 8, color: colors.foregroundMuted, fontSize: 9.5, letterSpacing: 0.5, textTransform: "uppercase" as const },
    diffHunk: { paddingHorizontal: 8, paddingVertical: 2, backgroundColor: colors.surface2, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.border },
    diffHunkText: { color: colors.foregroundMuted, fontSize: 9.5, fontFamily: MONO },
    diffRow: { flexDirection: "row" as const, minHeight: 16 },
    diffCell: { flex: 1, flexDirection: "row" as const, gap: 6, paddingHorizontal: 6 },
    diffCellLeft: { borderRightWidth: 1, borderRightColor: colors.border },
    diffNo: { width: 20, textAlign: "right" as const, color: colors.foregroundMuted, fontSize: 9, lineHeight: 16, fontFamily: MONO },
    diffCode: { flex: 1, fontSize: 11, lineHeight: 16, fontFamily: MONO },
  };
}
