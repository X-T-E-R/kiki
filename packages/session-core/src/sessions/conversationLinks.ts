export type ConversationLink = { readonly kind: 'session' | 'room'; readonly id: string; readonly href: string };

export function roomRefLink(roomId: string): string {
  return `/rooms/${encodeURIComponent(roomId)}`;
}

/** The in-app route for a conversation object of either kind. */
export function conversationRefLink(kind: 'session' | 'room', id: string): string {
  return kind === 'room' ? roomRefLink(id) : `/s/${id}`;
}

/** Parse in-app paths and their kiki:// equivalents without accepting arbitrary protocols. */
export function parseConversationLink(link: string): ConversationLink | undefined {
  let path = link;
  if (link.startsWith('kiki://')) {
    try {
      const url = new URL(link);
      if (url.username !== '' || url.password !== '' || url.port !== '') return undefined;
      path = `/${url.host}${url.pathname}${url.search}${url.hash}`;
    } catch { return undefined; }
  }
  const match = /^\/(s|r|rooms)\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})([?#].*)?$/.exec(path);
  if (match === null) return undefined;
  const kind = match[1] === 's' ? 'session' : 'room';
  const id = match[2]!;
  const href = kind === 'room' ? roomRefLink(id) : `/s/${id}`;
  return { kind, id, href: href + (match[3] ?? '') };
}
