import { Navigate, useLocation } from 'react-router-dom';
import { parseConversationLink } from '@kiki/session-core/sessions';
import { parsePlaceConnectionId, placeNewPath, placeRoutePrefix, stripPlacePrefix } from './placeRoutes';

export function RoomLinkRedirect() {
  const location = useLocation();
  const connectionId = parsePlaceConnectionId(location.pathname);
  const normalizedPath = stripPlacePrefix(location.pathname);
  const link = parseConversationLink(`${normalizedPath}${location.search}${location.hash}`);
  const target = link?.kind === 'room'
    ? `${placeRoutePrefix(connectionId)}${link.href}`
    : placeNewPath(connectionId);
  return <Navigate to={target} replace />;
}
