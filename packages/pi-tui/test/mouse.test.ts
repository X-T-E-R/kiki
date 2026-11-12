import assert from "node:assert";
import { describe, it } from "node:test";
import {
	Container,
	Editor,
	MOUSE_TRACKING_OFF,
	MOUSE_TRACKING_ON,
	type MouseRoutable,
	type PaddedHitContainer,
	parseSgrMouse,
	SelectList,
	SettingsList,
	type SgrMouseEvent,
	Text,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
	ScrollView,
	matchesKey,
} from "../src/index.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class PaddedBox extends Container implements PaddedHitContainer {
	private readonly pad: number;

	constructor(pad: number) {
		super();
		this.pad = pad;
	}

	getInnerWidth(outerWidth: number): number {
		return Math.max(1, outerWidth - this.pad * 2);
	}

	getInnerColOffset(): number {
		return this.pad;
	}

	override render(width: number): string[] {
		const inner = this.getInnerWidth(width);
		const prefix = " ".repeat(this.pad);
		return super.render(inner).map((line) => `${prefix}${line}`);
	}
}

class ClickableBlock implements MouseRoutable {
	public expanded = false;
	public clicks: Array<{ line: number; col: number }> = [];

	invalidate(): void {}

	render(_width: number): string[] {
		return this.expanded ? ["▼ Read file.ts", "  1 | const x = 1;"] : ["▶ Read file.ts"];
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		if (event.leftClick && line === 0) {
			this.expanded = !this.expanded;
			this.clicks.push({ line, col });
			return true;
		}
		return false;
	}
}

describe("SGR mouse parsing & routing", () => {
	it("parses 1-indexed SGR clicks, releases, motion, and vertical wheel while ignoring horizontal wheel", () => {
		const leftPress = parseSgrMouse("\x1b[<0;12;5M");
		assert.deepStrictEqual(leftPress, {
			button: 0,
			col: 11,
			row: 4,
			release: false,
			wheel: null,
			motion: false,
			leftClick: true,
			rightClick: false,
		});

		const leftRelease = parseSgrMouse("\x1b[<0;12;5m");
		assert.ok(leftRelease);
		assert.strictEqual(leftRelease.release, true);
		assert.strictEqual(leftRelease.leftClick, false);

		const wheelUp = parseSgrMouse("\x1b[<64;10;3M");
		assert.ok(wheelUp);
		assert.strictEqual(wheelUp.wheel, -1);
		assert.strictEqual(wheelUp.leftClick, false);

		const wheelDown = parseSgrMouse("\x1b[<65;10;3M");
		assert.ok(wheelDown);
		assert.strictEqual(wheelDown.wheel, 1);

		const wheelHoriz = parseSgrMouse("\x1b[<66;10;3M");
		assert.ok(wheelHoriz);
		assert.strictEqual(wheelHoriz.wheel, null);
		assert.strictEqual(wheelHoriz.leftClick, false);

		assert.strictEqual(parseSgrMouse("hello"), null);
	});

	it("recognizes Ctrl+Enter in both CSI-u and modifyOtherKeys encodings", () => {
		assert.strictEqual(matchesKey("\x1b[13;5u", "ctrl+enter"), true);
		assert.strictEqual(matchesKey("\x1b[27;5;13~", "ctrl+enter"), true);
		assert.strictEqual(matchesKey("\r", "ctrl+enter"), false);
	});

	it("toggles mouse tracking escape sequences in TuiMainScreen cleanly", () => {
		const writes: string[] = [];
		const term = new VirtualTerminal(80, 24);
		const origWrite = term.write.bind(term);
		term.write = (data: string) => {
			writes.push(data);
			origWrite(data);
		};

		const ui = new TuiMainScreen(term, false, undefined, { mouse: true });
		ui.start();
		assert.strictEqual(ui.getMouseReporting(), true);
		assert.strictEqual(writes.some((chunk) => chunk.includes(MOUSE_TRACKING_ON)), true);

		writes.length = 0;
		ui.setMouseReporting(false);
		assert.strictEqual(ui.getMouseReporting(), false);
		assert.strictEqual(writes.some((chunk) => chunk.includes(MOUSE_TRACKING_OFF)), true);

		writes.length = 0;
		ui.setMouseReporting(true);
		assert.strictEqual(writes.some((chunk) => chunk.includes(MOUSE_TRACKING_ON)), true);

		writes.length = 0;
		ui.stop();
		assert.strictEqual(writes.some((chunk) => chunk.includes(MOUSE_TRACKING_OFF)), true);
	});

	it("routes clicks and wheel events to padded children and SelectList in TuiMainScreen without leaking bytes to editor", () => {
		const term = new VirtualTerminal(80, 24);
		const ui = new TuiMainScreen(term, false, undefined, { mouse: true });
		const gutter = new PaddedBox(2);
		const block = new ClickableBlock();
		gutter.addChild(new Text("Welcome header", 0, 0));
		gutter.addChild(block);

		let selectedValue: string | undefined;
		const list = new SelectList(
			[
				{ value: "one", label: "One" },
				{ value: "two", label: "Two" },
				{ value: "three", label: "Three" },
			],
			5,
			{
				selectedPrefix: (s) => s,
				selectedText: (s) => s,
				description: (s) => s,
				scrollInfo: (s) => s,
				noMatch: (s) => s,
			},
		);
		list.onSelect = (item) => {
			selectedValue = item.value;
		};
		gutter.addChild(list);
		ui.addChild(gutter);
		ui.setFocus(list);
		ui.start();
		ui.renderNow();

		// Row 0 is "Welcome header", Row 1 is ClickableBlock ("▶ Read file.ts" indented by 2 cols)
		// SGR is 1-indexed: col=5 (-> localCol=2), row=2 (-> bufferRow=1)
		term.sendInput("\x1b[<0;5;2M");
		assert.strictEqual(block.expanded, true);
		assert.deepStrictEqual(block.clicks, [{ line: 0, col: 2 }]);

		ui.renderNow();
		// Now block takes 2 rows (rows 1..2), so SelectList starts at row 3 (1-indexed row 4).
		// Wheel down anywhere moves selection from "one" -> "two"
		term.sendInput("\x1b[<65;40;10M");
		assert.strictEqual(list.getSelectedItem()?.value, "two");

		// Click third item at row 3 + 2 = 5 (1-indexed row 6)
		term.sendInput("\x1b[<0;6;6M");
		assert.strictEqual(selectedValue, "three");
		ui.stop();
	});

	it("routes clicks to SettingsList items and Editor autocomplete items, dismissing on outside click", async () => {
		const term = new VirtualTerminal(80, 24);
		const ui = new TuiMainScreen(term, false, undefined, { mouse: true });
		const changes: Array<[string, string]> = [];
		let cancelled = false;
		const settings = new SettingsList(
			[
				{ id: "busy", label: "Busy Enter", currentValue: "send_now", values: ["send_now", "queue"] },
				{ id: "mouse", label: "Mouse", currentValue: "on", values: ["on", "off"] },
			],
			8,
			{
				label: (t) => t,
				value: (t) => t,
				description: (t) => t,
				cursor: "❯ ",
				hint: (t) => t,
			},
			(id, val) => changes.push([id, val]),
			() => {
				cancelled = true;
			},
		);
		ui.addChild(settings);
		ui.setFocus(settings);
		ui.start();
		ui.renderNow();

		// Click second setting row (0-based row 1 -> 1-indexed row 2)
		term.sendInput("\x1b[<0;4;2M");
		assert.deepStrictEqual(changes, [["mouse", "off"]]);

		// Click outside below settings (row 20) dismisses via onOutsideMouseDown
		term.sendInput("\x1b[<0;4;20M");
		assert.strictEqual(cancelled, true);

		// Test Editor autocomplete click
		ui.clear();
		const submitted: string[] = [];
		const editor = new Editor(ui, {
			borderColor: (s) => s,
			selectList: {
				selectedPrefix: (s) => s,
				selectedText: (s) => s,
				description: (s) => s,
				scrollInfo: (s) => s,
				noMatch: (s) => s,
			},
		});
		editor.onSubmit = (text) => submitted.push(text);
		editor.setAutocompleteProvider({
			getSuggestions: async () => ({
				prefix: "/",
				items: [
					{ value: "/model", label: "/model" },
					{ value: "/settings", label: "/settings" },
				],
			}),
			applyCompletion: (_lines, _line, _col, item) => ({
				lines: [item.value],
				cursorLine: 0,
				cursorCol: item.value.length,
			}),
		});
		ui.addChild(editor);
		ui.setFocus(editor);
		term.sendInput("/");
		await new Promise((r) => setTimeout(r, 10));
		ui.renderNow();
		assert.strictEqual(editor.isShowingAutocomplete(), true);

		// Editor renders: row 0 top border, row 1 input line, row 2 bottom border, row 3 "/model", row 4 "/settings"
		// Click "/settings" at 0-based row 4 -> 1-indexed row 5
		term.sendInput("\x1b[<0;5;5M");
		assert.deepStrictEqual(submitted, ["/settings"]);
		assert.strictEqual(editor.isShowingAutocomplete(), false);
		ui.stop();
	});

	it("routes clicks inside ScrollView content in TuiAltScreen before text selection", () => {
		const term = new VirtualTerminal(80, 20);
		const ui = new TuiAltScreen(term, false, undefined, { mouse: true });
		const transcript = new Container();
		for (let i = 0; i < 15; i++) {
			transcript.addChild(new Text(`Line ${i}`, 0, 0));
		}
		const block = new ClickableBlock();
		transcript.addChild(block);

		const scrollView = new ScrollView(transcript, { follow: "end", primary: true });
		const dock = new ClickableBlock();
		const root = new VStack();
		root.addChild(scrollView, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
		root.addChild(dock, { basis: "auto", grow: 0, shrink: 1, minSize: 1 });
		ui.setLayoutRoot(root);
		ui.start();
		ui.renderNow();

		// Viewport height is 20: dock takes 1 row (row 19), scrollView takes rows 0..18 (19 rows).
		// Total content in transcript = 15 + 1 = 16 rows (< 19), so block is at row 15 (1-indexed 16).
		term.sendInput("\x1b[<0;3;16M");
		assert.strictEqual(block.expanded, true);

		// Click dock at row 19 (1-indexed 20)
		term.sendInput("\x1b[<0;3;20M");
		assert.strictEqual(dock.expanded, true);
		ui.stop();
	});
});
