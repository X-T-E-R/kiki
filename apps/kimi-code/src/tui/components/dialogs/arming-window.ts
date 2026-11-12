/**
 * Arming window for dialogs the system mounts on its own (approval, question).
 *
 * Such a dialog replaces the input box while the user may still be typing, so
 * a keystroke meant for the draft must not choose an option. For a short
 * window after mount the dialog ignores the keys that choose or confirm, and
 * every key that arrives inside the window starts it over: the dialog arms
 * only once the user has stopped typing (DESIGN.md, "打断式对话框").
 */

export interface ArmingOptions {
  /** Window length in ms. Undefined or 0 arms at once — the dialog accepts every key immediately. */
  readonly armAfterMs?: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Called once when the window ends, so the host can re-render the dialog in
   * its armed look. Without it no timer is scheduled and the armed look only
   * appears on the next render.
   */
  readonly onArmed?: () => void;
}

export class ArmingWindow {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly onArmed: (() => void) | undefined;
  private armsAt: number;
  private armed: boolean;

  constructor(options: ArmingOptions = {}) {
    this.windowMs = Math.max(0, options.armAfterMs ?? 0);
    this.now = options.now ?? Date.now;
    this.onArmed = options.onArmed;
    this.armed = this.windowMs === 0;
    this.armsAt = this.armed ? 0 : this.now() + this.windowMs;
    if (!this.armed && this.onArmed !== undefined) this.schedule(this.windowMs);
  }

  isArmed(): boolean {
    if (!this.armed && this.now() >= this.armsAt) this.armed = true;
    return this.armed;
  }

  /**
   * Call for every key that is not an explicit cancel. Returns true once
   * armed; while unarmed it restarts the window and returns false, and the
   * caller must not choose or confirm anything with that key.
   */
  admitKey(): boolean {
    if (this.isArmed()) return true;
    this.armsAt = this.now() + this.windowMs;
    return false;
  }

  private schedule(delayMs: number): void {
    const timer = setTimeout(() => {
      if (this.isArmed()) {
        this.onArmed?.();
        return;
      }
      this.schedule(Math.max(1, this.armsAt - this.now()));
    }, delayMs);
    timer.unref?.();
  }
}
