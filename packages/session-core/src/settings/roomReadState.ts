import { forgetSessionSeen, markSessionSeen, type SessionSeenMap } from './sessionReadState';

export function roomSeenKey(roomId: string): string {
  return `room:${roomId}`;
}

export function markRoomSeen(roomId: string, lastSeq: number): void {
  if (roomId === '') return;
  markSessionSeen(roomSeenKey(roomId), lastSeq);
}

export function forgetRoomSeen(roomId: string): void {
  forgetSessionSeen(roomSeenKey(roomId));
}

export function roomUnreadCount(roomId: string, lastSeq: number, seen: SessionSeenMap): number {
  return Math.max(0, lastSeq - (seen[roomSeenKey(roomId)] ?? 0));
}
