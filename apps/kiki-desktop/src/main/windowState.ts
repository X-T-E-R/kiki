import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from '@kiki/kaos/atomic-fs';
import { join } from 'pathe';
import { z } from 'zod';

export interface DisplayWorkArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PersistedWindowState {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  readonly isMaximized: boolean;
  readonly isFullScreen: boolean;
}

const MIN_WINDOW_WIDTH = 960;
const MIN_WINDOW_HEIGHT = 640;
const MIN_VISIBLE_OVERLAP_X = 120;
const MIN_VISIBLE_OVERLAP_Y = 80;

const windowStateSchema = z.object({
  x: z.number().int().finite().optional(),
  y: z.number().int().finite().optional(),
  width: z.number().int().finite().min(MIN_WINDOW_WIDTH),
  height: z.number().int().finite().min(MIN_WINDOW_HEIGHT),
  isMaximized: z.boolean().optional(),
  isFullScreen: z.boolean().optional(),
});

export function windowStateFilePath(userDataDir: string): string {
  return join(userDataDir, 'window-state.json');
}

function hasVisibleIntersection(
  bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  area: DisplayWorkArea,
): boolean {
  const overlapLeft = Math.max(bounds.x, area.x);
  const overlapTop = Math.max(bounds.y, area.y);
  const overlapRight = Math.min(bounds.x + bounds.width, area.x + area.width);
  const overlapBottom = Math.min(bounds.y + bounds.height, area.y + area.height);
  const overlapWidth = overlapRight - overlapLeft;
  const overlapHeight = overlapBottom - overlapTop;
  return (
    overlapWidth >= Math.min(MIN_VISIBLE_OVERLAP_X, bounds.width) &&
    overlapHeight >= Math.min(MIN_VISIBLE_OVERLAP_Y, bounds.height)
  );
}

export function rescueWindowBounds(
  saved: PersistedWindowState | null,
  workAreas: readonly DisplayWorkArea[],
  defaults: { readonly width: number; readonly height: number },
): PersistedWindowState {
  const primary = workAreas[0];
  const rawWidth = saved?.width ?? defaults.width;
  const rawHeight = saved?.height ?? defaults.height;
  const maxWidth = primary !== undefined ? Math.max(MIN_WINDOW_WIDTH, primary.width) : rawWidth;
  const maxHeight = primary !== undefined ? Math.max(MIN_WINDOW_HEIGHT, primary.height) : rawHeight;
  const width = Math.min(Math.max(MIN_WINDOW_WIDTH, Math.trunc(rawWidth)), maxWidth);
  const height = Math.min(Math.max(MIN_WINDOW_HEIGHT, Math.trunc(rawHeight)), maxHeight);
  const isMaximized = saved?.isMaximized === true;
  const isFullScreen = saved?.isFullScreen === true;

  if (saved?.x !== undefined && saved.y !== undefined && workAreas.length > 0) {
    const candidate = { x: Math.trunc(saved.x), y: Math.trunc(saved.y), width, height };
    if (workAreas.some((area) => hasVisibleIntersection(candidate, area))) {
      return {
        x: candidate.x,
        y: candidate.y,
        width,
        height,
        isMaximized,
        isFullScreen,
      };
    }
  }

  if (primary !== undefined) {
    return {
      x: Math.round(primary.x + Math.max(0, (primary.width - width) / 2)),
      y: Math.round(primary.y + Math.max(0, (primary.height - height) / 2)),
      width,
      height,
      isMaximized,
      isFullScreen,
    };
  }

  return {
    width,
    height,
    isMaximized,
    isFullScreen,
  };
}

export async function readWindowState(userDataDir: string): Promise<PersistedWindowState | null> {
  try {
    const raw = await readFile(windowStateFilePath(userDataDir), 'utf8');
    const parsed = windowStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return {
      ...(parsed.data.x !== undefined ? { x: parsed.data.x } : {}),
      ...(parsed.data.y !== undefined ? { y: parsed.data.y } : {}),
      width: parsed.data.width,
      height: parsed.data.height,
      isMaximized: parsed.data.isMaximized === true,
      isFullScreen: parsed.data.isFullScreen === true,
    };
  } catch {
    return null;
  }
}

export async function writeWindowState(
  userDataDir: string,
  state: PersistedWindowState,
): Promise<void> {
  await atomicWriteJson(windowStateFilePath(userDataDir), state, {
    indent: 2,
    preserveDestinationOnError: true,
  });
}
