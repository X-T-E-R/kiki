/**
 * The GUI's one icon family. Every drawn mark in the app comes from here.
 *
 * Standard UI icons delegate through static named imports from `lucide-react`
 * (tree-shaken, 24px viewBox, visually equivalent stroke weight). Kiki-specific
 * marks (`profile*` archetypes, `partial`, `dot`, `ring`) stay on the custom
 * 16px viewBox with a 1.35 stroke. Three rendered sizes only: 12 (inline —
 * relation marks, chevrons, tag prefixes), 14 (timeline row heads, row actions)
 * and 16 (navigation, header buttons). Colour is inherited from the text;
 * resting marks sit at `ink-faint`.
 *
 * An icon names a KIND of thing, never an outcome. Outcome belongs to
 * `OutcomeMark`, whose rule is that success is silent.
 */

import type { ComponentType, ReactNode, SVGProps } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  Bell,
  Check,
  ChevronRight,
  CircleHelp,
  CirclePause,
  CirclePlay,
  Clock,
  Columns3,
  Compass,
  Copy,
  CornerDownRight,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileText,
  Filter,
  Folder,
  GitBranch,
  Globe,
  GripVertical,
  Hash,
  Layers2,
  Lightbulb,
  List,
  Lock,
  Maximize2,
  Menu,
  MessageSquare,
  Minimize2,
  Minus,
  NotebookText,
  PanelRight,
  Pencil,
  Pin,
  Plus,
  Puzzle,
  Quote,
  RefreshCw,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Smartphone,
  Sparkle,
  Sparkles,
  Square,
  SquareMenu,
  SquareTerminal,
  SquareUserRound,
  Star,
  Target,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react';

export type IconName =
  // Activity kinds (timeline row heads)
  | 'read'
  | 'search'
  | 'edit'
  | 'terminal'
  | 'web'
  | 'agent'
  | 'skill'
  | 'plan'
  | 'task'
  | 'goal'
  | 'memory'
  | 'think'
  | 'system'
  | 'clock'
  | 'gate'
  | 'ask'
  | 'file'
  | 'tool'
  // Outcome and state marks
  | 'check'
  | 'cross'
  | 'dash'
  | 'warning'
  // On-demand help beside a label or control.
  | 'info'
  | 'hold'
  // Controls
  | 'chevron'
  | 'close'
  | 'menu'
  | 'more'
  | 'plus'
  | 'arrowRight'
  | 'arrowDown'
  | 'external'
  | 'folder'
  | 'panel'
  | 'filter'
  | 'sliders'
  | 'pin'
  | 'settings'
  | 'arrowLeft'
  | 'arrowUp'
  | 'arrowUpRight'
  | 'expand'
  | 'collapse'
  | 'grip'
  | 'stop'
  | 'quote'
  | 'star'
  | 'starFilled'
  | 'dot'
  | 'ring'
  | 'partial'
  | 'eye'
  | 'eyeOff'
  | 'copy'
  | 'refresh'
  // Places and relations
  | 'board'
  | 'usage'
  | 'bell'
  | 'notes'
  | 'persona'
  | 'branch'
  | 'room'
  | 'thread'
  | 'compass'
  | 'smartphone'
  | 'plugin'
  | 'lock'
  // Agent profile archetypes
  | 'profileMain'
  | 'profileCode'
  | 'profileFrontend'
  | 'profileResearch'
  | 'profileReview'
  | 'profileThink'
  | 'profileOperator'
  | 'profileWorker'
  | 'profileWriter'
  | 'profileDirector';

export type IconSize = 12 | 14 | 16;

const SIZE_CLASS: Record<IconSize, string> = {
  12: 'h-3 w-3',
  14: 'h-3.5 w-3.5',
  16: 'h-4 w-4',
};

type LucideSvgComponent = ComponentType<
  SVGProps<SVGSVGElement> & {
    size?: string | number;
    strokeWidth?: string | number;
    absoluteStrokeWidth?: boolean;
  }
>;

interface LucideEntry {
  readonly component: LucideSvgComponent;
  readonly fill?: 'currentColor';
}

type CustomIconName =
  | 'dot'
  | 'ring'
  | 'partial'
  | 'profileMain'
  | 'profileCode'
  | 'profileFrontend'
  | 'profileResearch'
  | 'profileReview'
  | 'profileThink'
  | 'profileOperator'
  | 'profileWorker'
  | 'profileWriter'
  | 'profileDirector';

type LucideIconName = Exclude<IconName, CustomIconName>;

const LUCIDE_ICONS: Record<LucideIconName, LucideEntry> = {
  read: { component: File },
  search: { component: Search },
  edit: { component: Pencil },
  terminal: { component: SquareTerminal },
  web: { component: Globe },
  agent: { component: Layers2 },
  skill: { component: Sparkle },
  plan: { component: List },
  task: { component: CirclePlay },
  goal: { component: Target },
  memory: { component: Sparkles },
  think: { component: Lightbulb },
  system: { component: SquareMenu },
  clock: { component: Clock },
  gate: { component: Shield },
  ask: { component: MessageSquare },
  file: { component: FileText },
  tool: { component: Wrench },
  check: { component: Check },
  cross: { component: X },
  dash: { component: Minus },
  warning: { component: TriangleAlert },
  info: { component: CircleHelp },
  hold: { component: CirclePause },
  chevron: { component: ChevronRight },
  close: { component: X },
  menu: { component: Menu },
  more: { component: Ellipsis },
  plus: { component: Plus },
  arrowRight: { component: ArrowRight },
  arrowDown: { component: ArrowDown },
  external: { component: ExternalLink },
  folder: { component: Folder },
  panel: { component: PanelRight },
  filter: { component: Filter },
  sliders: { component: SlidersHorizontal },
  pin: { component: Pin },
  board: { component: Columns3 },
  usage: { component: BarChart3 },
  notes: { component: NotebookText },
  settings: { component: Settings },
  arrowLeft: { component: ArrowLeft },
  arrowUp: { component: ArrowUp },
  arrowUpRight: { component: ArrowUpRight },
  expand: { component: Maximize2 },
  collapse: { component: Minimize2 },
  grip: { component: GripVertical },
  stop: { component: Square, fill: 'currentColor' },
  quote: { component: Quote },
  star: { component: Star },
  starFilled: { component: Star, fill: 'currentColor' },
  bell: { component: Bell },
  branch: { component: GitBranch },
  eye: { component: Eye },
  eyeOff: { component: EyeOff },
  copy: { component: Copy },
  refresh: { component: RefreshCw },
  thread: { component: CornerDownRight },
  room: { component: Hash },
  persona: { component: SquareUserRound },
  compass: { component: Compass },
  smartphone: { component: Smartphone },
  plugin: { component: Puzzle },
  lock: { component: Lock },
};

const CUSTOM_PATHS: Record<CustomIconName, ReactNode> = {
  // A solid state dot (unsaved, in progress) and its hollow counterpart.
  dot: <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />,
  ring: <circle cx="8" cy="8" r="4.5" />,
  // A dial a quarter filled: an estimate or partial figure (unknown price).
  partial: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 8V2.2A5.8 5.8 0 0 1 13.8 8z" fill="currentColor" />
    </>
  ),
  // Primary conductor spark + satellite: default/main native Kiki profile.
  profileMain: (
    <>
      <path d="M7 2.5 8.3 6.2 12 7.5 8.3 8.8 7 12.5 5.7 8.8 2 7.5 5.7 6.2z" />
      <path d="M12.2 2.5v2.4M11 3.7h2.4" />
    </>
  ),
  // Code brackets `< />`: engineering and implementation profiles.
  profileCode: <path d="M5.2 5.2 2.3 8l2.9 2.8M10.8 5.2 13.7 8l-2.9 2.8M9 3.6 7 12.4" />,
  // Layout window with header and sidebar split: UI and visual frontend profiles.
  profileFrontend: (
    <>
      <rect x="2.3" y="3" width="11.4" height="10" rx="1.7" />
      <path d="M2.3 6.3h11.4M6.2 6.3V13" />
    </>
  ),
  // Open book with central spine: research, synthesis, and literature profiles.
  profileResearch: (
    <>
      <path d="M2.3 4.1c1.9-.5 3.9-.2 5.7.9 1.8-1.1 3.8-1.4 5.7-.9v8.3c-1.9-.5-3.9-.2-5.7.9-1.8-1.1-3.8-1.4-5.7-.9z" />
      <path d="M8 5v8.3" />
    </>
  ),
  // Shield with check mark: independent review, audit, and verification profiles.
  profileReview: (
    <>
      <path d="M8 2.3 13 4.1v3.6c0 3-2.1 5.1-5 6.1-2.9-1-5-3.1-5-6.1V4.1z" />
      <path d="m5.8 8 1.6 1.6 3-3" />
    </>
  ),
  // Faceted octahedron prism: deep narrow reasoning and architecture profiles.
  profileThink: (
    <>
      <path d="M8 2.2 13.3 8 8 13.8 2.7 8z" />
      <path d="M8 2.2 6.1 8 8 13.8M2.7 8h10.6" />
    </>
  ),
  // Window frame with precision pointer arrow: browser, phone, and CUA operators.
  profileOperator: (
    <>
      <path d="M13.4 7.8V4.4a1.5 1.5 0 0 0-1.5-1.5H4.1a1.5 1.5 0 0 0-1.5 1.5v5.8a1.5 1.5 0 0 0 1.5 1.5h3.7" />
      <path d="M2.6 5.6h10.8" />
      <path d="m9.4 8.6 1.1 4.9 1.1-1.7 1.9-.5z" />
    </>
  ),
  // Isometric stacked layers: bounded execution and batch worker profiles.
  profileWorker: (
    <>
      <path d="M8 2.6 13.5 5.4 8 8.2 2.5 5.4z" />
      <path d="m2.5 8.4 5.5 2.8 5.5-2.8" />
      <path d="m2.5 11.1 5.5 2.7 5.5-2.7" />
    </>
  ),
  // Clean fountain pen nib: editorial, prose, and creative writing profiles.
  profileWriter: (
    <>
      <path d="M8 2.3 11.8 8.4 9.9 13.5H6.1L4.2 8.4z" />
      <path d="M8 2.3v5.3" />
      <circle cx="8" cy="8.5" r="0.9" />
    </>
  ),
  // Viewfinder frame corners with play triangle: audiovisual director profiles.
  profileDirector: (
    <>
      <path d="M2.5 5.5V3.8a1.2 1.2 0 0 1 1.2-1.2h1.8M10.5 2.6h1.8a1.2 1.2 0 0 1 1.2 1.2v1.7M13.5 10.5v1.7a1.2 1.2 0 0 1-1.2 1.2h-1.8M5.5 13.4H3.7a1.2 1.2 0 0 1-1.2-1.2v-1.7" />
      <polygon points="6.7,5.8 10.5,8 6.7,10.2" />
    </>
  ),
};

interface IconProps {
  readonly name: IconName;
  /** One of the three family sizes. Ignored when `className` sets its own box. */
  readonly size?: IconSize;
  /** Extra classes (colour, rotation). A class containing `h-` replaces the size box. */
  readonly className?: string;
}

/** One family icon, decorative by default (`aria-hidden`). */
export function Icon({ name, size = 14, className = '' }: IconProps) {
  const box = /(^|\s)h-/.test(className) ? '' : SIZE_CLASS[size];
  const mergedClass = `shrink-0 ${box} ${className}`.trim();
  if (Object.hasOwn(CUSTOM_PATHS, name)) {
    return (
      <svg
        aria-hidden
        data-icon={name}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.35}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={mergedClass}
      >
        {CUSTOM_PATHS[name as CustomIconName]}
      </svg>
    );
  }
  const entry = LUCIDE_ICONS[name as LucideIconName];
  const LucideGlyph = entry.component;
  return (
    <LucideGlyph
      aria-hidden="true"
      data-icon={name}
      strokeWidth={1.75}
      absoluteStrokeWidth
      fill={entry.fill ?? 'none'}
      className={mergedClass}
    />
  );
}

/**
 * Disclosure chevron: points right when closed and turns down when open.
 * `className` replaces the default `ink-faint` colour.
 */
export function DisclosureChevron({
  open,
  size = 12,
  className = 'text-ink-faint',
}: {
  readonly open: boolean;
  readonly size?: IconSize;
  readonly className?: string;
}) {
  return (
    <Icon
      name="chevron"
      size={size}
      className={`transition-transform duration-[var(--kiki-motion-quick)] ease-out motion-reduce:transition-none ${open ? 'rotate-90' : ''} ${className}`}
    />
  );
}

/** Running mark: a faint ring with a moving arc, in the 14px box. */
export function Spinner({ label, size = 14 }: { readonly label: string; readonly size?: IconSize }) {
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 16 16"
      fill="none"
      className={`spinner shrink-0 text-ink-soft ${SIZE_CLASS[size]}`}
    >
      <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeOpacity="0.22" strokeWidth={1.35} />
      <path d="M13.8 8A5.8 5.8 0 0 0 8 2.2" stroke="currentColor" strokeWidth={1.35} strokeLinecap="round" />
    </svg>
  );
}

export type OutcomeState = 'running' | 'failed' | 'stopped' | 'done';

export interface OutcomeLabels {
  readonly running: string;
  readonly failed: string;
  readonly stopped: string;
  readonly done: string;
}

/**
 * The one outcome-mark rule: running spins, failure crosses, a stop is an
 * amber dash, and SUCCESS IS SILENT. A column of success marks trains the eye
 * to skip the column, and then the one failure in it gets skipped too. The
 * done state keeps a visually hidden label so assistive tech still hears it.
 */
export function OutcomeMark({
  state,
  labels,
  title,
}: {
  readonly state: OutcomeState;
  readonly labels: OutcomeLabels;
  readonly title?: string;
}) {
  switch (state) {
    case 'running':
      return <Spinner label={labels.running} />;
    case 'failed':
      return (
        <span role="img" aria-label={labels.failed} title={title} data-outcome="failed" className="text-danger">
          <Icon name="cross" />
        </span>
      );
    case 'stopped':
      return (
        <span role="img" aria-label={labels.stopped} title={title} data-outcome="stopped" className="text-amber-rule">
          <Icon name="dash" />
        </span>
      );
    case 'done':
      return <span className="sr-only">{labels.done}</span>;
  }
}

const PLUGIN_SLOT_ICON_MAP: Readonly<Record<string, IconName>> = {
  smartphone: 'smartphone',
  phone: 'smartphone',
  mobile: 'smartphone',
  device: 'smartphone',
  plugin: 'plugin',
  plug: 'plugin',
  puzzle: 'plugin',
  terminal: 'terminal',
  board: 'board',
  grid: 'board',
  web: 'web',
  globe: 'web',
  browser: 'compass',
  compass: 'compass',
  file: 'file',
  read: 'read',
  notes: 'notes',
  search: 'search',
  edit: 'edit',
  clock: 'clock',
  usage: 'usage',
  settings: 'settings',
  sliders: 'sliders',
  tool: 'tool',
  panel: 'panel',
  folder: 'folder',
  branch: 'branch',
  star: 'star',
};

/**
 * Resolve a declarative plugin slot or panel icon hint to one of Kiki's drawn
 * SVG icons — zero emoji, crisp 16px geometry.
 */
export function resolvePluginSlotIconName(options: {
  readonly icon?: string;
  readonly pluginId?: string;
  readonly panelId?: string;
  readonly fallback?: IconName;
}): IconName {
  const { icon, pluginId, panelId, fallback = 'star' } = options;
  if (typeof icon === 'string') {
    const normalized = icon.trim().toLowerCase();
    if (normalized !== '') {
      const mapped = PLUGIN_SLOT_ICON_MAP[normalized];
      if (mapped !== undefined) return mapped;
    }
  }
  const combinedId = `${pluginId ?? ''}:${panelId ?? ''}`.toLowerCase();
  if (combinedId.includes('phone') || combinedId.includes('mobile') || combinedId.includes('android') || combinedId.includes('ios')) {
    return 'smartphone';
  }
  return fallback;
}
