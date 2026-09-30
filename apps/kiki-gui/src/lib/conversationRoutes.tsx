import { Navigate, useLocation } from 'react-router-dom';
import { parseConversationLink } from '@kiki/session-core/sessions';

export function RoomLinkRedirect() {
  const location = useLocation();
  const link = parseConversationLink(`${location.pathname}${location.search}${location.hash}`);
  return <Navigate to={link?.kind === 'room' ? link.href : '/new'} replace />;
}
