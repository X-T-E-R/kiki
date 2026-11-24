import {
  Container,
  ProcessTerminal,
  VStack,
  type TUI,
  type Terminal,
} from '@kiki/pi-tui';

import { FooterComponent } from './components/chrome/footer';
import { GutterContainer } from './components/chrome/gutter-container';
import type { MoonLoader, SpinnerStyle } from './components/chrome/moon-loader';
import { TodoPanelComponent } from './components/chrome/todo-panel';
import type { SessionRow } from './components/dialogs/session-picker';
import { CustomEditor } from './components/editor/custom-editor';
import { DEFAULT_TUI_CONFIG, resolveEffectiveScreenAndMouse } from './config';
import { CHROME_GUTTER } from './constant/rendering';
import { ScreenController } from './screen-controller';
import { currentTheme, type Theme } from './theme';
import { setMarkdownRenderLatex } from './utils/markdown-options';
import { createTerminalState, type TerminalState } from './utils/terminal-state';
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type KimiTUIOptions,
  type LivePaneState,
  type QueuedMessage,
  type TranscriptEntry,
  type TUIStartupState,
} from './types';

export interface TUIState {
  ui: TUI;
  screenController: ScreenController;
  terminal: Terminal;
  breadcrumbContainer: Container;
  transcriptContainer: Container;
  activityContainer: Container;
  todoPanelContainer: Container;
  todoPanel: TodoPanelComponent;
  queueContainer: Container;
  btwPanelContainer: Container;
  editorContainer: Container;
  /**
   * Fullscreen mode only: the bottom dock (activity/todo/queue/btw/editor +
   * footer) stacked under the transcript ScrollView. Undefined in regular
   * mode, where all chrome is a direct child of the root container.
   */
  dockContainer: VStack | undefined;
  footer: FooterComponent;
  editor: CustomEditor;
  theme: Theme;
  appState: AppState;
  startupState: TUIStartupState;
  livePane: LivePaneState;
  transcriptEntries: TranscriptEntry[];
  terminalState: TerminalState;
  activitySpinner: { instance: MoonLoader; style: SpinnerStyle } | null;
  toolOutputExpanded: boolean;
  sessions: SessionRow[];
  loadingSessions: boolean;
  /** Keyset cursor for the next older page; `undefined` when the listing is exhausted. */
  sessionsNextCursor: string | undefined;
  /** A follow-up session page fetch is in flight. */
  sessionsLoadingMore: boolean;
  sessionsScope: 'cwd' | 'all';
  activeDialog: 'session-picker' | 'help' | 'trust-prompt' | 'cache-hint' | null;
  /**
   * True while an editor-replacement panel (help, trust prompt, goal queue
   * manager, …) is mounted in place of the editor. Delayed input restores
   * must not run in that state — they would displace the newer panel.
   */
  editorReplacementMounted: boolean;
  externalEditorRunning: boolean;
  queuedMessages: QueuedMessage[];
  /**
   * True while a queued user message has been shifted out of
   * {@link queuedMessages} but its deferred send has not run yet. The queue
   * looks empty during this window, so queued-goal promotion must also check
   * this flag to avoid starting a goal ahead of the user's earlier message.
   */
  queuedMessageDispatchPending: boolean;
}

export function createTUIState(options: KimiTUIOptions, terminal: Terminal = new ProcessTerminal()): TUIState {
  const initialAppState = options.initialAppState;
  const theme = currentTheme;

  setMarkdownRenderLatex(initialAppState.renderLatex ?? DEFAULT_TUI_CONFIG.renderLatex ?? true);
  const resolvedScreen = resolveEffectiveScreenAndMouse({
    screenMode: initialAppState.screenMode,
    mouse: initialAppState.mouse,
  });

  const breadcrumbContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const transcriptContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const activityContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanel = new TodoPanelComponent();
  const queueContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const btwPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editorContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);

  let stateRef: TUIState | undefined;
  const screenController = new ScreenController({
    terminal,
    initialMode: resolvedScreen.screenMode,
    savedMousePreference: resolvedScreen.savedMouse,
    containers: {
      breadcrumbContainer,
      transcriptContainer,
      activityContainer,
      todoPanelContainer,
      queueContainer,
      btwPanelContainer,
      editorContainer,
    },
    onDockChanged: (dock) => {
      if (stateRef !== undefined) {
        stateRef.dockContainer = dock;
      }
    },
  });
  const ui = screenController.ui;

  const editor = new CustomEditor(ui, {
    disablePasteBurst: initialAppState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
  });
  const footer = new FooterComponent(
    {
      ...initialAppState,
      screenMode: resolvedScreen.screenMode,
      mouse: resolvedScreen.effectiveMouse,
    },
    () => {
      ui.requestRender();
    },
  );

  stateRef = {
    ui,
    screenController,
    terminal,
    breadcrumbContainer,
    transcriptContainer,
    activityContainer,
    todoPanelContainer,
    todoPanel,
    queueContainer,
    btwPanelContainer,
    editorContainer,
    dockContainer: screenController.getDockContainer(),
    editor,
    footer,
    theme,
    appState: {
      ...initialAppState,
      screenMode: resolvedScreen.screenMode,
      mouse: resolvedScreen.effectiveMouse,
    },
    startupState: 'pending',
    livePane: { ...INITIAL_LIVE_PANE },
    transcriptEntries: [],
    terminalState: createTerminalState(),
    activitySpinner: null,
    toolOutputExpanded: false,
    sessions: [],
    loadingSessions: false,
    sessionsNextCursor: undefined,
    sessionsLoadingMore: false,
    sessionsScope: 'cwd',
    activeDialog: null,
    editorReplacementMounted: false,
    externalEditorRunning: false,
    queuedMessages: [],
    queuedMessageDispatchPending: false,
  };
  return stateRef;
}
