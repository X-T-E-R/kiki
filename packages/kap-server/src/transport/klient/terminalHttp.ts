import { Error2, ErrorCodes, ISessionTerminalService, isError2, resumeSessionById, type Scope, type TerminalFrame } from '@kiki/agent-core-v2';
import type { KlientFrame } from '@kiki/klient/host';
import { terminalAttachMessageSchema, terminalDetachMessageSchema, terminalInputMessageSchema, terminalResizeMessageSchema } from '../../protocol/ws-control';
import { ErrorCode } from '../../protocol/error-codes';
import { randomUUID } from 'node:crypto';

export class TerminalHttpConnection {
  private readonly id = `klient-terminal-${randomUUID()}`;
  private readonly attachments = new Map<string, ISessionTerminalService>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly core: Scope, private readonly enabled: boolean, private readonly send: (frame: KlientFrame) => void) {}

  receive(frame: KlientFrame): boolean {
    if (!['terminal_attach', 'terminal_detach', 'terminal_input', 'terminal_resize'].includes(frame.type)) return false;
    this.queue = this.queue.then(() => this.control(frame));
    return true;
  }

  private async resolve(sessionId: string): Promise<ISessionTerminalService> {
    const session = await resumeSessionById(this.core.accessor, sessionId);
    if (session === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    return session.accessor.get(ISessionTerminalService);
  }

  private ack(frame: KlientFrame, code: number, msg: string, data: unknown = {}): void {
    if (!this.closed) this.send({ type: 'terminal_ack', id: frame.id, code, msg, data });
  }

  private async control(frame: KlientFrame): Promise<void> {
    if (this.closed) return;
    if (!this.enabled) {
      this.ack(frame, ErrorCode.TERMINAL_NOT_FOUND, 'terminal unavailable');
      return;
    }
    const wire = { type: frame.type, id: frame.id, payload: frame.data };
    try {
      switch (frame.type) {
        case 'terminal_attach': {
          const parsed = terminalAttachMessageSchema.safeParse(wire);
          if (!parsed.success) { this.ack(frame, ErrorCode.VALIDATION_FAILED, 'invalid terminal_attach payload'); return; }
          const { session_id, terminal_id, since_seq } = parsed.data.payload;
          const service = await this.resolve(session_id);
          if (this.closed) return;
          const key = JSON.stringify([session_id, terminal_id]);
          this.attachments.set(key, service);
          try {
            const result = await service.attach(terminal_id, { id: this.id, send: (output) => this.output(service, output) }, { sinceSeq: since_seq });
            if (this.closed) { service.detach(terminal_id, this.id); this.attachments.delete(key); return; }
            this.ack(frame, 0, 'success', { replayed: result.replayed, earliest_seq: result.earliestSeq, truncated: result.truncated });
          } catch (error) { this.attachments.delete(key); throw error; }
          return;
        }
        case 'terminal_detach': {
          const parsed = terminalDetachMessageSchema.safeParse(wire);
          if (!parsed.success) { this.ack(frame, ErrorCode.VALIDATION_FAILED, 'invalid terminal_detach payload'); return; }
          const { session_id, terminal_id } = parsed.data.payload;
          const service = await this.resolve(session_id);
          if (this.closed) return;
          await service.get(terminal_id);
          service.detach(terminal_id, this.id);
          this.attachments.delete(JSON.stringify([session_id, terminal_id]));
          this.ack(frame, 0, 'success');
          return;
        }
        case 'terminal_input': {
          const parsed = terminalInputMessageSchema.safeParse(wire);
          if (!parsed.success) { this.ack(frame, ErrorCode.VALIDATION_FAILED, 'invalid terminal_input payload'); return; }
          const { session_id, terminal_id, data } = parsed.data.payload;
          const service = await this.resolve(session_id);
          if (!this.closed) await service.write(terminal_id, data);
          return;
        }
        case 'terminal_resize': {
          const parsed = terminalResizeMessageSchema.safeParse(wire);
          if (!parsed.success) { this.ack(frame, ErrorCode.VALIDATION_FAILED, 'invalid terminal_resize payload'); return; }
          const { session_id, terminal_id, cols, rows } = parsed.data.payload;
          const service = await this.resolve(session_id);
          if (!this.closed) await service.resize(terminal_id, cols, rows);
          return;
        }
      }
    } catch (error) {
      const code = isError2(error) && error.code === ErrorCodes.SESSION_NOT_FOUND ? ErrorCode.SESSION_NOT_FOUND
        : isError2(error) && error.code === ErrorCodes.TERMINAL_NOT_FOUND ? ErrorCode.TERMINAL_NOT_FOUND : ErrorCode.INTERNAL_ERROR;
      this.ack(frame, code, code === ErrorCode.INTERNAL_ERROR ? 'internal error' : (error as Error).message);
    }
  }

  private output(service: ISessionTerminalService, frame: TerminalFrame): void {
    if (this.closed) return;
    this.send({ type: frame.type, data: frame });
    if (frame.type === 'terminal_exit') {
      service.detach(frame.terminal_id, this.id);
      this.attachments.delete(JSON.stringify([frame.session_id, frame.terminal_id]));
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const service of new Set(this.attachments.values())) service.detachAllForSink(this.id);
    this.attachments.clear();
  }
}
