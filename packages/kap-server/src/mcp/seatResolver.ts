import { timingSafeEqual } from 'node:crypto';

export interface McpSeat {
  readonly sessionId: string;
  readonly delegationToken: string;
}

export interface SeatResolver {
  resolve(bearer: string): McpSeat | null;
}

export function createEnvSeatResolver(seat: McpSeat): SeatResolver {
  return {
    resolve(bearer) {
      return tokensEqual(bearer, seat.delegationToken) ? seat : null;
    },
  };
}

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
