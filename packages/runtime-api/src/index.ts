import type { ComponentType } from "react";
import type { Widget, FilterValue, Filter } from "@aibi/page-spec";
import type { Frame } from "@aibi/transforms";

export type { Frame } from "@aibi/transforms";
export { PAGE_API_DOCS, ANIM_DOCS, COMPONENT_DOCS } from "./docs";

export interface ThemeTokens {
  mode: "light" | "dark";
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  /** categorical chart palette */
  palette: string[];
  fontFamily: string;
  radius: number;
}

export interface WidgetRef {
  id: string;
  type: string;
  /** the widget's container element (null until mounted) */
  el: HTMLElement | null;
  props: Record<string, unknown>;
  /** shallow-merge props and re-render */
  setProps(patch: Record<string, unknown>): void;
  /** methods exposed by the widget implementation, e.g. highlight, setOption, countUp */
  handle: Record<string, (...args: unknown[]) => unknown>;
  show(): void;
  hide(): void;
}

export interface AnimOptions {
  duration?: number;
  delay?: number | ((index: number) => number);
  easing?: string;
  fill?: FillMode;
  iterations?: number;
}

export type Targets = string | Element | Element[] | NodeListOf<Element> | null | undefined;

export interface AnimApi {
  /** Web Animations API wrapper. keyframes like { opacity: [0, 1], transform: ["translateY(16px)", "none"] } */
  animate(targets: Targets, keyframes: Keyframe[] | PropertyIndexedKeyframes, opts?: AnimOptions): Promise<void>;
  /** delay function for staggered animations: stagger(80) → i * 80 ms */
  stagger(step: number, opts?: { start?: number; from?: "first" | "last" | "center" }): (index: number) => number;
  /** fade + slide elements into view */
  reveal(targets: Targets, opts?: AnimOptions & { distance?: number; direction?: "up" | "down" | "left" | "right" }): Promise<void>;
  /** animate the number shown in an element from `from` to `to` */
  countUp(target: Targets, to: number, opts?: { from?: number; duration?: number; format?: string | ((n: number) => string) }): Promise<void>;
  /** type text into an element */
  typewriter(target: Targets, text: string, opts?: { speed?: number }): Promise<void>;
  pulse(target: Targets, opts?: AnimOptions): Promise<void>;
  /** draw attention: brief scale + glow */
  highlight(target: Targets, opts?: AnimOptions & { color?: string }): Promise<void>;
  /** sequential steps: tl.add(() => anim.reveal(...)).add(500).add(...); await tl.play() */
  timeline(): { add(step: (() => Promise<unknown> | unknown) | number): ReturnType<AnimApi["timeline"]>; play(): Promise<void> };
  sleep(ms: number): Promise<void>;
}

export interface PageApi {
  page: {
    id: string;
    title: string;
    theme: ThemeTokens;
    /** root element of the page */
    el: HTMLElement;
    setTitle(title: string): void;
    refresh(): Promise<void>;
    print(): void;
    /** content of a bundle asset (text, JSON or data URL) */
    asset(name: string): string | undefined;
    /** hosts the project allows in embed widgets */
    embedHosts: string[];
    /** locale and currency for formatting */
    locale: string;
    currency: string;
    /** "view" | "edit" | "render" */
    mode: "view" | "edit" | "render";
  };
  filters: {
    /** runtime value (e.g. { start, end, ... } for dateRange) */
    get(id: string): FilterValue | undefined;
    /** set the raw value (dateRange: { preset } or { start, end }; multiSelect: string[] | "all"; ...) */
    set(id: string, raw: unknown): void;
    readonly values: Record<string, FilterValue>;
    readonly definitions: Filter[];
  };
  data: {
    get(id: string): Frame | undefined;
    reload(id?: string): Promise<void>;
    readonly ids: string[];
  };
  widgets: {
    get(id: string): WidgetRef | undefined;
    all(): WidgetRef[];
    show(id: string): void;
    hide(id: string): void;
  };
  events: {
    on(name: string, fn: (payload: unknown) => void): () => void;
    off(name: string, fn: (payload: unknown) => void): void;
    emit(name: string, payload?: unknown): void;
  };
  anim: AnimApi;
  util: {
    format(value: unknown, spec?: string): string;
    sleep(ms: number): Promise<void>;
  };
  ai: {
    /** ask the runtime AI a question about the page data; returns markdown text */
    ask(question: string, opts?: { datasets?: string[] }): Promise<string>;
    /** cached commentary for a narrative widget (regenerates when data or filters change, or refresh=true) */
    narrative(opts: { widgetId: string; prompt: string; datasets: string[]; maxWords?: number; refresh?: boolean }): Promise<string>;
  };
  /** scratch space shared by scripts and components of the page */
  state: Record<string, unknown>;
}

export type ScriptContext = PageApi;
export type PageScript = (ctx: ScriptContext) => void | (() => void) | Promise<void | (() => void)>;

export interface WidgetRenderProps {
  widget: Widget;
  /** props with bindings resolved */
  props: Record<string, unknown>;
  data?: Frame;
  /** all datasets (for widgets that combine several) */
  datasets: Record<string, Frame | undefined>;
  loading: boolean;
  error?: string;
  theme: ThemeTokens;
  width: number;
  height: number;
  api: PageApi;
  emit(event: "click" | "dblclick" | "hover" | "select", payload: { row?: Record<string, unknown>; value?: unknown; name?: unknown; series?: unknown }): void;
  setHandle(handle: Record<string, (...args: unknown[]) => unknown>): void;
  format(value: unknown, spec?: string): string;
  /** evaluate conditional styles for a cell / row */
  styleFor(row: Record<string, unknown>, column?: string, value?: unknown): Record<string, string | number> | undefined;
  editMode: boolean;
}

export interface WidgetDefinition {
  type: string;
  component: ComponentType<WidgetRenderProps>;
  /** render without the card chrome (title, border) */
  bare?: boolean;
}

export interface FilterUIProps {
  filter: Filter;
  raw: unknown;
  value: FilterValue | undefined;
  options: { value: string | number | boolean; label: string }[];
  onChange(raw: unknown): void;
  theme: ThemeTokens;
}

export interface FilterUIDefinition {
  type: string;
  component: ComponentType<FilterUIProps>;
}

/** What a skill's client entry exports (default export). */
export interface ClientSkillModule {
  widgets?: WidgetDefinition[];
  filters?: FilterUIDefinition[];
}
