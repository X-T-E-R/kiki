import { timingSafeEqual } from 'node:crypto';

export interface McpSeat {
  readonly seatId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly delegationToken: string;
  readonly workspacePath?: string;
}

export interface SeatResolver {
  resolve(bearer: string): Promise<McpSeat | null>;
}

export function createEnvSeatResolver(seat: McpSeat): SeatResolver {
  return {
    async resolve(bearer) {
      return tokensEqual(bearer, seat.delegationToken) ? seat : null;
    },
  };
}

export function createCompositeSeatResolver(
  primary: SeatResolver | undefined,
  fallback: SeatResolver | undefined,
): SeatResolver {
  return {
    async resolve(bearer) {
      if (primary !== undefined) {
        const seat = await primary.resolve(bearer);
        if (seat !== null) return seat;
      }
      if (fallback === undefined) return null;
      return fallback.resolve(bearer);
    },
  };
}

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
