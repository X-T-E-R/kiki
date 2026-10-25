import { useRef, useState } from 'react';

export type AnnotationTool = 'select' | 'arrow' | 'rectangle' | 'pen';
export interface AnnotationPoint { readonly x: number; readonly y: number }
export interface ImageAnnotation {
  readonly id: number;
  readonly tool: Exclude<AnnotationTool, 'select'>;
  readonly points: readonly AnnotationPoint[];
}

export function annotationPath(mark: ImageAnnotation): string {
  return mark.points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');
}

export function AnnotationShapes({ marks, strokeWidth, selected, onSelect }: { marks: readonly ImageAnnotation[]; strokeWidth: number; selected?: number; onSelect?: (id: number) => void }) {
  return <>{marks.map((mark) => {
    const first = mark.points[0]!;
    const last = mark.points.at(-1)!;
    const color = selected === mark.id ? '#38bdf8' : '#ef4444';
    const shape = mark.tool === 'rectangle'
      ? <rect x={Math.min(first.x, last.x)} y={Math.min(first.y, last.y)} width={Math.abs(last.x - first.x)} height={Math.abs(last.y - first.y)} />
      : <path d={annotationPath(mark)} />;
    const angle = Math.atan2(last.y - first.y, last.x - first.x);
    const length = strokeWidth * 5;
    return <g key={mark.id} data-annotation={mark.id} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" onPointerDown={onSelect === undefined ? undefined : () => { onSelect(mark.id); }} style={{ pointerEvents: onSelect === undefined ? 'none' : 'stroke' }}>
      {shape}
      {mark.tool === 'arrow' ? <path d={`M${last.x - length * Math.cos(angle - Math.PI / 6)},${last.y - length * Math.sin(angle - Math.PI / 6)} L${last.x},${last.y} L${last.x - length * Math.cos(angle + Math.PI / 6)},${last.y - length * Math.sin(angle + Math.PI / 6)}`} /> : null}
      {onSelect === undefined ? null : <g stroke="transparent" strokeWidth={strokeWidth * 5}>{shape}</g>}
    </g>;
  })}</>;
}

/** Points stay in original image pixels, independently of zoom and display DPR. */
export function ImageViewportAnnotations({ width, height, marks, tool, editing, selected, onSelect, onChange }: {
  width: number; height: number; marks: readonly ImageAnnotation[]; tool: AnnotationTool; editing: boolean; selected?: number;
  onSelect: (id?: number) => void; onChange: (marks: readonly ImageAnnotation[]) => void;
}) {
  const [draft, setDraft] = useState<readonly ImageAnnotation[] | null>(null);
  const committed = useRef<readonly ImageAnnotation[] | null>(null);
  const gesture = useRef<{ start: AnnotationPoint; marks: readonly ImageAnnotation[]; active: ImageAnnotation; moving: boolean; pointer: number } | null>(null);
  const point = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(width, (event.clientX - rect.left) * width / rect.width)), y: Math.max(0, Math.min(height, (event.clientY - rect.top) * height / rect.height)) };
  };
  return <svg data-image-annotations viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 h-full w-full" style={{ pointerEvents: editing ? 'auto' : 'none', touchAction: editing ? 'none' : undefined, cursor: tool === 'select' ? 'move' : 'crosshair' }}
    onPointerDown={(event) => {
      if (!editing || event.button !== 0) return;
      event.stopPropagation();
      event.currentTarget.focus();
      const start = point(event);
      const hit = event.target instanceof Element ? event.target.closest('[data-annotation]')?.getAttribute('data-annotation') : undefined;
      const active = tool === 'select' ? marks.find((mark) => mark.id === Number(hit)) : { id: Date.now(), tool, points: [start, start] };
      onSelect(tool === 'select' ? active?.id : undefined);
      if (active === undefined) return;
      gesture.current = { start, marks, active, moving: tool === 'select', pointer: event.pointerId };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      const state = gesture.current;
      if (state === null || state.pointer !== event.pointerId) return;
      event.stopPropagation();
      const next = point(event);
      const active = state.moving ? { ...state.active, points: state.active.points.map((p) => ({ x: p.x + next.x - state.start.x, y: p.y + next.y - state.start.y })) }
        : { ...state.active, points: state.active.tool === 'pen' ? [...state.active.points, next] : [state.start, next] };
      if (!state.moving) state.active = active;
      const nextMarks = state.moving ? state.marks.map((mark) => mark.id === active.id ? active : mark) : [...state.marks, active];
      committed.current = nextMarks;
      setDraft(nextMarks);
    }}
    onPointerUp={(event) => {
      if (gesture.current === null || gesture.current.pointer !== event.pointerId) return;
      event.stopPropagation();
      if (committed.current !== null) onChange(committed.current);
      gesture.current = null;
      committed.current = null;
      setDraft(null);
    }}
    onPointerCancel={() => { gesture.current = null; committed.current = null; setDraft(null); }}
  >
    <AnnotationShapes marks={draft ?? marks} strokeWidth={Math.max(2, width / 300)} selected={editing ? selected : undefined} onSelect={editing && tool === 'select' ? onSelect : undefined} />
  </svg>;
}

/** Export a copy; never replace the original source URL or its bytes. */
export async function renderAnnotatedImage(src: string, marks: readonly ImageAnnotation[]): Promise<Blob> {
  const original = new Image();
  original.crossOrigin = 'anonymous';
  original.src = src;
  await original.decode();
  const width = original.naturalWidth;
  const height = original.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas is unavailable');
  context.drawImage(original, 0, 0);
  const strokeWidth = Math.max(2, width / 300);
  context.strokeStyle = '#ef4444';
  context.lineWidth = strokeWidth;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const mark of marks) {
    const first = mark.points[0]!;
    const last = mark.points.at(-1)!;
    context.beginPath();
    if (mark.tool === 'rectangle') context.rect(Math.min(first.x, last.x), Math.min(first.y, last.y), Math.abs(last.x - first.x), Math.abs(last.y - first.y));
    else {
      mark.points.forEach((point, index) => { if (index === 0) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y); });
      if (mark.tool === 'arrow') {
        const angle = Math.atan2(last.y - first.y, last.x - first.x);
        const length = strokeWidth * 5;
        context.moveTo(last.x - length * Math.cos(angle - Math.PI / 6), last.y - length * Math.sin(angle - Math.PI / 6));
        context.lineTo(last.x, last.y);
        context.lineTo(last.x - length * Math.cos(angle + Math.PI / 6), last.y - length * Math.sin(angle + Math.PI / 6));
      }
    }
    context.stroke();
  }
  return new Promise((resolve, reject) => { canvas.toBlob((blob) => { if (blob === null) reject(new Error('Image export failed')); else resolve(blob); }, 'image/png'); });
}
