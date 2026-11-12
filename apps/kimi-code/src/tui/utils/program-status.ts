import {
  PROGRAM_STATUS_OSC_PREFIX as OSC_PREFIX,
  PROGRAM_STATUS_ST as ST,
  PROGRAM_STATUS_MAX_BYTES as MAX_REPORT_BYTES,
  PROGRAM_STATUS_TICKET_WINDOW_MS as TICKET_WINDOW_MS,
  PROGRAM_STATUS_TICKET_LIMIT as MAX_TICKETS_PER_WINDOW,
  PROGRAM_STATUS_FRAGMENT_TIMEOUT_MS,
} from '#/tui/constant/program-status';

export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error' | 'clear';
export type ProgramBlockKind = 'permission' | 'question' | 'auth';

export interface ProgramStatusReport {
  readonly state: ProgramState;
  readonly kind?: ProgramBlockKind;
  readonly title?: string;
  readonly msg?: string;
  readonly handoff?: {
    readonly session?: string;
    readonly port: string;
    readonly server: string;
  };
}

export interface ProgramStatusTicket {
  readonly ticket: string;
  readonly challenge: string;
}

export function truncateProgramText(text: string, maxBytes: number): string {
  const clean = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '');
  let bytes = 0;
  let result = '';
  for (const point of clean) {
    bytes += Buffer.byteLength(point);
    if (bytes > maxBytes) break;
    result += point;
  }
  return result;
}

export function encodeProgramStatus(report: ProgramStatusReport, ticket?: ProgramStatusTicket): string {
  if (report.state === 'clear') return `${OSC_PREFIX}state=clear:app=kiki${ST}`;
  const fields = [`state=${report.state}`];
  if (report.state === 'blocked' && report.kind !== undefined) fields.push(`kind=${report.kind}`);
  fields.push('app=kiki');
  const title = truncateProgramText(report.title ?? '', 192);
  if (title !== '') fields.push(`title=${Buffer.from(title).toString('base64')}`);
  const handoff = report.handoff;
  if (handoff !== undefined && !Object.values(handoff).some((value) => /[:;\p{Cc}]/u.test(value))) {
    const extension = ['handoff=1'];
    if (handoff.session !== undefined) extension.push(`session=${handoff.session}`);
    extension.push(`port=${handoff.port}`, `server=${handoff.server}`);
    if (Buffer.byteLength(`${OSC_PREFIX}${[...fields, ...extension].join(':')}${ST}`) <= MAX_REPORT_BYTES - 128) {
      fields.push(...extension);
    }
  }
  if (ticket !== undefined) fields.push(`ticket=${ticket.ticket}`, `challenge=${ticket.challenge}`);
  const fixed = `${OSC_PREFIX}${fields.join(':')}`;
  const available = MAX_REPORT_BYTES - Buffer.byteLength(fixed + ST + ':msg=');
  const msg = truncateProgramText(report.msg ?? '', Math.min(2048, Math.floor(available / 4) * 3));
  return `${fixed}${msg === '' ? '' : `:msg=${Buffer.from(msg).toString('base64')}`}${ST}`;
}

export class ProgramStatusReporter {
  private support: 'pending' | 'supported' | 'unsupported' = 'pending';
  private report: ProgramStatusReport = { state: 'idle' };
  private previous: string | undefined;
  private pendingChallenge: string | undefined;
  private replyBuffer = '';
  private replyBufferedAt = 0;
  private answering = false;
  private stopped = false;
  private readonly ticketTimes: number[] = [];

  constructor(
    private readonly write: (sequence: string) => void,
    private readonly requestTicket: (challenge: string) => Promise<string | undefined>,
    private readonly now = Date.now,
    private readonly admitTicket = () => true,
  ) {}

  start(): void {
    this.write(`${OSC_PREFIX}?${ST}\x1b[c`);
  }

  get supported(): boolean {
    return this.support === 'supported';
  }

  update(report: ProgramStatusReport, force = false): void {
    this.report = report;
    this.emit(undefined, force);
  }

  handleInput(data: string): { consume: true } | { data: string } | undefined {
    if (this.replyBuffer !== '' && (this.now() - this.replyBufferedAt > PROGRAM_STATUS_FRAGMENT_TIMEOUT_MS || data === '\x03' || data === '\x04' || data.startsWith('\x1b['))) this.replyBuffer = '';
    const fragment = data.length > 2 && data.startsWith('\x1b]') && (OSC_PREFIX.startsWith(data) || data.startsWith(OSC_PREFIX));
    if (this.replyBuffer !== '' || fragment) {
      const buffered = this.replyBuffer !== '';
      data = this.replyBuffer + data;
      this.replyBuffer = '';
      if (!OSC_PREFIX.startsWith(data) && !data.startsWith(OSC_PREFIX)) return { data };
      if (!/(?:\x1b\\|\x07)/u.test(data)) {
        if (Buffer.byteLength(data) <= MAX_REPORT_BYTES) {
          if (!buffered) this.replyBufferedAt = this.now();
          this.replyBuffer = data;
        }
        return { consume: true };
      }
    }
    if (/^\x1b\[\?[\d;]*c$/u.test(data)) {
      if (this.support === 'pending') this.support = 'unsupported';
      return { consume: true };
    }
    const pasted = data.startsWith('\x1b[200~');
    const remaining = data.replace(/\x1b\]7501;(\?[\s\S]*?)(?:\x1b\\|\x07)/gu, (_sequence, body: string) => {
      if (pasted) return '';
      if (body.startsWith('?ticket=')) {
        if (this.supported) this.enqueueTicket(body.slice('?ticket='.length));
      } else if (this.support === 'pending') {
        this.support = 'supported';
        this.emit();
      }
      return '';
    });
    if (remaining === data) return undefined;
    return remaining === '' ? { consume: true } : { data: remaining };
  }

  discardQueuedTicket(): void {
    if (this.pendingChallenge === undefined) return;
    this.pendingChallenge = undefined;
    this.emit(undefined, true);
  }

  clear(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pendingChallenge = undefined;
    if (this.supported) this.write(encodeProgramStatus({ state: 'clear' }));
  }

  private emit(ticket?: ProgramStatusTicket, force = false): void {
    if (!this.supported || this.stopped) return;
    const sequence = encodeProgramStatus(this.report, ticket);
    if (!force && sequence === this.previous) return;
    this.previous = sequence;
    this.write(sequence);
  }

  private enqueueTicket(challenge: string): void {
    const now = this.now();
    while (this.ticketTimes[0] !== undefined && this.ticketTimes[0] <= now - TICKET_WINDOW_MS) this.ticketTimes.shift();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(challenge) || this.ticketTimes.length >= MAX_TICKETS_PER_WINDOW || !this.admitTicket()) {
      this.emit(undefined, true);
      return;
    }
    this.pendingChallenge = challenge;
    if (!this.answering) void this.answerTickets();
  }

  private async answerTickets(): Promise<void> {
    this.answering = true;
    try {
      while (this.pendingChallenge !== undefined && !this.stopped) {
        const challenge = this.pendingChallenge;
        this.pendingChallenge = undefined;
        const now = this.now();
        while (this.ticketTimes[0] !== undefined && this.ticketTimes[0] <= now - TICKET_WINDOW_MS) this.ticketTimes.shift();
        if (this.ticketTimes.length >= MAX_TICKETS_PER_WINDOW) {
          this.emit(undefined, true);
          continue;
        }
        let ticket: string | undefined;
        try {
          ticket = await this.requestTicket(challenge);
        } catch {
          ticket = undefined;
        }
        if (this.stopped) return;
        if (ticket !== undefined) this.ticketTimes.push(this.now());
        this.emit(ticket === undefined ? undefined : { ticket, challenge }, true);
      }
    } finally {
      this.answering = false;
    }
  }
}
