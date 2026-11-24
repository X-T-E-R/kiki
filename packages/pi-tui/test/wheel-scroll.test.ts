import assert from "node:assert";
import { describe, it } from "node:test";
import { terminalAcceleratesWheel, WheelScrollAccelerator } from "../src/wheel-scroll.ts";

describe("WheelScrollAccelerator", () => {
	it("moves 1 line on the first notch and scales up to 6 on fast spins", () => {
		const accel = new WheelScrollAccelerator("auto", true);
		assert.strictEqual(accel.next(1, 1000), 1);
		assert.strictEqual(accel.next(1, 1050), 2);
		assert.strictEqual(accel.next(1, 1070), 2);
		assert.strictEqual(accel.next(1, 1080), 5);
		assert.strictEqual(accel.next(1, 1090), 6);
		assert.strictEqual(accel.next(1, 1100), 6);
	});

	it("keeps sub-5ms bursts at 1 line without accelerating", () => {
		const accel = new WheelScrollAccelerator("auto", true);
		assert.strictEqual(accel.next(-1, 500), 1);
		assert.strictEqual(accel.next(-1, 502), 1);
		assert.strictEqual(accel.next(-1, 504), 1);
		assert.strictEqual(accel.next(-1, 506), 1);
	});

	it("resets on direction change or after a 200ms pause", () => {
		const accel = new WheelScrollAccelerator("auto", true);
		assert.strictEqual(accel.next(1, 100), 1);
		assert.strictEqual(accel.next(1, 120), 5);
		// Direction reversal resets to 1
		assert.strictEqual(accel.next(-1, 140), 1);
		assert.strictEqual(accel.next(-1, 160), 5);
		// Pause > 200ms resets to 1
		assert.strictEqual(accel.next(-1, 361), 1);
	});

	it("stays at 1 line per event when terminal already accelerates wheel (local macOS)", () => {
		assert.strictEqual(terminalAcceleratesWheel("darwin", {}), true);
		assert.strictEqual(terminalAcceleratesWheel("darwin", { SSH_CONNECTION: "1" }), false);
		assert.strictEqual(terminalAcceleratesWheel("darwin", { SSH_CLIENT: "1" }), false);
		assert.strictEqual(terminalAcceleratesWheel("darwin", { SSH_TTY: "/dev/pts/0" }), false);
		assert.strictEqual(terminalAcceleratesWheel("linux", {}), false);
		assert.strictEqual(terminalAcceleratesWheel("win32", {}), false);

		const macLocal = new WheelScrollAccelerator("auto", false);
		assert.strictEqual(macLocal.next(1, 100), 1);
		assert.strictEqual(macLocal.next(1, 120), 1);
		assert.strictEqual(macLocal.next(1, 130), 1);
	});

	it("honors explicit numeric wheelScrollLines", () => {
		const accel = new WheelScrollAccelerator(3, true);
		assert.strictEqual(accel.next(1, 100), 3);
		assert.strictEqual(accel.next(1, 110), 3);
		accel.setLines(0);
		assert.strictEqual(accel.next(-1, 120), 1);
		accel.setLines(Number.NaN);
		assert.strictEqual(accel.next(-1, 130), 1);
	});
});
