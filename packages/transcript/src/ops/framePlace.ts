export function safetyBoundaryIndex(frames: readonly { readonly kind: string; readonly role?: string }[]): number {
  const boundary = frames.findIndex((frame) => frame.kind !== 'text' || frame.role !== 'user');
  return boundary < 0 ? frames.length : boundary;
}
