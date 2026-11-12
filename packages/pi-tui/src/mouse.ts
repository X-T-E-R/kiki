/**
 * SGR mouse report parsing (`\x1b[<button;col;rowM` / `…m`) and component
 * hit-test routing interfaces.
 *
 * Terminal SGR coordinates are 1-indexed; `parseSgrMouse` normalizes `col` and
 * `row` to 0-based indices for direct indexing into rendered screen lines.
 */

export const MOUSE_TRACKING_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_TRACKING_OFF = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

/** A decoded SGR or legacy X10 mouse report. */
export interface SgrMouseEvent {
	/** Raw button code (bit 32 = motion, bit 64 = wheel, low bits = button). */
	button: number;
	/** 0-based screen column of the event. */
	col: number;
	/** 0-based screen row of the event. */
	row: number;
	/** True for a release report (`m` suffix in SGR). */
	release: boolean;
	/**
	 * Vertical wheel direction: -1 up, 1 down, null when not a vertical wheel
	 * event. Horizontal wheel reports (buttons 66/67) are excluded so sideways
	 * trackpad drift does not jump vertical lists.
	 */
	wheel: -1 | 1 | null;
	/** True when the pointer moved (hover or drag) rather than clicked. */
	motion: boolean;
	/** True for a primary-button press (not motion, not release, not wheel). */
	leftClick: boolean;
	/** True for a secondary-button press (not motion, not release, not wheel). */
	rightClick: boolean;
}

/**
 * Decode an SGR mouse report (`\x1b[<btn;col;row[Mm]`) or legacy X10 6-byte
 * report (`\x1b[M<btn><col><row>`), returning `null` when `data` is not one.
 */
export function parseSgrMouse(data: string): SgrMouseEvent | null {
	if (data.startsWith("\x1b[<")) {
		const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
		if (!match) return null;
		const button = Number.parseInt(match[1]!, 10);
		const col = Math.max(0, Number.parseInt(match[2]!, 10) - 1);
		const row = Math.max(0, Number.parseInt(match[3]!, 10) - 1);
		const release = match[4] === "m";
		const wheel = (button & 64) !== 0 && (button & 2) === 0 ? ((button & 1 ? 1 : -1) as 1 | -1) : null;
		const motion = (button & 32) !== 0 && wheel === null;
		const leftClick = !release && wheel === null && !motion && (button & 3) === 0;
		const rightClick = !release && wheel === null && !motion && (button & 3) === 2;
		return { button, col, row, release, wheel, motion, leftClick, rightClick };
	}
	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const button = data.charCodeAt(3) - 32;
		const col = Math.max(0, data.charCodeAt(4) - 33);
		const row = Math.max(0, data.charCodeAt(5) - 33);
		const release = (button & 3) === 3 && (button & 64) === 0;
		const wheel = (button & 64) !== 0 && (button & 2) === 0 ? ((button & 1 ? 1 : -1) as 1 | -1) : null;
		const motion = (button & 32) !== 0 && wheel === null;
		const leftClick = !release && wheel === null && !motion && (button & 3) === 0;
		const rightClick = !release && wheel === null && !motion && (button & 3) === 2;
		return { button, col, row, release, wheel, motion, leftClick, rightClick };
	}
	return null;
}

/** Quick check for raw SGR or X10 mouse input sequences. */
export function isMouseSequence(data: string): boolean {
	if (data.startsWith("\x1b[<")) {
		return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data);
	}
	return data.length === 6 && data.startsWith("\x1b[M");
}

/**
 * Implemented by components that accept routed mouse events at component-local
 * 0-based `(line, col)` coordinates. Returning `true` consumes the event;
 * returning `false` lets parent containers or viewport scrolling handle it.
 */
export interface MouseRoutable {
	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean;
	/**
	 * Optional callback invoked when a primary-button click lands outside this
	 * component while it is focused or mounted as an interactive popup/overlay.
	 * Returning `true` consumes the outside click.
	 */
	onOutsideMouseDown?(event: SgrMouseEvent): boolean;
}

/** Type guard for components implementing {@link MouseRoutable}. */
export function isMouseRoutable(component: unknown): component is MouseRoutable {
	return (
		typeof component === "object" &&
		component !== null &&
		"routeMouse" in component &&
		typeof (component as MouseRoutable).routeMouse === "function"
	);
}

/**
 * Optional layout metadata implemented by padded containers (such as
 * GutterContainer) so `TuiMainScreen` and `TuiAltScreen` can measure child
 * heights at the exact inner width and offset local columns accurately.
 */
export interface PaddedHitContainer {
	getInnerWidth(outerWidth: number): number;
	getInnerColOffset(): number;
}

export function isPaddedHitContainer(component: unknown): component is PaddedHitContainer {
	return (
		typeof component === "object" &&
		component !== null &&
		"getInnerWidth" in component &&
		typeof (component as PaddedHitContainer).getInnerWidth === "function" &&
		"getInnerColOffset" in component &&
		typeof (component as PaddedHitContainer).getInnerColOffset === "function"
	);
}
