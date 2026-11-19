/* oxlint-disable */
// Denial accounting, step usage and subagent projection are adapted from Paseo (Apache-2.0).
// Copyright (c) 2025-present Mohamed Boudra. Modified for Kiki's ACP bridge; see packages/acp-client/THIRD_PARTY_NOTICES.md.
import { isAbsolute, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AGY_COMMAND_GUIDANCE_HOOK_KEY, AGY_STEERING_HOOK_KEY, recoverProjectHook, registerProjectHook } from "./agy-hook-registration.mjs";
import { recoverDeadProjectMcpPlugins, recoverProjectMcpPlugin, registerProjectMcpPlugin } from "./agy-mcp-plugin.mjs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { openPermissionChannel, permissionChannelIdentity, requestHookPermission } from "./agy-permission-hook.mjs";

//#region src/types.ts
const MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT = "engine-default";
const EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
const NATIVE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const NATIVE_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/i;
const LEGACY_NATIVE_STEP = {
	user: 14,
	planner: 15,
	error: 17,
	ephemeral: 90,
	system: 101,
	tool: 132
};
const LEGACY_NETWORK_FAILURE = "There was a network issue connecting to the server, please try again.";
const NETWORK_RECOVERY_INSTRUCTION = "The connection to the model provider was interrupted after your last completed step. Continue the same task from where it stopped. Do not repeat tool calls that already finished.";
const NETWORK_RECOVERY_BACKOFF_MS = [
	1e3,
	3e3,
	7e3,
	15e3,
	25e3
];
const NETWORK_RECOVERY_EXIT_GRACE_MS = 5e3;
const ERROR_RESULT_WATCHDOG_MS = 15e3;

//#endregion
//#region src/catalog.ts
const CATALOG_TIMEOUT_MS = 2e4;
const CATALOG_MAX_BYTES = 65536;
function processAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code !== "ESRCH";
	}
}
function takeNewDenials(actions, reported) {
	const counts = /* @__PURE__ */ new Map();
	const fresh = (actions ?? []).filter((action) => {
		const key = JSON.stringify([action?.action, action?.display_name]);
		const count = (counts.get(key) ?? 0) + 1;
		counts.set(key, count);
		return count > (reported.get(key) ?? 0);
	});
	for (const [key, count] of counts) reported.set(key, Math.max(count, reported.get(key) ?? 0));
	return fresh;
}
function accumulateStepUsage(usageSteps, totals, step) {
	if (step?.state !== "DONE" || !step.usage || !Number.isSafeInteger(step.step_index) || usageSteps.has(step.step_index)) return false;
	usageSteps.add(step.step_index);
	totals.inputTokens += Number(step.usage.input_tokens) || 0;
	totals.outputTokens += Number(step.usage.output_tokens) || 0;
	totals.cachedReadTokens += Number(step.usage.cache_read_tokens) || 0;
	totals.thoughtTokens += Number(step.usage.thinking_tokens) || 0;
	totals.totalTokens += Number(step.usage.total_tokens) || 0;
	return true;
}
function emptyUsage() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cachedReadTokens: 0,
		thoughtTokens: 0,
		totalTokens: 0
	};
}
function subagentPayload(step) {
	if (!step?.subagent_info) return void 0;
	return { subagents: (step.subagent_info.subagents ?? []).map((child) => ({
		type_name: child?.type_name,
		initial_prompt: child?.initial_prompt,
		conversation_id: child?.conversation_id,
		log_uri: child?.log_uri
	})) };
}
function encodedEffort(model) {
	return EFFORTS.find((effort) => model.endsWith(`-${effort}`));
}
function validateEffort(model, effort) {
	if (!["engine-default", ...EFFORTS].includes(effort)) throw new Error("Unsupported AGY effort selection");
	const encoded = encodedEffort(model);
	if (effort === "engine-default") return;
	if (encoded === void 0) throw new Error(`AGY model ID ${model} does not embed an effort; effort ${effort} is not an advertised config for this id`);
	if (effort !== encoded) throw new Error(`AGY model ID ${model} encodes effort ${encoded} and conflicts with effort ${effort}; select the corresponding raw AGY model ID instead`);
}
function launchArgs(session) {
	validateEffort(session.model, session.effort);
	const args = [
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json"
	];
	if (session.conversationId) args.push("--conversation", session.conversationId);
	if (session.model !== "engine-default") args.push("--model", session.model);
	if (session.effort !== "engine-default" && !session.model.startsWith("claude-")) args.push("--effort", session.effort);
	const mode = session.permissionMode ?? "engine-default";
	if (mode === "yolo") args.push("--dangerously-skip-permissions");
	const settings = mode === "manual" ? {
		toolPermission: "request-review",
		agentMode: "default"
	} : mode === "auto" ? {
		toolPermission: "request-review",
		agentMode: "auto"
	} : mode === "yolo" ? {
		toolPermission: "always-proceed",
		agentMode: "accept-edits",
		allowNonWorkspaceAccess: true,
		enableTerminalSandbox: false
	} : void 0;
	const accountSettings = session.accountBound ? {
		modelProvider: "gemini",
		customModelsConfig: { customModels: { [session.model]: {
			modelName: `gemini-api://models/${session.model}`,
			toolFormatterType: "TOOL_FORMATTER_TYPE_NONE"
		} } }
	} : void 0;
	if (settings !== void 0 || accountSettings !== void 0) args.push("--settings", JSON.stringify({
		...settings,
		...accountSettings
	}));
	for (const dir of session.additionalDirectories) args.push("--add-dir", dir);
	return args;
}
function promptText(blocks) {
	if (!Array.isArray(blocks) || blocks.some((b) => b?.type !== "text" || typeof b.text !== "string")) throw new Error("This AGY ACP adapter accepts text prompts only; CLI rich-input support has not been verified");
	const text = blocks.map((b) => b.text).join("\n");
	if (Buffer.byteLength(text) > 1048576 / 2) throw new Error("AGY prompt exceeds the adapter frame limit");
	return text;
}
/** First whitespace token of each `agy models` row. Header and comment rows are not ids. */
function vendorModelIds(output) {
	const values = [];
	const seen = /* @__PURE__ */ new Set();
	for (const line of String(output).split(/\r?\n/u)) {
		const first = (line.trim().split(/\s+/u)[0] ?? "").trim();
		if (first === "" || first.startsWith("#") || /^(?:id|model|models|name)$/iu.test(first)) continue;
		if (first.length > 256 || /\s/u.test(first) || seen.has(first)) continue;
		seen.add(first);
		values.push(first);
	}
	return values;
}
function safeDiagnosticLine(text) {
	const line = text.trim();
	if (line.length === 0 || /(?:token|bearer|api[_-]?key|secret|authorization|password)/iu.test(line) || /[A-Za-z0-9+/_-]{32,}={0,2}/u.test(line) || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(line)) return;
	return line.slice(0, 180);
}
function catalogDiagnostic(text) {
	return safeDiagnosticLine(String(text).split(/\r?\n/u).map((part) => part.trim()).find(Boolean) ?? "") ?? "AGY model catalog probe failed";
}
function readVendorModelCatalog({ cliPath, cliPrefix = [], spawnProcess = spawn, stopProcess, timeoutMs = CATALOG_TIMEOUT_MS, maxOutputBytes = CATALOG_MAX_BYTES } = {}) {
	return new Promise((resolveCatalog) => {
		let child;
		let settled = false;
		let overflow = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveCatalog(result);
		};
		const timer = setTimeout(() => {
			const stopping = child === void 0 ? void 0 : Promise.resolve(stopProcess ? stopProcess(child) : child.kill?.()).catch(() => {});
			Promise.resolve(stopping).finally(() => finish({
				ok: false,
				diagnostic: "AGY model catalog probe timed out"
			}));
		}, timeoutMs);
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		try {
			child = spawnProcess(cliPath ?? "", [...cliPrefix, "models"], {
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				],
				windowsHide: true
			});
		} catch (error) {
			finish({
				ok: false,
				diagnostic: catalogDiagnostic(error instanceof Error ? error.message : String(error))
			});
			return;
		}
		const take = (current, chunk) => {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			const next = Buffer.concat([current, bytes]);
			if (next.length > maxOutputBytes) {
				overflow = true;
				child?.kill?.();
				return next.subarray(0, maxOutputBytes);
			}
			return next;
		};
		child.stdout?.on("data", (chunk) => {
			stdout = take(stdout, chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr = take(stderr, chunk);
		});
		child.once?.("error", (error) => finish({
			ok: false,
			diagnostic: catalogDiagnostic(error instanceof Error ? error.message : String(error))
		}));
		child.once?.("close", (code) => {
			if (overflow) finish({
				ok: false,
				diagnostic: "AGY model catalog probe exceeded the output limit"
			});
			else if (code !== 0) finish({
				ok: false,
				diagnostic: catalogDiagnostic(stderr.toString("utf8") || `AGY model catalog probe exited ${code}`)
			});
			else finish({
				ok: true,
				ids: vendorModelIds(stdout.toString("utf8"))
			});
		});
	});
}
function configOptions(session) {
	const effort = encodedEffort(session.model);
	const options = [{
		id: "effort",
		name: "AGY effort",
		category: "thought_level",
		type: "select",
		currentValue: session.effort,
		options: [{
			value: DEFAULT,
			name: "Follow AGY settings"
		}, ...effort ? [{
			value: effort,
			name: effort
		}] : []]
	}];
	if (Array.isArray(session.modelChoices)) options.push({
		id: "model",
		name: "AGY model",
		category: "model",
		type: "select",
		currentValue: session.model,
		options: session.modelChoices.length === 0 ? [] : [...session.accountBound ? [] : [{
			value: DEFAULT,
			name: "Follow AGY settings"
		}], ...session.modelChoices.map((id) => ({
			value: id,
			name: id
		}))]
	});
	options.push({
		id: "native-agent",
		name: "AGY native agent",
		category: "native_agent",
		type: "select",
		currentValue: DEFAULT,
		options: [{
			value: DEFAULT,
			name: "Follow AGY default agent"
		}]
	});
	options.push({
		id: "permission-mode",
		name: "AGY permissions",
		category: "permission_mode",
		type: "select",
		currentValue: session.permissionMode ?? "engine-default",
		options: [
			{
				value: DEFAULT,
				name: "Follow AGY settings"
			},
			{
				value: "manual",
				name: "Request review"
			},
			{
				value: "auto",
				name: "AGY auto mode"
			},
			{
				value: "yolo",
				name: "Full access"
			}
		]
	});
	return options;
}
async function terminate(child) {
	const running = () => child?.pid !== void 0 && child.exitCode === null && child.signalCode === null;
	if (!running() || !child) return;
	let onClose;
	const closed = new Promise((done) => {
		onClose = done;
		child.once("close", onClose);
	});
	try {
		if (process.platform === "win32") {
			const killer = spawn(resolve(process.env["SystemRoot"] ?? "C:/Windows", "System32/taskkill.exe"), [
				"/PID",
				String(child.pid),
				"/T",
				"/F"
			], {
				windowsHide: true,
				stdio: "ignore"
			});
			await new Promise((done, reject) => {
				killer.once("error", reject);
				killer.once("close", (code, signal) => code === 0 ? done() : reject(/* @__PURE__ */ new Error(`taskkill exited with ${code ?? signal}`)));
			});
		} else if (!child.kill("SIGTERM")) throw new Error("SIGTERM was not delivered");
	} catch (error) {
		if (running()) {
			child.off("close", onClose);
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Could not stop the owned AGY process: ${message}`, { cause: error });
		}
	}
	await closed;
}
function consumeAccountEnvironment(env = process.env) {
	const apiKey = env["GEMINI_API_KEY"];
	const baseUrl = env["GOOGLE_GEMINI_BASE_URL"];
	const rawModels = env["KIKI_AGY_ACCOUNT_MODELS"];
	delete env["GEMINI_API_KEY"];
	delete env["GOOGLE_GEMINI_BASE_URL"];
	delete env["KIKI_AGY_ACCOUNT_MODELS"];
	const modelIds = JSON.parse(rawModels ?? "null");
	if (typeof apiKey !== "string" || !apiKey || typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl) || !Array.isArray(modelIds) || modelIds.length === 0 || modelIds.some((id) => typeof id !== "string" || !id || /\s/.test(id) || id === "engine-default")) throw new Error("The selected account connection is unavailable; no global AGY fallback is allowed");
	return {
		apiKey,
		baseUrl,
		modelIds
	};
}

//#endregion
//#region ../../node_modules/.pnpm/@bufbuild+protobuf@2.17.0/node_modules/@bufbuild/protobuf/dist/esm/wire/varint.js
/**
* Read a 64 bit varint as two JS numbers.
*
* Stores the low and high words on the reader.
*
* Copyright 2008 Google Inc.  All rights reserved.
*
* See https://github.com/protocolbuffers/protobuf/blob/8a71927d74a4ce34efe2d8769fda198f52d20d12/js/experimental/runtime/kernel/buffer_decoder.js#L175
*/
function varint64read() {
	const buf = this.buf;
	let pos = this.pos;
	let lo = 0;
	let hi = 0;
	for (let shift = 0; shift < 28; shift += 7) {
		const b = buf[pos++];
		lo |= (b & 127) << shift;
		if ((b & 128) == 0) {
			this.pos = pos;
			this.assertBounds();
			this.varint64Lo = lo;
			this.varint64Hi = hi;
			return;
		}
	}
	const middleByte = buf[pos++];
	lo |= (middleByte & 15) << 28;
	hi = (middleByte & 112) >> 4;
	if ((middleByte & 128) == 0) {
		this.pos = pos;
		this.assertBounds();
		this.varint64Lo = lo;
		this.varint64Hi = hi;
		return;
	}
	for (let shift = 3; shift <= 31; shift += 7) {
		const b = buf[pos++];
		hi |= (b & 127) << shift;
		if ((b & 128) == 0) {
			this.pos = pos;
			this.assertBounds();
			this.varint64Lo = lo;
			this.varint64Hi = hi;
			return;
		}
	}
	throw new Error("invalid varint");
}
const TWO_PWR_32_DBL = 4294967296;
/**
* Parse decimal string of 64 bit integer value as two JS numbers.
*
* Copyright 2008 Google Inc.  All rights reserved.
*
* See https://github.com/protocolbuffers/protobuf-javascript/blob/a428c58273abad07c66071d9753bc4d1289de426/experimental/runtime/int64.js#L10
*/
function int64FromString(dec) {
	const minus = dec[0] === "-";
	if (minus) dec = dec.slice(1);
	const base = 1e6;
	let lowBits = 0;
	let highBits = 0;
	function add1e6digit(begin, end) {
		const digit1e6 = Number(dec.slice(begin, end));
		highBits *= base;
		lowBits = lowBits * base + digit1e6;
		if (lowBits >= TWO_PWR_32_DBL) {
			highBits = highBits + (lowBits / TWO_PWR_32_DBL | 0);
			lowBits = lowBits % TWO_PWR_32_DBL;
		}
	}
	add1e6digit(-24, -18);
	add1e6digit(-18, -12);
	add1e6digit(-12, -6);
	add1e6digit(-6);
	return minus ? negate(lowBits, highBits) : newBits(lowBits, highBits);
}
/**
* Losslessly converts a 64-bit signed integer in 32:32 split representation
* into a decimal string.
*
* Copyright 2008 Google Inc.  All rights reserved.
*
* See https://github.com/protocolbuffers/protobuf-javascript/blob/a428c58273abad07c66071d9753bc4d1289de426/experimental/runtime/int64.js#L10
*/
function int64ToString(lo, hi) {
	let bits = newBits(lo, hi);
	const negative = bits.hi & 2147483648;
	if (negative) bits = negate(bits.lo, bits.hi);
	const result = uInt64ToString(bits.lo, bits.hi);
	return negative ? "-" + result : result;
}
/**
* Losslessly converts a 64-bit unsigned integer in 32:32 split representation
* into a decimal string.
*
* Copyright 2008 Google Inc.  All rights reserved.
*
* See https://github.com/protocolbuffers/protobuf-javascript/blob/a428c58273abad07c66071d9753bc4d1289de426/experimental/runtime/int64.js#L10
*/
function uInt64ToString(lo, hi) {
	({lo, hi} = toUnsigned(lo, hi));
	if (hi <= 2097151) return String(TWO_PWR_32_DBL * hi + lo);
	const low = lo & 16777215;
	const mid = (lo >>> 24 | hi << 8) & 16777215;
	const high = hi >> 16 & 65535;
	let digitA = low + mid * 6777216 + high * 6710656;
	let digitB = mid + high * 8147497;
	let digitC = high * 2;
	const base = 1e7;
	if (digitA >= base) {
		digitB += Math.floor(digitA / base);
		digitA %= base;
	}
	if (digitB >= base) {
		digitC += Math.floor(digitB / base);
		digitB %= base;
	}
	return digitC.toString() + decimalFrom1e7WithLeadingZeros(digitB) + decimalFrom1e7WithLeadingZeros(digitA);
}
function toUnsigned(lo, hi) {
	return {
		lo: lo >>> 0,
		hi: hi >>> 0
	};
}
function newBits(lo, hi) {
	return {
		lo: lo | 0,
		hi: hi | 0
	};
}
/**
* Returns two's compliment negation of input.
* @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Bitwise_Operators#Signed_32-bit_integers
*/
function negate(lowBits, highBits) {
	highBits = ~highBits;
	if (lowBits) lowBits = ~lowBits + 1;
	else highBits += 1;
	return newBits(lowBits, highBits);
}
/**
* Returns decimal representation of digit1e7 with leading zeros.
*/
const decimalFrom1e7WithLeadingZeros = (digit1e7) => {
	const partial = String(digit1e7);
	return "0000000".slice(partial.length) + partial;
};
/**
* Read an unsigned 32 bit varint.
*
* See https://github.com/protocolbuffers/protobuf/blob/8a71927d74a4ce34efe2d8769fda198f52d20d12/js/experimental/runtime/kernel/buffer_decoder.js#L220
*/
function varint32read() {
	let b = this.buf[this.pos++];
	if ((b & 128) === 0) {
		this.assertBounds();
		return b;
	}
	let result = b & 127;
	b = this.buf[this.pos++];
	result |= (b & 127) << 7;
	if ((b & 128) === 0) {
		this.assertBounds();
		return result;
	}
	b = this.buf[this.pos++];
	result |= (b & 127) << 14;
	if ((b & 128) === 0) {
		this.assertBounds();
		return result;
	}
	b = this.buf[this.pos++];
	result |= (b & 127) << 21;
	if ((b & 128) === 0) {
		this.assertBounds();
		return result;
	}
	b = this.buf[this.pos++];
	result |= (b & 15) << 28;
	for (let readBytes = 5; (b & 128) !== 0 && readBytes < 10; readBytes++) b = this.buf[this.pos++];
	if ((b & 128) !== 0) throw new Error("invalid varint");
	this.assertBounds();
	return result >>> 0;
}

//#endregion
//#region ../../node_modules/.pnpm/@bufbuild+protobuf@2.17.0/node_modules/@bufbuild/protobuf/dist/esm/proto-int64.js
/**
* Int64Support for the current environment.
*/
const protoInt64 = /* @__PURE__ */ makeInt64Support();
function makeInt64Support() {
	const dv = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(8));
	if (typeof BigInt === "function" && typeof dv.getBigInt64 === "function" && typeof dv.getBigUint64 === "function" && typeof dv.setBigInt64 === "function" && typeof dv.setBigUint64 === "function" && (!!globalThis.Deno || !!globalThis.Bun || typeof process != "object" || typeof process.env != "object" || process.env.BUF_BIGINT_DISABLE !== "1")) {
		const MIN = BigInt("-9223372036854775808");
		const MAX = BigInt("9223372036854775807");
		const UMIN = BigInt("0");
		const UMAX = BigInt("18446744073709551615");
		return {
			zero: BigInt(0),
			supported: true,
			parse(value) {
				const bi = typeof value == "bigint" ? value : BigInt(value);
				if (bi > MAX || bi < MIN) throw new Error(`invalid int64: ${value}`);
				return bi;
			},
			uParse(value) {
				const bi = typeof value == "bigint" ? value : BigInt(value);
				if (bi > UMAX || bi < UMIN) throw new Error(`invalid uint64: ${value}`);
				return bi;
			},
			enc(value) {
				dv.setBigInt64(0, this.parse(value), true);
				return {
					lo: dv.getInt32(0, true),
					hi: dv.getInt32(4, true)
				};
			},
			uEnc(value) {
				dv.setBigInt64(0, this.uParse(value), true);
				return {
					lo: dv.getInt32(0, true),
					hi: dv.getInt32(4, true)
				};
			},
			dec(lo, hi) {
				dv.setInt32(0, lo, true);
				dv.setInt32(4, hi, true);
				return dv.getBigInt64(0, true);
			},
			uDec(lo, hi) {
				dv.setInt32(0, lo, true);
				dv.setInt32(4, hi, true);
				return dv.getBigUint64(0, true);
			}
		};
	}
	return {
		zero: "0",
		supported: false,
		parse(value) {
			if (typeof value != "string") value = value.toString();
			assertInt64String(value);
			return value;
		},
		uParse(value) {
			if (typeof value != "string") value = value.toString();
			assertUInt64String(value);
			return value;
		},
		enc(value) {
			if (typeof value != "string") value = value.toString();
			assertInt64String(value);
			return int64FromString(value);
		},
		uEnc(value) {
			if (typeof value != "string") value = value.toString();
			assertUInt64String(value);
			return int64FromString(value);
		},
		dec(lo, hi) {
			return int64ToString(lo, hi);
		},
		uDec(lo, hi) {
			return uInt64ToString(lo, hi);
		}
	};
}
function assertInt64String(value) {
	if (!/^-?[0-9]+$/.test(value)) throw new Error("invalid int64: " + value);
}
function assertUInt64String(value) {
	if (!/^[0-9]+$/.test(value)) throw new Error("invalid uint64: " + value);
}

//#endregion
//#region ../../node_modules/.pnpm/@bufbuild+protobuf@2.17.0/node_modules/@bufbuild/protobuf/dist/esm/wire/text-encoding.js
let te;
/**
* Protobuf-ES requires the Text Encoding API to convert UTF-8 from and to
* binary. This WHATWG API is widely available, but it is not part of the
* ECMAScript standard. This function used to be the way to supply an
* implementation on runtimes that do not provide one.
*
* It only configures the copy of the library it is imported from. To provide
* the encoding API for every copy of Protobuf-ES in an isolate, install
* `TextEncoder` (with the methods `encode` and optionally `encodeInto`) and
* `TextDecoder` (with the `fatal: true` and `ignoreBOM: true` constructor
* arguments and the `decode` method) on `globalThis`.
*
* Providing `encodeUtf8Into` is optional for backwards compatibility. If it
* is omitted, we emulate it with a wrapper that calls `encodeUtf8`.
*
* Note that the Text Encoding API does not provide a way to validate UTF-8.
* Our implementation uses String.prototype.isWellFormed, and falls back
* to use encodeURIComponent().
*
* @deprecated Install `TextEncoder` and `TextDecoder` on `globalThis` instead.
*/
function configureTextEncoding(textEncoding) {
	var _a;
	te = Object.assign(Object.assign({}, textEncoding), { encodeUtf8Into: (_a = textEncoding.encodeUtf8Into) !== null && _a !== void 0 ? _a : emulateEncodeInto(textEncoding.encodeUtf8.bind(textEncoding)) });
}
function getTextEncoding() {
	if (!te) {
		const globals = globalThis;
		if (!globals.TextEncoder || !globals.TextDecoder) throw new Error("encoding API missing: install TextEncoder and TextDecoder on globalThis");
		const textEncoder = new globals.TextEncoder();
		const textDecoder = new globals.TextDecoder("utf-8", { ignoreBOM: true });
		let textDecoderStrict;
		const config = {
			encodeUtf8(text) {
				return textEncoder.encode(text);
			},
			decodeUtf8(bytes, strict) {
				if (strict) {
					if (!textDecoderStrict) textDecoderStrict = new globals.TextDecoder("utf-8", {
						fatal: true,
						ignoreBOM: true
					});
					return textDecoderStrict.decode(bytes);
				}
				return textDecoder.decode(bytes);
			},
			checkUtf8(text) {
				try {
					return true;
				} catch (_) {
					return false;
				}
			}
		};
		if (textEncoder.encodeInto) config.encodeUtf8Into = textEncoder.encodeInto.bind(textEncoder);
		const nativeStringIsWellFormed = String.prototype.isWellFormed;
		if (nativeStringIsWellFormed) config.checkUtf8 = (text) => {
			return nativeStringIsWellFormed.call(text);
		};
		configureTextEncoding(config);
	}
	return te;
}
/**
* Simplistic polyfill for encodeUtf8Into.
*
* @private
*/
function emulateEncodeInto(encodeUtf8) {
	return (text, dest) => {
		const bytes = encodeUtf8(text);
		dest.set(bytes);
		return { written: bytes.byteLength };
	};
}

//#endregion
//#region ../../node_modules/.pnpm/@bufbuild+protobuf@2.17.0/node_modules/@bufbuild/protobuf/dist/esm/wire/binary-encoding.js
/**
* Protobuf binary format wire types.
*
* A wire type provides just enough information to find the length of the
* following value.
*
* See https://developers.google.com/protocol-buffers/docs/encoding#structure
*/
var WireType;
(function(WireType) {
	/**
	* Used for int32, int64, uint32, uint64, sint32, sint64, bool, enum
	*/
	WireType[WireType["Varint"] = 0] = "Varint";
	/**
	* Used for fixed64, sfixed64, double.
	* Always 8 bytes with little-endian byte order.
	*/
	WireType[WireType["Bit64"] = 1] = "Bit64";
	/**
	* Used for string, bytes, embedded messages, packed repeated fields
	*
	* Only repeated numeric types (types which use the varint, 32-bit,
	* or 64-bit wire types) can be packed. In proto3, such fields are
	* packed by default.
	*/
	WireType[WireType["LengthDelimited"] = 2] = "LengthDelimited";
	/**
	* Start of a tag-delimited aggregate, such as a proto2 group, or a message
	* in editions with message_encoding = DELIMITED.
	*/
	WireType[WireType["StartGroup"] = 3] = "StartGroup";
	/**
	* End of a tag-delimited aggregate.
	*/
	WireType[WireType["EndGroup"] = 4] = "EndGroup";
	/**
	* Used for fixed32, sfixed32, float.
	* Always 4 bytes with little-endian byte order.
	*/
	WireType[WireType["Bit32"] = 5] = "Bit32";
})(WireType || (WireType = {}));
/**
* Maximum value for an unsigned 32-bit integer (Protobuf UINT32, FIXED32).
*/
const UINT32_MAX = 4294967295;
/**
* Maximum value for a signed 32-bit integer (Protobuf INT32, SFIXED32, SINT32).
*/
const INT32_MAX = 2147483647;
/**
* Minimum value for a signed 32-bit integer (Protobuf INT32, SFIXED32, SINT32).
*/
const INT32_MIN = -2147483648;
var BinaryWriter = class {
	constructor(encodeUtf8) {
		/**
		* Previous fork positions (the write position at the time
		* `fork()` was called).
		*/
		this.stackPos = [];
		this.encodeUtf8Into = encodeUtf8 ? emulateEncodeInto(encodeUtf8) : getTextEncoding().encodeUtf8Into;
		this.buffer = EMPTY_BUFFER;
		this.viewCache = EMPTY_VIEW;
		this.pos = 0;
	}
	ensureCapacity(size) {
		const required = this.pos + size;
		if (required > this.buffer.length) {
			let newLen = this.buffer.length || INITIAL_SIZE;
			while (newLen < required) newLen *= 2;
			const newBuf = new Uint8Array(newLen);
			if (this.pos > 0) newBuf.set(this.buffer);
			this.buffer = newBuf;
		}
	}
	/**
	* The DataView over `buffer`, rebuilt only if the buffer has grown since it
	* was last used.
	*/
	view() {
		const bytes = this.buffer;
		const view = this.viewCache;
		if (view.byteLength === bytes.byteLength) return view;
		const newView = new DataView(bytes.buffer);
		this.viewCache = newView;
		return newView;
	}
	/**
	* Return all bytes written and reset this writer.
	*/
	finish() {
		const result = this.buffer.slice(0, this.pos);
		this.pos = 0;
		this.stackPos = [];
		return result;
	}
	/**
	* Start a new fork for length-delimited data like a message
	* or a packed repeated field.
	*
	* Must be joined later with `join()`.
	*/
	fork() {
		this.stackPos.push(this.pos);
		this.ensureCapacity(DEFAULT_LEN_PREFIX_SIZE);
		this.buffer[this.pos++] = 0;
		return this;
	}
	/**
	* Join the last fork. Write its length and bytes, then
	* return to the previous state.
	*/
	join() {
		const forkPos = this.stackPos.pop();
		if (forkPos === void 0) throw new Error("invalid state, fork stack empty");
		const len = this.pos - forkPos - DEFAULT_LEN_PREFIX_SIZE;
		const lenPrefixSize = varint32Size(len);
		if (lenPrefixSize > DEFAULT_LEN_PREFIX_SIZE) {
			this.ensureCapacity(lenPrefixSize - DEFAULT_LEN_PREFIX_SIZE);
			this.buffer.copyWithin(forkPos + lenPrefixSize, forkPos + DEFAULT_LEN_PREFIX_SIZE, this.pos);
		}
		this.pos = forkPos;
		this.uint32(len);
		this.pos += len;
		return this;
	}
	/**
	* Writes a tag (field number and wire type).
	*
	* Equivalent to `uint32( (fieldNo << 3 | type) >>> 0 )`.
	*
	* Generated code should compute the tag ahead of time and call `uint32()`.
	*/
	tag(fieldNo, type) {
		return this.uint32((fieldNo << 3 | type) >>> 0);
	}
	/**
	* Write a chunk of raw bytes.
	*/
	raw(chunk) {
		this.ensureCapacity(chunk.length);
		this.buffer.set(chunk, this.pos);
		this.pos += chunk.length;
		return this;
	}
	/**
	* Write a `uint32` value, an unsigned 32 bit varint.
	*/
	uint32(value) {
		assertUInt32(value);
		this.ensureCapacity(5);
		if (value < 128) {
			this.buffer[this.pos++] = value;
			return this;
		}
		while (value > 127) {
			this.buffer[this.pos++] = value & 127 | 128;
			value >>>= 7;
		}
		this.buffer[this.pos++] = value;
		return this;
	}
	/**
	* Write a `int32` value, a signed 32 bit varint.
	*/
	int32(value) {
		assertInt32(value);
		if (value >= 0) return this.uint32(value);
		this.ensureCapacity(10);
		for (let i = 0; i < 9; i++) {
			this.buffer[this.pos++] = value & 127 | 128;
			value >>= 7;
		}
		this.buffer[this.pos++] = 1;
		return this;
	}
	/**
	* Write a `bool` value, a varint.
	*/
	bool(value) {
		this.ensureCapacity(1);
		this.buffer[this.pos++] = value ? 1 : 0;
		return this;
	}
	/**
	* Write a `bytes` value, length-delimited arbitrary data.
	*/
	bytes(value) {
		this.uint32(value.byteLength);
		return this.raw(value);
	}
	/**
	* Write a `string` value, length-delimited data converted to UTF-8 text.
	*/
	string(value) {
		if (typeof value !== "string") value = String(value);
		const len = value.length;
		if (len <= ASCII_MAX_LENGTH) {
			this.ensureCapacity(len + 1);
			const ascii = this.buffer;
			let pos = this.pos;
			ascii[pos++] = len;
			let i = 0;
			for (; i < len; i++) {
				const code = value.charCodeAt(i);
				if (code > 127) break;
				ascii[pos++] = code;
			}
			if (i == len) {
				this.pos = pos;
				return this;
			}
		}
		this.ensureCapacity(len * 3 + 5);
		const lenPrefixSizeGuess = varint32Size(len);
		const buf = this.buffer;
		const start = this.pos;
		const { written } = this.encodeUtf8Into(value, buf.subarray(start + lenPrefixSizeGuess));
		const lenPrefixSize = varint32Size(written);
		if (lenPrefixSize != lenPrefixSizeGuess) buf.copyWithin(start + lenPrefixSize, start + lenPrefixSizeGuess, start + lenPrefixSizeGuess + written);
		this.uint32(written);
		this.pos += written;
		return this;
	}
	/**
	* Write a `float` value, 32-bit floating point number.
	*/
	float(value) {
		assertFloat32(value);
		this.ensureCapacity(4);
		this.view().setFloat32(this.pos, value, true);
		this.pos += 4;
		return this;
	}
	/**
	* Write a `double` value, a 64-bit floating point number.
	*/
	double(value) {
		this.ensureCapacity(8);
		this.view().setFloat64(this.pos, value, true);
		this.pos += 8;
		return this;
	}
	/**
	* Write a `fixed32` value, an unsigned, fixed-length 32-bit integer.
	*/
	fixed32(value) {
		assertUInt32(value);
		this.ensureCapacity(4);
		this.view().setUint32(this.pos, value, true);
		this.pos += 4;
		return this;
	}
	/**
	* Write a `sfixed32` value, a signed, fixed-length 32-bit integer.
	*/
	sfixed32(value) {
		assertInt32(value);
		this.ensureCapacity(4);
		this.view().setInt32(this.pos, value, true);
		this.pos += 4;
		return this;
	}
	/**
	* Write a `sint32` value, a signed, zigzag-encoded 32-bit varint.
	*/
	sint32(value) {
		assertInt32(value);
		return this.uint32((value << 1 ^ value >> 31) >>> 0);
	}
	/**
	* Write a `sfixed64` value, a signed, fixed-length 64-bit integer.
	*/
	sfixed64(value) {
		const tc = protoInt64.enc(value);
		this.ensureCapacity(8);
		const view = this.view();
		view.setInt32(this.pos, tc.lo, true);
		view.setInt32(this.pos + 4, tc.hi, true);
		this.pos += 8;
		return this;
	}
	/**
	* Write a `fixed64` value, an unsigned, fixed-length 64 bit integer.
	*/
	fixed64(value) {
		const tc = protoInt64.uEnc(value);
		this.ensureCapacity(8);
		const view = this.view();
		view.setInt32(this.pos, tc.lo, true);
		view.setInt32(this.pos + 4, tc.hi, true);
		this.pos += 8;
		return this;
	}
	/**
	* Write a `int64` value, a signed 64-bit varint.
	*/
	int64(value) {
		const tc = protoInt64.enc(value);
		return this.writeVarint64(tc.lo, tc.hi);
	}
	/**
	* Write a `sint64` value, a signed, zig-zag-encoded 64-bit varint.
	*/
	sint64(value) {
		const tc = protoInt64.enc(value), sign = tc.hi >> 31, lo = tc.lo << 1 ^ sign, hi = (tc.hi << 1 | tc.lo >>> 31) ^ sign;
		return this.writeVarint64(lo, hi);
	}
	/**
	* Write a `uint64` value, an unsigned 64-bit varint.
	*/
	uint64(value) {
		const tc = protoInt64.uEnc(value);
		return this.writeVarint64(tc.lo, tc.hi);
	}
	/**
	* Write a 64-bit varint directly into the buffer. Accepts the value as
	* split low/high 32-bit words.
	*
	* Ported from varint64write() to avoid the intermediate number[] buffer.
	* See https://github.com/protocolbuffers/protobuf/blob/8a71927d74a4ce34efe2d8769fda198f52d20d12/js/experimental/runtime/kernel/writer.js#L344
	*/
	writeVarint64(lo, hi) {
		this.ensureCapacity(10);
		const buf = this.buffer;
		let pos = this.pos;
		for (let i = 0; i < 28; i = i + 7) {
			const shift = lo >>> i;
			const hasNext = !(shift >>> 7 == 0 && hi == 0);
			buf[pos++] = (hasNext ? shift | 128 : shift) & 255;
			if (!hasNext) {
				this.pos = pos;
				return this;
			}
		}
		const splitBits = lo >>> 28 & 15 | (hi & 7) << 4;
		const hasMoreBits = !(hi >> 3 == 0);
		buf[pos++] = (hasMoreBits ? splitBits | 128 : splitBits) & 255;
		if (!hasMoreBits) {
			this.pos = pos;
			return this;
		}
		for (let i = 3; i < 31; i = i + 7) {
			const shift = hi >>> i;
			const hasNext = !(shift >>> 7 == 0);
			buf[pos++] = (hasNext ? shift | 128 : shift) & 255;
			if (!hasNext) {
				this.pos = pos;
				return this;
			}
		}
		buf[pos++] = hi >>> 31 & 1;
		this.pos = pos;
		return this;
	}
};
/**
* Capacity of the buffer allocated by the first write..
*/
const INITIAL_SIZE = 128;
/**
* Bytes `fork()` reserves for the length prefix, betting that the payload will
* be under 128 bytes. `join()` fills them in, and widens them if the bet was
* wrong.
*/
const DEFAULT_LEN_PREFIX_SIZE = 1;
/**
* Shared empty buffer used as the initial value before the first write.
* Avoids allocating and zeroing `INITIAL_SIZE` bytes per BinaryWriter when a
* writer is only used for a tiny message (or not used at all).
*/
const EMPTY_BUFFER = new Uint8Array(0);
/**
* Shared empty view, paired with `EMPTY_BUFFER`. Never written to: any
* fixed-width write first grows the buffer, which replaces this view.
*/
const EMPTY_VIEW = new DataView(EMPTY_BUFFER.buffer);
/**
* Longest string on the ASCII fast paths. Must stay below 0x80, so
* that the writer's length prefix always fits a single varint byte.
*/
const ASCII_MAX_LENGTH = 32;
/**
* Number of bytes needed to encode `value` as an unsigned 32-bit varint.
*/
function varint32Size(value) {
	if (value < 128) return 1;
	if (value < 16384) return 2;
	if (value < 2097152) return 3;
	if (value < 268435456) return 4;
	return 5;
}
var BinaryReader = class {
	constructor(buf, decodeUtf8 = getTextEncoding().decodeUtf8) {
		this.decodeUtf8 = decodeUtf8;
		this.varint64Lo = 0;
		this.varint64Hi = 0;
		this.varint64 = varint64read;
		/**
		* Read a `uint32` field, an unsigned 32 bit varint.
		*/
		this.uint32 = varint32read;
		this.buf = buf;
		this.len = buf.length;
		this.pos = 0;
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	/**
	* Reads a tag - field number and wire type. Tags are uint32 varints; values
	* that do not fit in uint32 are rejected.
	*/
	tag() {
		const start = this.pos;
		const tag = this.uint32();
		const bytesRead = this.pos - start;
		if (bytesRead > 5 || bytesRead == 5 && this.buf[this.pos - 1] > 15) throw new Error("illegal tag: varint overflows uint32");
		const fieldNo = tag >>> 3;
		const wireType = tag & 7;
		if (fieldNo <= 0 || wireType > 5) throw new Error("illegal tag: field no " + fieldNo + " wire type " + wireType);
		return [fieldNo, wireType];
	}
	/**
	* Skip one element and return the skipped data.
	*
	* When skipping StartGroup, provide the tags field number to check for
	* matching field number in the EndGroup tag. Recursion into nested groups
	* is guarded by the `recursionLimit` argument: When the limit is reached,
	* this method throws.
	*/
	skip(wireType, fieldNo, recursionLimit = 100) {
		let start = this.pos;
		switch (wireType) {
			case WireType.Varint:
				while (this.buf[this.pos++] & 128);
				break;
			case WireType.Bit64: this.pos += 4;
			case WireType.Bit32:
				this.pos += 4;
				break;
			case WireType.LengthDelimited:
				let len = this.uint32();
				this.pos += len;
				break;
			case WireType.StartGroup:
				if (recursionLimit <= 0) throw new Error("maximum recursion depth reached");
				for (;;) {
					const [fn, wt] = this.tag();
					if (wt === WireType.EndGroup) {
						if (fieldNo !== void 0 && fn !== fieldNo) throw new Error("invalid end group tag");
						break;
					}
					this.skip(wt, fn, recursionLimit - 1);
				}
				break;
			default: throw new Error("cant skip wire type " + wireType);
		}
		this.assertBounds();
		return this.buf.subarray(start, this.pos);
	}
	/**
	* Throws error if position in byte array is out of range.
	*/
	assertBounds() {
		if (this.pos > this.len) throw new RangeError("premature EOF");
	}
	/**
	* Read a `int32` field, a signed 32 bit varint.
	*/
	int32() {
		return this.uint32() | 0;
	}
	/**
	* Read a `sint32` field, a signed, zigzag-encoded 32-bit varint.
	*/
	sint32() {
		let zze = this.uint32();
		return zze >>> 1 ^ -(zze & 1);
	}
	/**
	* Read a `int64` field, a signed 64-bit varint.
	*/
	int64() {
		this.varint64();
		return protoInt64.dec(this.varint64Lo, this.varint64Hi);
	}
	/**
	* Read a `uint64` field, an unsigned 64-bit varint.
	*/
	uint64() {
		this.varint64();
		return protoInt64.uDec(this.varint64Lo, this.varint64Hi);
	}
	/**
	* Read a `sint64` field, a signed, zig-zag-encoded 64-bit varint.
	*/
	sint64() {
		this.varint64();
		let lo = this.varint64Lo;
		let hi = this.varint64Hi;
		let s = -(lo & 1);
		lo = (lo >>> 1 | (hi & 1) << 31) ^ s;
		hi = hi >>> 1 ^ s;
		return protoInt64.dec(lo, hi);
	}
	/**
	* Read a `bool` field, a variant.
	*/
	bool() {
		const b = this.buf[this.pos];
		if (b < 128) {
			this.pos++;
			return b !== 0;
		}
		this.varint64();
		return this.varint64Lo !== 0 || this.varint64Hi !== 0;
	}
	/**
	* Read a `fixed32` field, an unsigned, fixed-length 32-bit integer.
	*/
	fixed32() {
		return this.view.getUint32((this.pos += 4) - 4, true);
	}
	/**
	* Read a `sfixed32` field, a signed, fixed-length 32-bit integer.
	*/
	sfixed32() {
		return this.view.getInt32((this.pos += 4) - 4, true);
	}
	/**
	* Read a `fixed64` field, an unsigned, fixed-length 64 bit integer.
	*/
	fixed64() {
		return protoInt64.uDec(this.sfixed32(), this.sfixed32());
	}
	/**
	* Read a `fixed64` field, a signed, fixed-length 64-bit integer.
	*/
	sfixed64() {
		return protoInt64.dec(this.sfixed32(), this.sfixed32());
	}
	/**
	* Read a `float` field, 32-bit floating point number.
	*/
	float() {
		return this.view.getFloat32((this.pos += 4) - 4, true);
	}
	/**
	* Read a `double` field, a 64-bit floating point number.
	*/
	double() {
		return this.view.getFloat64((this.pos += 8) - 8, true);
	}
	/**
	* Read a `bytes` field, length-delimited arbitrary data.
	*/
	bytes() {
		let len = this.uint32(), start = this.pos;
		this.pos += len;
		this.assertBounds();
		return this.buf.subarray(start, start + len);
	}
	/**
	* Read a `string` field, length-delimited data converted to UTF-8 text. If
	* `strict` is true, throw on invalid UTF-8 instead of substituting U+FFFD.
	*/
	string(strict) {
		const len = this.uint32();
		const start = this.pos;
		this.pos += len;
		this.assertBounds();
		const buf = this.buf;
		if (len <= ASCII_MAX_LENGTH) {
			const codes = new Array(len);
			for (let i = 0; i < len; i++) {
				const byte = buf[start + i];
				if (byte > 127) return this.decodeUtf8(buf.subarray(start, this.pos), strict);
				codes[i] = byte;
			}
			return String.fromCharCode.apply(String, codes);
		}
		return this.decodeUtf8(buf.subarray(start, this.pos), strict);
	}
};
/**
* Assert a valid signed protobuf 32-bit integer as a number or string.
*/
function assertInt32(arg) {
	if (typeof arg == "string") arg = Number(arg);
	else if (typeof arg != "number") throw new Error("invalid int32: " + typeof arg);
	if (!Number.isInteger(arg) || arg > 2147483647 || arg < -2147483648) throw new Error("invalid int32: " + arg);
}
/**
* Assert a valid unsigned protobuf 32-bit integer as a number or string.
*/
function assertUInt32(arg) {
	if (typeof arg == "string") arg = Number(arg);
	else if (typeof arg != "number") throw new Error("invalid uint32: " + typeof arg);
	if (!Number.isInteger(arg) || arg > 4294967295 || arg < 0) throw new Error("invalid uint32: " + arg);
}
/**
* Assert a valid protobuf float32 value as a number or string.
*/
function assertFloat32(arg) {
	if (typeof arg == "string") {
		const o = arg;
		arg = Number(arg);
		if (Number.isNaN(arg) && o !== "NaN") throw new Error("invalid float32: " + o);
	} else if (typeof arg != "number") throw new Error("invalid float32: " + typeof arg);
	if (!Number.isFinite(Math.fround(arg)) && Number.isFinite(arg)) throw new Error("invalid float32: " + arg);
}

//#endregion
//#region src/protobuf.ts
const utf8Decoder = new TextDecoder("utf-8");
function toUint8Array(value) {
	if (value instanceof Uint8Array) return value;
	return Uint8Array.from(value);
}
function classifyWireError(error) {
	const message = error instanceof Error ? error.message : String(error);
	if (/invalid field|illegal tag.*field no 0/i.test(message)) return new Error("Unsupported AGY native metadata field", { cause: error });
	if (/invalid varint/i.test(message)) return new Error("Unsupported AGY native metadata encoding", { cause: error });
	if (error instanceof RangeError || /premature eof|beyond end|out of range|eof/i.test(message)) return new Error("Truncated AGY native metadata", { cause: error });
	return new Error("Unsupported AGY native metadata encoding", { cause: error });
}
function nativeBytesAt(value, path, optionalLast = false, repeatedLast = false) {
	let bytes = toUint8Array(value);
	for (const [index, field] of path.entries()) {
		const reader = new BinaryReader(bytes);
		let selected;
		const repeated = [];
		const last = index === path.length - 1;
		while (reader.pos < reader.len) {
			let fieldNo;
			let wireType;
			try {
				[fieldNo, wireType] = reader.tag();
			} catch (error) {
				throw classifyWireError(error);
			}
			if (!fieldNo) throw new Error("Unsupported AGY native metadata field");
			if (wireType === WireType.Varint || wireType === WireType.Bit64 || wireType === WireType.Bit32) try {
				reader.skip(wireType);
			} catch (error) {
				throw classifyWireError(error);
			}
			else if (wireType === WireType.LengthDelimited) {
				let slice;
				try {
					slice = reader.bytes();
				} catch (error) {
					throw classifyWireError(error);
				}
				if (fieldNo === field) if (repeatedLast && last) repeated.push(utf8Decoder.decode(slice));
				else if (selected !== void 0) throw new Error("Ambiguous AGY native metadata binding");
				else selected = slice;
			} else throw new Error("Unsupported AGY native metadata wire type");
		}
		if (repeatedLast && last) {
			if (repeated.length === 0 && !optionalLast) throw new Error("Unconfirmed AGY native metadata binding");
			return repeated;
		}
		if (selected === void 0) {
			if (optionalLast) return repeatedLast ? [] : void 0;
			throw new Error("Unconfirmed AGY native metadata binding");
		}
		bytes = selected;
	}
	return utf8Decoder.decode(bytes);
}
function nativeStringsAt(value, path, optionalLast = false) {
	return nativeBytesAt(value, path, optionalLast, true);
}
function encodeNativeMessage(fields) {
	const writer = new BinaryWriter();
	for (const field of fields) switch (field.kind) {
		case "string":
			writer.tag(field.fieldNo, WireType.LengthDelimited).string(field.value);
			break;
		case "bytes":
			writer.tag(field.fieldNo, WireType.LengthDelimited).bytes(field.value);
			break;
		case "varint":
			writer.tag(field.fieldNo, WireType.Varint).uint32(field.value);
			break;
		case "fixed32":
			writer.tag(field.fieldNo, WireType.Bit32).fixed32(field.value);
			break;
		case "fixed64":
			writer.tag(field.fieldNo, WireType.Bit64).fixed64(field.value);
			break;
		case "message":
			writer.tag(field.fieldNo, WireType.LengthDelimited).bytes(encodeNativeMessage(field.fields));
			break;
	}
	return writer.finish();
}

//#endregion
//#region src/legacyRecovery.ts
async function readLegacyTranscript(path) {
	const file = await open(path, "r");
	try {
		const before = await file.stat();
		if (!before.isFile() || before.size > 2 * 1048576) throw new Error("AGY legacy transcript exceeds the recovery limit");
		const data = Buffer.alloc(before.size + 1);
		const { bytesRead } = await file.read(data, 0, data.length, 0);
		const after = await file.stat();
		if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("AGY legacy transcript changed during recovery");
		return data.subarray(0, bytesRead).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
	} finally {
		await file.close();
	}
}
async function readLegacyNativeRecovery({ nativeHome, cwd, additionalDirectories = [], sessionId, proof, model }) {
	const extraDirs = proof?.additionalDirectories ?? [];
	const disclosedCwd = proof?.disclosedCwd;
	const terminalError = proof?.terminalError ?? "There was a network issue connecting to the server, please try again.";
	if (proof?.version !== 1 || proof.sessionId !== sessionId || !NATIVE_ID.test(sessionId) || !NATIVE_ID.test(proof.conversationId) || !isAbsolute(cwd) || !Array.isArray(additionalDirectories) || additionalDirectories.some((dir) => typeof dir !== "string" || !isAbsolute(dir)) || !Array.isArray(extraDirs) || extraDirs.some((dir) => typeof dir !== "string" || !isAbsolute(dir)) || disclosedCwd !== void 0 && (typeof disclosedCwd !== "string" || !isAbsolute(disclosedCwd)) || proof.model !== model || typeof proof.effort !== "string" || typeof terminalError !== "string" || !terminalError.trim() || /^(?:interrupted|canceled|cancelled)$/i.test(terminalError.trim()) || !Array.isArray(proof.tools) || !proof.tools.length || proof.tools.length > 1e3 || proof.tools.some((tool) => !Number.isSafeInteger(tool?.stepIndex) || tool.stepIndex < 0 || !NATIVE_TOOL_NAME.test(tool.name ?? "") || tool.failed !== void 0 && tool.failed !== true || tool.error !== void 0 && (typeof tool.error !== "string" || !tool.error.trim())) || new Set(proof.tools.map((tool) => tool.stepIndex)).size !== proof.tools.length) throw new Error("AGY legacy load requires an exact original session and completed native tool mapping");
	const canonical = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
	if (disclosedCwd !== void 0 && canonical(disclosedCwd) !== canonical(cwd) || additionalDirectories.length > 0 && (disclosedCwd === void 0 || extraDirs.length !== additionalDirectories.length || extraDirs.some((dir, index) => canonical(dir) !== canonical(additionalDirectories[index]))) || extraDirs.length > 0 && (extraDirs.length !== additionalDirectories.length || extraDirs.some((dir, index) => canonical(dir) !== canonical(additionalDirectories[index])))) throw new Error("AGY legacy native conversation or workspace differs from its original binding");
	const expectedRoots = new Set([cwd, ...additionalDirectories].map(canonical));
	if (expectedRoots.size !== 1 + additionalDirectories.length) throw new Error("AGY legacy native conversation or workspace differs from its original binding");
	const conversationId = proof.conversationId;
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(resolve(nativeHome, "conversations", `${conversationId}.db`), { readOnly: true });
	try {
		db.exec("BEGIN");
		const data = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = ? AND length(data) <= 65536").get("main")?.data ?? new Uint8Array(0);
		const nativeRootUris = nativeStringsAt(data, [7]);
		const nativeRoots = new Set(nativeRootUris.map((uri) => canonical(fileURLToPath(uri))));
		if (nativeBytesAt(data, [6]) !== conversationId || nativeRootUris.length !== expectedRoots.size || nativeRoots.size !== expectedRoots.size || [...expectedRoots].some((root) => !nativeRoots.has(root))) throw new Error("AGY legacy native conversation or workspace differs from its original binding");
		const baseModel = proof.effort !== "engine-default" && model.endsWith(`-${proof.effort}`) ? model.slice(0, -(proof.effort.length + 1)) : model;
		const exactModel = (value) => value === model || value === `gemini-api://models/${model}`;
		const totalModels = Number(db.prepare("SELECT COUNT(*) AS count FROM (SELECT 1 FROM gen_metadata LIMIT 1001)").get()?.count ?? 0);
		if (totalModels === 0 || totalModels > 1e3) throw new Error("AGY legacy native model differs from its original binding");
		const models = db.prepare("SELECT CASE WHEN length(data) <= ? THEN data END AS data FROM gen_metadata ORDER BY idx LIMIT 1001");
		let rowIndex = 0;
		let sawModel = false;
		let sawExactModel = false;
		for (const row of models.iterate(MAX_FRAME_BYTES)) {
			const isLast = rowIndex === totalModels - 1;
			rowIndex += 1;
			const bytes = row.data ?? new Uint8Array(0);
			const name = nativeBytesAt(bytes, [1, 19], true);
			const uri = nativeBytesAt(bytes, [3, 28], true);
			if (name === void 0 && uri === void 0 && !isLast) throw new Error("AGY legacy native model differs from its original binding");
			if (name !== void 0 && name !== model && name !== baseModel) throw new Error("AGY legacy native model differs from its original binding");
			if (uri !== void 0 && !exactModel(uri)) throw new Error("AGY legacy native model differs from its original binding");
			if (name !== void 0 || uri !== void 0) sawModel = true;
			if (name === model || uri !== void 0 && exactModel(uri)) sawExactModel = true;
		}
		if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", "executor_metadata")) {
			const execMeta = db.prepare("SELECT CASE WHEN length(data) <= ? THEN data END AS data FROM executor_metadata ORDER BY idx LIMIT 10");
			for (const row of execMeta.iterate(MAX_FRAME_BYTES)) {
				const uri = nativeBytesAt(row.data ?? new Uint8Array(0), [
					10,
					1,
					28
				], true);
				if (uri !== void 0 && !exactModel(uri)) throw new Error("AGY legacy native model differs from its original binding");
				if (uri !== void 0 && exactModel(uri)) sawExactModel = true;
			}
		}
		if (rowIndex !== totalModels || !sawModel || !sawExactModel) throw new Error("AGY legacy native model differs from its original binding");
		const steps = db.prepare("SELECT idx, step_type, status FROM steps ORDER BY idx LIMIT 10001").all();
		const allowedStepTypes = Object.values(LEGACY_NATIVE_STEP);
		if (!steps.length || steps.length > 1e4 || steps.some((step, index) => step.idx !== index || !allowedStepTypes.includes(step.step_type) || (step.step_type === LEGACY_NATIVE_STEP.tool ? step.status !== 3 && step.status !== 7 : step.status !== 3)) || steps.filter((step) => step.step_type === LEGACY_NATIVE_STEP.user).length !== 1) throw new Error("AGY legacy native turn has unresolved steps or unknown steering; do not replay it");
		const step0Bytes = db.prepare("SELECT step_payload FROM steps WHERE idx = 0 AND length(step_payload) <= 65536").get()?.step_payload ?? new Uint8Array(0);
		if (proof.promptSha256 !== void 0) {
			const step0Text = nativeBytesAt(step0Bytes, [19, 2], true);
			if (typeof step0Text !== "string" || createHash("sha256").update(step0Text).digest("hex") !== proof.promptSha256) throw new Error("AGY legacy native initial prompt differs from its audited prompt digest");
		}
		const step0Uris = nativeStringsAt(step0Bytes, [
			19,
			12,
			12
		], true);
		if (step0Uris.length > 0) {
			const step0Roots = new Set(step0Uris.map((uri) => canonical(fileURLToPath(uri))));
			if (step0Uris.length !== expectedRoots.size || step0Roots.size !== expectedRoots.size || [...expectedRoots].some((root) => !step0Roots.has(root))) throw new Error("AGY legacy native conversation or workspace differs from its original binding");
		}
		const terminal = steps.at(-1);
		const terminalBytes = db.prepare("SELECT step_payload FROM steps WHERE idx = ? AND length(step_payload) <= 65536").get(terminal.idx)?.step_payload ?? new Uint8Array(0);
		const terminalErr1 = nativeBytesAt(terminalBytes, [
			24,
			3,
			1
		], true);
		const terminalErr2 = nativeBytesAt(terminalBytes, [
			24,
			3,
			2
		], true);
		if (terminal.step_type !== LEGACY_NATIVE_STEP.error || terminalErr1 !== terminalError && terminalErr2 !== terminalError) throw new Error("AGY legacy native turn has no confirmed terminal network failure");
		const toolSteps = steps.filter((step) => step.step_type === LEGACY_NATIVE_STEP.tool);
		const toolByIndex = new Map(toolSteps.map((step) => [step.idx, step]));
		if (toolByIndex.size !== proof.tools.length || proof.tools.some((tool) => !toolByIndex.has(tool.stepIndex))) throw new Error("AGY legacy native tools differ from the completed Kiki tool mapping");
		const selectStepPayload = db.prepare("SELECT step_payload FROM steps WHERE idx = ? AND length(step_payload) <= 65536");
		for (const tool of proof.tools) {
			const step = toolByIndex.get(tool.stepIndex);
			if (tool.failed === true !== (step.status === 7)) throw new Error("AGY legacy native tools differ from the completed Kiki tool mapping");
			const toolPayload = selectStepPayload.get(tool.stepIndex)?.step_payload ?? new Uint8Array(0);
			const nativeName = nativeBytesAt(toolPayload, [
				5,
				4,
				2
			], true);
			if (nativeName !== void 0 && nativeName !== tool.name) throw new Error("AGY legacy native tools differ from the completed Kiki tool mapping");
			if (tool.failed === true) {
				const nativeErr = nativeBytesAt(toolPayload, [31, 2], true) ?? nativeBytesAt(toolPayload, [31, 3], true);
				if (!nativeErr || /^tool call denied by pre-tool hook:/i.test(nativeErr.trimStart()) || tool.error !== void 0 && nativeErr !== tool.error) throw new Error("AGY legacy native tools differ from the completed Kiki tool mapping");
			}
		}
		const transcript = await readLegacyTranscript(resolve(nativeHome, "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl"));
		const declared = transcript.flatMap((step) => step.tool_calls ?? []);
		const transcriptErrorStep = transcript.at(-1);
		const alignedErrorStep = steps[transcript.length - 1];
		const alignedErrorRow = alignedErrorStep?.step_type === LEGACY_NATIVE_STEP.error ? selectStepPayload.get(alignedErrorStep.idx) : void 0;
		const alignedErrorBytes = alignedErrorRow ? alignedErrorRow.step_payload ?? new Uint8Array(0) : void 0;
		const alignedErr1 = alignedErrorBytes ? nativeBytesAt(alignedErrorBytes, [
			24,
			3,
			1
		], true) : void 0;
		const alignedErr2 = alignedErrorBytes ? nativeBytesAt(alignedErrorBytes, [
			24,
			3,
			2
		], true) : void 0;
		const transcriptErrorText = typeof transcriptErrorStep?.error === "string" && transcriptErrorStep.error.trim() ? transcriptErrorStep.error : void 0;
		if (transcript.some((step, index) => step.step_index !== index || (step.type === "GENERIC" ? step.status !== "DONE" && step.status !== "ERROR" : step.status !== "DONE")) || transcript.length < steps.length - 1 || transcript.length > steps.length || transcriptErrorStep?.type !== "ERROR_MESSAGE" || alignedErrorStep?.step_type !== LEGACY_NATIVE_STEP.error || transcriptErrorText !== void 0 && transcriptErrorText !== alignedErr1 && transcriptErrorText !== alignedErr2 && transcriptErrorText !== terminalError || transcript.filter((step) => step.type === "USER_INPUT").length !== 1 || transcript.filter((step) => step.type === "GENERIC").length !== toolByIndex.size || declared.length !== proof.tools.length || declared.some((tool, index) => tool.name !== proof.tools[index].name) || proof.tools.some((tool) => {
			const entry = transcript[tool.stepIndex];
			return entry?.type !== "GENERIC" || (tool.failed === true ? entry.status !== "ERROR" || tool.error !== void 0 && entry.error !== tool.error : entry.status !== "DONE");
		})) throw new Error("AGY legacy native transcript is not fully reconciled or differs from the completed Kiki tool mapping");
		return {
			conversationId,
			model,
			effort: proof.effort
		};
	} finally {
		db.close();
	}
}
async function inspectNativeErrorWatchdogState({ nativeHome, conversationId }) {
	if (typeof nativeHome !== "string" || !nativeHome || !NATIVE_ID.test(conversationId ?? "")) return { status: "missing_db" };
	const dbPath = resolve(nativeHome, "conversations", `${conversationId}.db`);
	let db;
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const conn = new DatabaseSync(dbPath, { readOnly: true });
		db = conn;
		const latest = conn.prepare("SELECT idx, step_type, status, CASE WHEN length(step_payload) <= 65536 THEN step_payload END AS step_payload FROM steps ORDER BY idx DESC LIMIT 1").get();
		if (!latest) return { status: "no_terminal_error" };
		if (conn.prepare("SELECT idx, step_type, status FROM steps WHERE (step_type = ? AND status NOT IN (?, ?)) OR (step_type != ? AND status != ?) LIMIT 1").get(LEGACY_NATIVE_STEP.tool, 3, 7, LEGACY_NATIVE_STEP.tool, 3)) return { status: "incomplete_steps" };
		if (latest.step_type !== LEGACY_NATIVE_STEP.error) return { status: "no_terminal_error" };
		const bytes = latest.step_payload ?? new Uint8Array(0);
		const err1 = nativeBytesAt(bytes, [
			24,
			3,
			1
		], true);
		const err2 = nativeBytesAt(bytes, [
			24,
			3,
			2
		], true);
		if (typeof err1 === "string" && err1.trim()) return {
			status: "terminal_error",
			stepIndex: latest.idx,
			summary: err1,
			detail: err2,
			error: err2 || err1
		};
		return {
			status: "retrying",
			stepIndex: latest.idx,
			detail: err2
		};
	} catch (error) {
		const err = error;
		if (err?.code === "ERR_SQLITE_ERROR" || /unable to open database file/i.test(String(err?.message ?? ""))) return { status: "missing_db" };
		return { status: "db_error" };
	} finally {
		try {
			db?.close();
		} catch {}
	}
}
function unconsumedNetworkContinuationProof(records, { sessionId, conversationId, model, effort, cwd, additionalDirectories = [] }) {
	if (!Array.isArray(records) || !NATIVE_ID.test(sessionId ?? "") || !NATIVE_ID.test(conversationId ?? "")) return;
	let lastTurnIndex = -1;
	for (let index = 0; index < records.length; index += 1) {
		const type = records[index]?.type;
		if (type === "native_turn_pending" || type === "native_turn_reconciled") lastTurnIndex = index;
	}
	if (lastTurnIndex < 0 || records[lastTurnIndex]?.type !== "native_turn_pending") return void 0;
	let launchIndex = -1;
	for (let index = lastTurnIndex; index >= 0; index -= 1) if (records[index]?.type === "launch") {
		launchIndex = index;
		break;
	}
	if (launchIndex < 0 || records.some((record, index) => index > launchIndex && record?.type === "launch")) return;
	if (records.some((record) => ["session_loaded", "legacy_native_recovered"].includes(record?.type))) return;
	if (records.filter((record) => record?.type === "prompt_sent").length !== 1) return void 0;
	const launch = records[launchIndex];
	if (!Number.isSafeInteger(launch["pid"]) || launch["pid"] <= 0) return void 0;
	const turnRecords = records.slice(lastTurnIndex + 1);
	const promptSent = turnRecords.filter((record) => record?.type === "prompt_sent");
	if (promptSent.length !== 1 || !/^[0-9a-f]{64}$/i.test(String(promptSent[0]["promptSha256"] ?? ""))) return;
	const consumed = turnRecords.filter((record) => record?.type === "prompt_consumed");
	if (consumed.length !== 1 || consumed[0]["stepIndex"] !== 0) return void 0;
	if (turnRecords.some((record) => typeof record?.type === "string" && (record.type.startsWith("steer_") || record.type === "pre_tool_hook_denied"))) return;
	const results = turnRecords.filter((record) => record?.type === "agy_result");
	const requested = turnRecords.filter((record) => record?.type === "network_recovery_requested");
	const sent = turnRecords.filter((record) => record?.type === "network_recovery_sent");
	if (results.length !== 1 || requested.length !== 1 || sent.length !== 1) return void 0;
	if (results[0]["conversationId"] !== conversationId || results[0]["status"] !== "ERROR" || requested[0]["conversationId"] !== conversationId || requested[0]["nativeStatus"] !== "ERROR" || requested[0]["attempt"] !== 1 || requested[0]["totalAttempts"] !== 1 || sent[0]["conversationId"] !== conversationId || sent[0]["attempt"] !== 1 || sent[0]["relaunched"] !== false) return;
	const sentIndex = turnRecords.indexOf(sent[0]);
	if (sentIndex < turnRecords.indexOf(requested[0]) || sentIndex < turnRecords.indexOf(results[0]) || sentIndex <= turnRecords.indexOf(consumed[0])) return;
	const afterSent = turnRecords.slice(sentIndex + 1);
	if (afterSent.some((record) => record?.type !== "native_frame_delivered" && record?.type !== "close")) return;
	const closes = afterSent.filter((record) => record?.type === "close");
	if (closes.length !== 1 || closes[0]["pid"] !== launch["pid"] || closes[0]["processEnded"] !== true || closes[0]["signal"] !== void 0 && closes[0]["signal"] !== null || closes[0]["exitCode"] !== void 0 && (!Number.isSafeInteger(closes[0]["exitCode"]) || closes[0]["exitCode"] < 0)) return;
	const toolsByStep = /* @__PURE__ */ new Map();
	for (const record of turnRecords) {
		if (record?.type !== "tool_state") continue;
		const match = /^agy-([0-9a-f-]+)-(\d+)$/i.exec(String(record["toolCallId"] ?? ""));
		if (!match || match[1] !== conversationId) return void 0;
		const stepIndex = Number(match[2]);
		if (!Number.isSafeInteger(stepIndex) || stepIndex <= 0) return void 0;
		toolsByStep.set(stepIndex, {
			stepIndex,
			name: record["name"],
			state: record["state"],
			...typeof record["error"] === "string" && record["error"].trim() ? { error: record["error"] } : {}
		});
	}
	if (!toolsByStep.size) return void 0;
	const tools = [];
	for (const tool of [...toolsByStep.values()].sort((a, b) => a.stepIndex - b.stepIndex)) {
		if (tool.state !== "DONE" && tool.state !== "ERROR") return void 0;
		tools.push({
			stepIndex: tool.stepIndex,
			name: tool.name,
			...tool.state === "ERROR" ? { failed: true } : {},
			...tool.state === "ERROR" && tool.error ? { error: tool.error } : {}
		});
	}
	return {
		version: 1,
		sessionId,
		conversationId,
		model,
		effort,
		promptSha256: String(promptSent[0]["promptSha256"]).toLowerCase(),
		terminalError: requested[0]["error"],
		disclosedCwd: cwd,
		additionalDirectories: additionalDirectories.length ? [...additionalDirectories] : void 0,
		tools
	};
}

//#endregion
//#region src/ndjson.ts
function createNdjsonLineTransform(options = {}) {
	const maxFrameBytes = options.maxFrameBytes;
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	const checkLimit = (text) => {
		if (maxFrameBytes !== void 0 && Buffer.byteLength(text) > maxFrameBytes) throw new Error(`NDJSON frame exceeds ${maxFrameBytes} bytes`);
	};
	return new TransformStream({
		transform(chunk, controller) {
			buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
			let newline;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const raw = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
				checkLimit(line);
				controller.enqueue(line);
			}
			checkLimit(buffer);
		},
		flush(controller) {
			buffer += decoder.decode();
			if (buffer.length > 0) {
				const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
				checkLimit(line);
				controller.enqueue(line);
				buffer = "";
			}
		}
	});
}
async function* readNdjsonLines(stream, options = {}) {
	const { maxFrameBytes, signal } = options;
	if (signal?.aborted) return;
	const decoder = new TextDecoder("utf-8");
	const queue = [];
	let buffer = "";
	let ended = false;
	let streamError;
	let hasError = false;
	let notify;
	const wake = () => {
		const fn = notify;
		notify = void 0;
		fn?.();
	};
	const checkLimit = (text) => {
		if (maxFrameBytes !== void 0 && Buffer.byteLength(text) > maxFrameBytes) {
			streamError = /* @__PURE__ */ new Error(`NDJSON frame exceeds ${maxFrameBytes} bytes`);
			hasError = true;
			ended = true;
			stream.pause();
			wake();
			return false;
		}
		return true;
	};
	const onData = (chunk) => {
		if (ended) return;
		buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const raw = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (!checkLimit(line)) return;
			queue.push(line);
		}
		if (!checkLimit(buffer)) return;
		if (queue.length > 0) {
			stream.pause();
			wake();
		}
	};
	const onEnd = () => {
		if (ended) return;
		buffer += decoder.decode();
		if (buffer.length > 0) {
			const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
			buffer = "";
			if (!checkLimit(line)) return;
			queue.push(line);
		}
		ended = true;
		wake();
	};
	const onError = (error) => {
		if (ended) return;
		streamError = error;
		hasError = true;
		ended = true;
		wake();
	};
	const onClose = () => {
		if (ended) return;
		ended = true;
		wake();
	};
	const onAbort = () => {
		ended = true;
		stream.pause();
		wake();
	};
	stream.on("data", onData);
	stream.once("end", onEnd);
	stream.once("error", onError);
	stream.once("close", onClose);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			while (queue.length > 0) {
				if (signal?.aborted) return;
				yield queue.shift();
			}
			if (hasError) throw streamError instanceof Error ? streamError : new Error(String(streamError));
			if (ended || signal?.aborted) return;
			stream.resume();
			await new Promise((resolve) => {
				notify = resolve;
			});
		}
	} finally {
		stream.off("data", onData);
		stream.off("end", onEnd);
		stream.off("error", onError);
		stream.off("close", onClose);
		signal?.removeEventListener("abort", onAbort);
		stream.pause();
	}
}
var NdjsonFrameDecoder = class {
	decoder = new TextDecoder("utf-8");
	maxFrameBytes;
	reviver;
	onFrame;
	onError;
	buffer = "";
	failed = false;
	constructor(options) {
		this.maxFrameBytes = options.maxFrameBytes ?? 1048576;
		this.reviver = options.reviver;
		this.onFrame = options.onFrame;
		this.onError = options.onError;
	}
	stop() {
		this.failed = true;
	}
	push(chunk) {
		if (this.failed) return;
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
		let newline;
		while ((newline = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			if (Buffer.byteLength(line) > this.maxFrameBytes) {
				this.failed = true;
				this.onError(/* @__PURE__ */ new Error("AGY stdout frame exceeds 1 MiB"));
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(line, this.reviver);
			} catch {
				this.failed = true;
				this.onError(/* @__PURE__ */ new Error("AGY emitted invalid NDJSON"));
				return;
			}
			this.onFrame(parsed);
			if (this.failed) return;
		}
		if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) {
			this.failed = true;
			this.onError(/* @__PURE__ */ new Error("AGY stdout frame exceeds 1 MiB"));
		}
	}
};
function writeNdjsonFrame(stream, frame) {
	return new Promise((done, reject) => {
		stream.write(frame, (error) => error ? reject(error) : done());
	});
}

//#endregion
//#region src/bridge.ts
function asAgyError(error) {
	if (error instanceof Error) return error;
	return new Error(String(error));
}
var AgyBridge = class {
	stopProcess;
	continuationExitGraceMs;
	networkRecoveryBackoffMs;
	maxConsecutiveNetworkRecoveries;
	errorResultWatchdogMs;
	account;
	requestedModel;
	onAccountExit;
	model;
	cliPath;
	cliPrefix;
	auditDir;
	nativeHome;
	spawnProcess;
	sessions;
	modelChoices;
	modelDiagnostic;
	closePromise;
	constructor({ cliPath, cliPrefix = [], auditDir, nativeHome = resolve(homedir(), ".gemini", "antigravity-cli"), model = DEFAULT, spawnProcess = spawn, stopProcess = terminate, account, onAccountExit, continuationExitGraceMs = NETWORK_RECOVERY_EXIT_GRACE_MS, networkRecoveryBackoffMs = NETWORK_RECOVERY_BACKOFF_MS, maxConsecutiveNetworkRecoveries = 5, errorResultWatchdogMs = ERROR_RESULT_WATCHDOG_MS } = {}) {
		this.stopProcess = stopProcess;
		this.continuationExitGraceMs = continuationExitGraceMs;
		this.networkRecoveryBackoffMs = networkRecoveryBackoffMs;
		this.maxConsecutiveNetworkRecoveries = maxConsecutiveNetworkRecoveries;
		this.errorResultWatchdogMs = errorResultWatchdogMs;
		if (!isAbsolute(cliPath ?? "")) throw new Error("Pass the exact absolute AGY executable path");
		if (typeof model !== "string" || !model || /\s/.test(model)) throw new Error("AGY model must be a nonempty engine ID");
		if (account && model !== "engine-default" && !account.modelIds.includes(model)) throw new Error("The selected account does not provide the bound AGY model");
		this.account = account;
		this.requestedModel = model;
		this.onAccountExit = onAccountExit;
		this.model = account && model === "engine-default" ? account.modelIds[0] : model;
		this.cliPath = cliPath;
		this.cliPrefix = cliPrefix;
		this.auditDir = auditDir;
		this.nativeHome = nativeHome;
		this.spawnProcess = spawnProcess;
		this.sessions = /* @__PURE__ */ new Map();
	}
	async audit(session, type, data) {
		if (!this.auditDir) return;
		await mkdir(this.auditDir, { recursive: true });
		await appendFile(resolve(this.auditDir, `${session.id}.ndjson`), JSON.stringify({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			type,
			...data
		}) + "\n");
	}
	initialize(version) {
		return {
			protocolVersion: version,
			agentInfo: {
				name: "agy-cli-acp",
				version: "0.2.0"
			},
			agentCapabilities: {
				loadSession: Boolean(this.auditDir),
				promptCapabilities: {
					image: false,
					audio: false,
					embeddedContext: false
				},
				mcpCapabilities: {
					http: false,
					sse: false
				},
				sessionCapabilities: { additionalDirectories: {} }
			},
			authMethods: [],
			_meta: { steering: { supported: true } }
		};
	}
	async requestPermission() {
		return { decision: "ask" };
	}
	async newSession(params, id = randomUUID(), event = "session_new", recovery) {
		const mcpServers = params.mcpServers ?? [];
		if (!Array.isArray(mcpServers) || mcpServers.some((server) => !server || typeof server.name !== "string" || !server.name || typeof server.command !== "string" || !server.command || !Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string") || !Array.isArray(server.env) || server.env.some((entry) => typeof entry.name !== "string" || typeof entry.value !== "string"))) throw new Error("AGY session MCP requires named stdio servers with command, args and env");
		if (params._meta?.["systemPromptOverride"] !== void 0) throw new Error("System replacement is unsupported; use explicit Kiki preamble delivery");
		if (!isAbsolute(params.cwd)) throw new Error("AGY workspace must be absolute");
		const dirs = params.additionalDirectories ?? [];
		if (!Array.isArray(dirs) || dirs.some((d) => typeof d !== "string" || !isAbsolute(d))) throw new Error("Additional directories must be absolute");
		const session = {
			id,
			cwd: params.cwd,
			additionalDirectories: dirs,
			model: this.model,
			effort: DEFAULT,
			modelChoices: this.modelChoices,
			accountBound: this.account !== void 0,
			mcpServers: structuredClone(mcpServers),
			mcpPlugin: void 0,
			mcpBound: /* @__PURE__ */ new Set(),
			mcpReady: /* @__PURE__ */ new Set(),
			permissionIdentity: permissionChannelIdentity(),
			permissionChannel: void 0,
			child: void 0,
			active: void 0,
			broken: false,
			init: void 0,
			exited: void 0,
			denialCounts: /* @__PURE__ */ new Map(),
			toolIds: /* @__PURE__ */ new Map(),
			toolDetails: /* @__PURE__ */ new Map(),
			toolInputs: /* @__PURE__ */ new Map()
		};
		this.sessions.set(session.id, session);
		try {
			await this.recoverDeadOwnedResources(session);
			await this.audit(session, event, {
				cwd: session.cwd,
				additionalDirectories: dirs,
				delivery: event === "session_new" ? "first_user_preamble" : "native_conversation",
				systemOverride: false,
				recovery
			});
			return {
				sessionId: session.id,
				configOptions: configOptions(session)
			};
		} catch (error) {
			await session.permissionChannel?.close();
			await this.closeSteeringHook(session).catch(() => {});
			this.sessions.delete(session.id);
			throw error;
		}
	}
	async loadSession(params) {
		if (!this.auditDir) throw new Error("AGY native load requires the existing adapter audit directory");
		if (!/^[0-9a-f-]{36}$/i.test(params.sessionId)) throw new Error("Invalid AGY adapter session ID");
		if (this.sessions.has(params.sessionId)) throw new Error("AGY session is already owned by this connection");
		const auditPath = resolve(this.auditDir, `${params.sessionId}.ndjson`);
		const readAudit = async () => (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const records = await readAudit().catch((error) => {
			if (error.code !== "ENOENT" || params._meta?.["kiki.agyLegacyRecovery"] === void 0) throw error;
		});
		const workspace = records?.find((record) => ["session_new", "legacy_native_recovered"].includes(record.type));
		const launch = records?.findLast((record) => record.type === "launch");
		if (records === void 0 || !launch && workspace?.type === "legacy_native_recovered") return this.loadLegacySession(params, readAudit, workspace);
		const init = records.findLast((record) => record.type === "agy_init");
		if (!workspace || !launch || !init?.["conversationId"] || records.indexOf(init) < records.indexOf(launch)) throw new Error("AGY session has no confirmed native conversation to load; retain the failed attempt and create a new session");
		if (resolve(params.cwd) !== resolve(workspace["cwd"]) || JSON.stringify(params.additionalDirectories ?? []) !== JSON.stringify(workspace["additionalDirectories"] ?? [])) throw new Error("AGY native load workspace differs from its original binding");
		if (records.some((record) => record.type === "mcp_agent_registered")) throw new Error("This native conversation used the former custom MCP agent; retain its original adapter for recovery or create a new native main session");
		const mcpBinding = records.findLast((record) => record.type === "mcp_plugin_registered");
		if (mcpBinding && typeof mcpBinding["name"] !== "string") throw new Error("AGY native load has no audited MCP plugin namespace; preserve its original adapter for recovery");
		if (mcpBinding && JSON.stringify(params.mcpServers?.map((server) => server.name) ?? []) !== JSON.stringify(mcpBinding["servers"])) throw new Error("AGY native load requires fresh MCP connections matching its original server names");
		const launchArgsArr = launch["args"] ?? [];
		const argValue = (name) => {
			const index = launchArgsArr.lastIndexOf(name);
			return index < 0 ? DEFAULT : launchArgsArr[index + 1] ?? "engine-default";
		};
		const model = argValue("--model") === "engine-default" ? init["model"] : argValue("--model");
		if (typeof model !== "string" || !model || (this.account ? !this.account.modelIds.includes(model) || this.requestedModel !== "engine-default" && model !== this.requestedModel : this.model !== "engine-default" && model !== this.model)) throw new Error(this.account ? "AGY native load model differs from its original binding or is unavailable for the selected account" : "AGY native load model differs from its original binding or was not confirmed");
		const effort = launch["effort"] ?? argValue("--effort");
		validateEffort(model, effort);
		if (processAlive(launch["pid"])) throw new Error("AGY native conversation still has an owned process; close it before loading");
		const release = await this.claimResume(params.sessionId);
		try {
			const latest = await readAudit();
			const retired = latest.findLast((record) => record.type === "cancel_requested" || record.type === "cancel_failed" || record.type === "cancel" && record["resumeSupported"] === false || record.type === "tool_terminal_missing" && Array.isArray(record["tools"]) && record["tools"].length > 0);
			if (retired) {
				const error = /* @__PURE__ */ new Error(`AGY native session is retired or unreconciled (${retired.type}); inspect the native outcome before deciding what to run in a fresh session; do not replay interrupted prompts or commands`);
				error.code = "AGY_SESSION_RETIRED";
				error.details = {
					reason: retired.type,
					unresolvedTools: retired["unresolvedTools"] ?? retired["tools"] ?? []
				};
				throw error;
			}
			if (latest.findLast((record) => record.type === "native_turn_pending" || record.type === "native_turn_reconciled")?.type === "native_turn_pending") {
				const unconsumedProof = !mcpBinding ? unconsumedNetworkContinuationProof(latest, {
					sessionId: params.sessionId,
					conversationId: init["conversationId"],
					model,
					effort,
					cwd: workspace["cwd"],
					additionalDirectories: workspace["additionalDirectories"] ?? []
				}) : void 0;
				let reconciled = false;
				if (unconsumedProof !== void 0) try {
					await readLegacyNativeRecovery({
						nativeHome: this.nativeHome,
						cwd: workspace["cwd"],
						additionalDirectories: workspace["additionalDirectories"] ?? [],
						sessionId: params.sessionId,
						proof: unconsumedProof,
						model
					});
					reconciled = true;
				} catch {}
				if (!reconciled) {
					const error = /* @__PURE__ */ new Error("AGY native session has an unconfirmed turn; wait for its native outcome to be reconciled before loading; do not replay the interrupted prompt or commands");
					error.code = "AGY_SESSION_UNCONFIRMED";
					throw error;
				}
				await this.audit({ id: params.sessionId }, "native_turn_reconciled", {
					conversationId: init["conversationId"],
					status: "ERROR",
					reconciledFromNativeDb: true,
					unconsumedContinuationAttempt: 1
				});
			}
			await this.newSession(params, params.sessionId, "session_loaded");
			const session = this.session(params.sessionId);
			session.model = model;
			session.effort = effort;
			session.conversationId = init["conversationId"];
			session.mcpNamespace = mcpBinding?.["name"];
			session.releaseResume = release;
			return { configOptions: configOptions(session) };
		} catch (error) {
			await release();
			this.sessions.delete(params.sessionId);
			throw error;
		}
	}
	async claimResume(sessionId) {
		await mkdir(this.auditDir, { recursive: true });
		const path = resolve(this.auditDir, `${sessionId}.resume-lock`);
		const claim = JSON.stringify({
			pid: process.pid,
			nonce: randomUUID()
		});
		let file;
		try {
			file = await open(path, "wx");
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			const previous = await readFile(path, "utf8");
			if (processAlive(JSON.parse(previous).pid)) throw new Error("AGY native conversation is already being loaded");
			throw new Error(`AGY native load lease is stale; recover only this exact owned lease after confirming no live adapter: ${path}`);
		}
		try {
			await file.writeFile(claim);
		} finally {
			await file.close();
		}
		return async () => {
			try {
				if (await readFile(path, "utf8") === claim) await unlink(path);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		};
	}
	async loadLegacySession(params, readAudit, previous) {
		const additionalDirectories = params.additionalDirectories ?? [];
		if ((params.mcpServers?.length ?? 0) !== 0 || !Array.isArray(additionalDirectories) || additionalDirectories.some((dir) => typeof dir !== "string" || !isAbsolute(dir))) throw new Error("AGY legacy native recovery requires the original default-home non-MCP binding");
		if (previous && (resolve(params.cwd) !== resolve(previous["cwd"]) || JSON.stringify(additionalDirectories) !== JSON.stringify(previous["additionalDirectories"] ?? []))) throw new Error("AGY legacy native conversation or workspace differs from its original binding");
		const proof = (previous?.["recovery"])?.proof ?? params._meta?.["kiki.agyLegacyRecovery"];
		const release = await this.claimResume(params.sessionId);
		try {
			const latest = await readAudit().catch((error) => {
				if (error.code !== "ENOENT") throw error;
				return [];
			});
			const latestRecovery = latest.find((record) => record.type === "legacy_native_recovered");
			if (JSON.stringify(latestRecovery) !== JSON.stringify(previous) || latest.some((record) => ![
				"legacy_native_recovered",
				"session_loaded",
				"owned_recovery",
				"permission_mode_configured",
				"close"
			].includes(record.type))) throw new Error("AGY legacy recovery state changed; preserve the original session without replay");
			const model = proof?.model;
			if (typeof model !== "string" || !model || this.requestedModel !== "engine-default" && model !== this.requestedModel || this.account && !this.account.modelIds.includes(model)) throw new Error("AGY legacy native model is not available for this binding");
			const recovered = await readLegacyNativeRecovery({
				nativeHome: this.nativeHome,
				cwd: params.cwd,
				additionalDirectories,
				sessionId: params.sessionId,
				proof,
				model
			});
			validateEffort(recovered.model, recovered.effort);
			await this.newSession(params, params.sessionId, previous ? "session_loaded" : "legacy_native_recovered", previous ? void 0 : {
				...recovered,
				proof
			});
			const session = this.session(params.sessionId);
			session.model = recovered.model;
			session.effort = recovered.effort;
			session.conversationId = recovered.conversationId;
			session.releaseResume = release;
			return { configOptions: configOptions(session) };
		} catch (error) {
			await release();
			this.sessions.delete(params.sessionId);
			throw error;
		}
	}
	session(id) {
		const session = this.sessions.get(id);
		if (!session) throw new Error("Unknown AGY session; use session/load for exact audited native recovery. Fork is unsupported");
		return session;
	}
	async loadVendorModels() {
		if (this.account) {
			this.modelChoices = this.account.modelIds;
			return;
		}
		try {
			const result = await readVendorModelCatalog({
				cliPath: this.cliPath,
				cliPrefix: this.cliPrefix,
				spawnProcess: this.spawnProcess,
				stopProcess: this.stopProcess
			});
			this.modelChoices = result.ok ? result.ids : void 0;
			this.modelDiagnostic = result.ok ? void 0 : result.diagnostic;
		} catch (error) {
			this.modelChoices = void 0;
			this.modelDiagnostic = catalogDiagnostic(error instanceof Error ? error.message : String(error));
		}
	}
	setModel(session, value) {
		if (session.accountBound && value === "engine-default") value = this.account.modelIds[0];
		if (typeof value !== "string" || value.length === 0 || /\s/u.test(value)) throw new Error("AGY model must be a nonempty engine ID");
		if (session.child && session.model !== value) throw new Error("AGY model/effort is frozen after process launch; select a fresh session");
		if (!Array.isArray(session.modelChoices)) throw new Error("AGY model catalog is unavailable; model is selected by argv in its own namespace");
		if (value !== "engine-default" && value !== session.model && !session.modelChoices.includes(value)) throw new Error(`AGY model ID ${value} is not in the vendor catalog`);
		validateEffort(value, session.effort);
		session.model = value;
		return { configOptions: configOptions(session) };
	}
	setConfig(params) {
		const session = this.session(params.sessionId);
		if (params.configId === "model") return this.setModel(session, params.value);
		if (params.configId === "permission-mode") return this.setPermissionMode(session, params.value);
		if (params.configId === "native-agent") {
			if (params.value !== "engine-default") throw new Error("AGY adapter supports only the native default agent; other native agents have not been discovered");
			return { configOptions: configOptions(session) };
		}
		const key = params.configId === "effort" ? "effort" : void 0;
		if (!key) throw new Error("Unsupported AGY config option; model is selected by argv in its own namespace");
		if (session.child && session[key] !== params.value) throw new Error("AGY model/effort is frozen after process launch; select a fresh session");
		validateEffort(session.model, params.value);
		session[key] = params.value;
		return { configOptions: configOptions(session) };
	}
	async setPermissionMode(session, value) {
		if (![
			"engine-default",
			"manual",
			"auto",
			"yolo"
		].includes(value)) throw new Error(`AGY native permission mode ${value} is unsupported; review requires the Kiki native executor`);
		if (session.permissionMode === value) return { configOptions: configOptions(session) };
		if (session.active) throw new Error("AGY permission mode cannot change during an active turn");
		if (session.child) {
			const conversationId = session.init?.conversation_id;
			if (!conversationId || session.broken) throw new Error("AGY permission changes require a confirmed healthy native conversation");
			session.restarting = true;
			try {
				await this.stopProcess(session.child);
				await session.cleanup;
				session.conversationId = conversationId;
				session.child = void 0;
				session.init = void 0;
				session.exited = void 0;
				session.cleanup = void 0;
				session.permissionChannel = void 0;
				session.mcpPlugin = void 0;
				session.mcpBound.clear();
				session.mcpReady.clear();
				session.broken = false;
			} finally {
				session.restarting = false;
			}
		}
		session.permissionMode = value;
		await this.audit(session, "permission_mode_configured", {
			value,
			mechanism: "native-session-settings"
		});
		return { configOptions: configOptions(session) };
	}
	async syncPermissionHook(session) {
		session.permissionChannel ??= await openPermissionChannel((input) => ["mcp_bootstrap", "mcp_ready"].includes(String(input?.["type"])) ? this.bindMcpBootstrap(session, input) : input?.["type"] === "steer_poll" ? this.pollSteering(session, input) : this.requestPermission(), session.permissionIdentity);
	}
	async registerMcpPlugin(session) {
		if (!session.mcpServers.length || session.mcpPlugin) return;
		session.mcpPlugin = await registerProjectMcpPlugin({
			cwd: session.cwd,
			sessionId: session.id,
			namespace: session.mcpNamespace,
			nodePath: process.execPath,
			handlerPath: fileURLToPath(import.meta.url),
			servers: session.mcpServers
		});
		await this.audit(session, "mcp_plugin_registered", {
			name: session.mcpPlugin.name,
			path: session.mcpPlugin.path,
			servers: session.mcpServers.map((server) => server.name),
			nativeAgent: "engine-default"
		});
	}
	async bindMcpBootstrap(session, input) {
		const key = typeof input["key"] === "string" ? input["key"] : "";
		if (!session.mcpPlugin || !Object.hasOwn(session.mcpPlugin.env, key) || session.broken) return {
			decision: "deny",
			reason: "The MCP bootstrap does not belong to this active session"
		};
		if (input["type"] === "mcp_ready") {
			if (!session.mcpBound.has(key)) return {
				decision: "deny",
				reason: "The MCP bootstrap has not been admitted"
			};
			session.mcpReady.add(key);
		} else session.mcpBound.add(key);
		const serverIndex = Object.keys(session.mcpPlugin.env).indexOf(key);
		await this.audit(session, input["type"] === "mcp_ready" ? "mcp_stdio_ready" : "mcp_stdio_bound", { server: session.mcpServers[serverIndex]?.name });
		return { decision: "allow" };
	}
	/**
	* A previous adapter killed before its close ran can leave its owned hook keys and MCP
	* plugin in this workspace. Before this session registers its own, recover only those
	* whose every recorded owner process has exited; live leases, edited files and foreign
	* entries are preserved and reported in the audit instead of failing the session.
	*/
	async recoverDeadOwnedResources(session) {
		if (session.ownedRecoveryDone) return;
		session.ownedRecoveryDone = true;
		const results = {};
		try {
			results["hooks"] = (await recoverProjectHook({
				cwd: session.cwd,
				nodePath: process.execPath,
				handlerPath: fileURLToPath(new URL("./agy-permission-hook.mjs", import.meta.url))
			})).status;
		} catch (error) {
			results["hooks"] = {
				status: "preserved",
				reason: error instanceof Error ? error.message : String(error)
			};
		}
		try {
			results["plugins"] = await recoverDeadProjectMcpPlugins({ cwd: session.cwd });
		} catch (error) {
			results["plugins"] = {
				status: "preserved",
				reason: error instanceof Error ? error.message : String(error)
			};
		}
		const plugins = results["plugins"];
		if (results["hooks"] !== "no-owned-registration" || Array.isArray(plugins) && plugins.length > 0) this.auditQuietly(session, "owned_recovery", results);
	}
	async registerSteeringHook(session) {
		session.steeringRegistration ??= await registerProjectHook({
			cwd: session.cwd,
			nodePath: process.execPath,
			handlerPath: fileURLToPath(new URL("./agy-permission-hook.mjs", import.meta.url)),
			sessionId: session.id,
			key: AGY_STEERING_HOOK_KEY,
			args: ["--steering"]
		});
		if (!session.child && !session.conversationId) session.commandGuidanceRegistration ??= await registerProjectHook({
			cwd: session.cwd,
			nodePath: process.execPath,
			handlerPath: fileURLToPath(new URL("./agy-permission-hook.mjs", import.meta.url)),
			sessionId: session.id,
			key: AGY_COMMAND_GUIDANCE_HOOK_KEY,
			args: ["--command-guidance"]
		});
	}
	/**
	* Removes the turn's owned steering and startup guidance keys. A failed removal keeps
	* its registration for the next turn end, cancel or close; cleanup never replaces the result.
	*/
	async closeSteeringHook(session) {
		const errors = [];
		for (const key of ["steeringRegistration", "commandGuidanceRegistration"]) {
			const registration = session[key];
			if (!registration) continue;
			try {
				await registration.close();
				if (session[key] === registration) session[key] = void 0;
			} catch (error) {
				this.auditQuietly(session, "steering_hook_close_failed", {
					registration: key,
					error: error instanceof Error ? error.message : String(error)
				});
				errors.push(error);
			}
		}
		if (errors.length) throw errors[0];
	}
	auditQuietly(session, type, data) {
		this.audit(session, type, data).catch(() => {});
	}
	/**
	* Accepts one steering message for the running native turn. The text waits in this
	* session until AGY's next PostInvocation hook drains it into the same invocation loop.
	* An idle session returns `promptRequired` so the host submits a normal prompt instead.
	*/
	async steer(params) {
		const session = this.session(params.sessionId);
		const active = session.active;
		if (!active || session.broken || !session.steeringRegistration) return {
			outcome: "promptRequired",
			reason: "noRunningTurn"
		};
		const text = promptText(params.prompt);
		const id = randomUUID();
		await this.audit(session, "steer_queued", {
			steerId: id,
			sha256: createHash("sha256").update(text).digest("hex")
		});
		if (session.active !== active || session.broken || !session.steeringRegistration) {
			this.auditQuietly(session, "steer_not_delivered", { steerIds: [id] });
			return {
				outcome: "promptRequired",
				reason: "turnEnded"
			};
		}
		return new Promise((resolveSteer) => active.steering.push({
			id,
			text,
			resolve: resolveSteer
		}));
	}
	releaseSteering(session, active) {
		const pending = active.steering.splice(0);
		if (pending.length) this.auditQuietly(session, "steer_not_delivered", { steerIds: pending.map((item) => item.id) });
		for (const item of pending) item.resolve({
			outcome: "promptRequired",
			reason: "turnEnded"
		});
	}
	async pollSteering(session, input) {
		const active = session.active;
		if (!active || session.broken || !session.init || input["conversationId"] !== session.init.conversation_id) return {
			decision: "deny",
			reason: "AGY steering poll does not belong to the running turn"
		};
		if (active.steering.length === 0) return {
			decision: "allow",
			steering: { injectSteps: [] }
		};
		const batch = active.steering.splice(0);
		this.auditQuietly(session, "steer_delivering", {
			steerIds: batch.map((item) => item.id),
			invocationNum: input["invocationNum"]
		});
		let settled = false;
		const settle = (outcome, type) => {
			if (settled) return;
			settled = true;
			if (outcome !== "injected") active.steerDeliveryUnknown = true;
			this.auditQuietly(session, type, { steerIds: batch.map((item) => item.id) });
			for (const item of batch) item.resolve({ outcome });
		};
		return {
			decision: "allow",
			steering: { injectSteps: batch.map((item) => ({ userMessage: item.text })) },
			afterWrite: () => settle("injected", "steer_delivered"),
			afterFailure: () => settle("deliveryUnknown", "steer_delivery_unknown")
		};
	}
	async start(session) {
		session.denialCounts = /* @__PURE__ */ new Map();
		await this.registerMcpPlugin(session);
		const args = [...this.cliPrefix, ...launchArgs(session)];
		const env = {
			...process.env,
			...session.permissionIdentity
		};
		for (const key of Object.keys(env)) if (key.startsWith("KIKI_AGY_MCP_")) delete env[key];
		Object.assign(env, session.mcpPlugin?.env);
		const account = this.account;
		if (account) Object.assign(env, {
			GEMINI_API_KEY: account.apiKey,
			GOOGLE_GEMINI_BASE_URL: account.baseUrl
		});
		const redact = (text) => account ? text.replaceAll(account.apiKey, "[redacted]").replaceAll(account.baseUrl, "[redacted]") : text;
		let child;
		try {
			await session.mcpPlugin?.beforeLaunch();
			child = this.spawnProcess(this.cliPath, args, {
				cwd: session.cwd,
				stdio: [
					"pipe",
					"pipe",
					"pipe"
				],
				windowsHide: true,
				env
			});
		} catch (error) {
			await session.permissionChannel?.close();
			await this.closeSteeringHook(session).catch(() => {});
			await session.mcpPlugin?.close();
			throw error;
		}
		session.child = child;
		session.exited = new Promise((done) => child.once("close", () => done()));
		let stderr = Buffer.alloc(0);
		let stderrTruncated = false;
		let delivery = Promise.resolve();
		let ingress = Promise.resolve();
		let sequence = 0;
		const fail = (error) => {
			session.broken = true;
			if (!session.cancelling) Promise.resolve(this.stopProcess(child)).catch(() => {});
			return this.loseTurn(session, asAgyError(error));
		};
		const failFrame = (error) => {
			decoder.stop();
			session.broken = true;
			if (!session.cancelling) Promise.resolve(this.stopProcess(child)).catch(() => {});
			delivery = delivery.then(() => this.loseTurn(session, error));
		};
		const decoder = new NdjsonFrameDecoder({
			reviver: account ? (_key, value) => typeof value === "string" ? redact(value) : value : void 0,
			onFrame: (event) => {
				const frame = {
					sequence: ++sequence,
					receivedAt: (/* @__PURE__ */ new Date()).toISOString(),
					event: event?.event,
					stepIndex: event?.step_update?.step_index,
					stepType: event?.step_update?.step_type,
					state: event?.step_update?.state,
					status: event?.result?.status
				};
				this.clearErrorResultWatchdog(session.active);
				ingress = ingress.then(() => this.audit(session, "native_frame_received", frame)).catch(fail);
				delivery = delivery.then(async () => {
					await this.event(session, event);
					await this.audit(session, "native_frame_delivered", { sequence: frame.sequence });
				}).catch(fail);
			},
			onError: failFrame
		});
		session.drainReceived = () => {
			decoder.stop();
			return Promise.all([ingress, delivery]);
		};
		session.queueInternalAction = (action) => {
			delivery = delivery.then(action).catch(fail);
			return delivery;
		};
		child.stdout?.on("data", (chunk) => {
			decoder.push(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			const text = chunk.toString();
			if (/auto-denied|soft.denied|permission.*denied/i.test(text) && session.active) session.active.denied = true;
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			stderrTruncated ||= stderr.length + bytes.length > 8192;
			const tail = Buffer.concat([stderr, bytes.subarray(Math.max(0, bytes.length - 8192))]);
			stderr = tail.subarray(Math.max(0, tail.length - 8192));
			if (!account) process.stderr.write(chunk);
		});
		child.stdin?.on("error", (error) => {
			if (session.child === child && session.active?.continuationWriter !== child) fail(error);
		});
		child.on("error", (error) => {
			fail(error);
		});
		child.once("close", (code, signal) => {
			const lines = stderr.toString("utf8").split(/\r?\n/u);
			if (stderrTruncated) lines.shift();
			const diagnostic = lines.map((line) => safeDiagnosticLine(redact(line))).findLast((line) => line !== void 0);
			stderr = Buffer.alloc(0);
			const owned = child;
			const channel = session.permissionChannel;
			if (session.child === owned) session.broken = true;
			session.cleanup = (async () => {
				try {
					await Promise.all([ingress, delivery]);
				} finally {
					if (session.child === owned) {
						if (session.active && !session.cancelling) {
							const message = `AGY exited before terminal result (code: ${code ?? "none"}, signal: ${signal ?? "none"})${diagnostic === void 0 ? "" : `: ${diagnostic}`}`;
							const error = new Error(message);
							error.code = "AGY_EARLY_EXIT";
							error.details = {
								exitCode: code ?? null,
								signal: signal ?? null,
								diagnostic
							};
							await this.loseTurn(session, error);
						}
						await channel?.close();
						await this.closeSteeringHook(session).catch(() => {});
						await session.mcpPlugin?.close();
						if (!session.restarting) await session.releaseResume?.();
					}
				}
			})();
			const ended = () => {
				if (account && session.child === owned && !session.restarting) this.onAccountExit?.();
			};
			session.cleanup.then(ended, (error) => {
				const msg = error instanceof Error ? error.message : String(error);
				process.stderr.write(`AGY owned permission cleanup failed: ${redact(msg)}\n`);
				ended();
			});
		});
		try {
			await session.mcpPlugin?.launched(child.pid);
		} catch (error) {
			await this.stopProcess(child);
			await session.cleanup;
			throw error;
		}
		return this.audit(session, "launch", {
			cliPath: this.cliPath,
			args,
			effort: session.effort,
			pid: child.pid,
			cwd: session.cwd
		});
	}
	unresolvedTools(session) {
		return [...session.toolIds].filter(([, status]) => status === "pending").map(([toolCallId]) => ({
			toolCallId,
			...session.toolDetails.get(toolCallId)
		}));
	}
	unknownToolMessage(reason, tools) {
		return `${reason}: ${tools.map((tool) => `${tool.toolCallId} (${tool.name ?? "unknown tool"}, ${tool.state ?? "unknown state"})`).join(", ")}; execution state is unknown; do not replay these calls or reuse this session until their native state is reconciled`;
	}
	async settlePendingTools(session, active, message) {
		for (const [toolCallId, status] of session.toolIds) {
			if (status !== "pending") continue;
			session.toolIds.set(toolCallId, "settled");
			await active.client.notify("session/update", {
				sessionId: session.id,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId,
					status: "failed",
					content: [{
						type: "content",
						content: {
							type: "text",
							text: message
						}
					}]
				}
			});
		}
	}
	async rejectUnconfirmedTurn(session, active, error, unresolved, preserveMessage = false) {
		const message = unresolved.length ? this.unknownToolMessage(error.message, unresolved) : error.message;
		if (unresolved.length) {
			error.details = {
				...error.details,
				unresolvedTools: unresolved
			};
			if (!preserveMessage) error.message = message;
			await this.settlePendingTools(session, active, message).catch(() => {});
		}
		session.failure = `${message}; create a fresh session`;
		active.reject(error);
	}
	async loseTurn(session, error) {
		const active = session.active;
		if (!active || session.cancelling) return;
		this.clearErrorResultWatchdog(active);
		session.active = void 0;
		const unresolved = this.unresolvedTools(session);
		if (unresolved.length) await this.audit(session, "tool_terminal_missing", {
			reason: "stream_lost",
			tools: unresolved
		}).catch((auditError) => {
			const msg = auditError instanceof Error ? auditError.message : String(auditError);
			error.details = {
				...error.details,
				retirementAuditError: msg
			};
		});
		await this.rejectUnconfirmedTurn(session, active, error, unresolved);
	}
	clearErrorResultWatchdog(active) {
		if (!active?.errorWatchdog) return;
		clearTimeout(active.errorWatchdog);
		active.errorWatchdog = void 0;
	}
	armErrorResultWatchdog(session, active) {
		this.clearErrorResultWatchdog(active);
		if (typeof this.errorResultWatchdogMs !== "number" || this.errorResultWatchdogMs <= 0 || !Number.isFinite(this.errorResultWatchdogMs)) return;
		if (session.active !== active || session.cancelling || session.restarting) return;
		const child = session.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		const token = Symbol("errorWatchdog");
		active.errorWatchdogToken = token;
		const timer = setTimeout(() => {
			if (active.errorWatchdog === timer) active.errorWatchdog = void 0;
			if (session.active !== active || active.errorWatchdogToken !== token || session.cancelling || session.restarting || session.child !== child) return;
			session.queueInternalAction?.(() => this.onErrorResultWatchdog(session, active, child, token));
		}, this.errorResultWatchdogMs);
		timer.unref?.();
		active.errorWatchdog = timer;
	}
	async onErrorResultWatchdog(session, active, child, token) {
		if (session.active !== active || active.errorWatchdogToken !== token || session.cancelling || session.restarting || session.child !== child) return;
		if (child.exitCode !== null || child.signalCode !== null) return;
		if (active.lastStepType !== "error_message" || active.lastStepState !== "DONE") return;
		const conversationId = session.init?.conversation_id ?? session.conversationId;
		const dbState = await inspectNativeErrorWatchdogState({
			nativeHome: this.nativeHome,
			conversationId
		});
		if (session.active !== active || active.errorWatchdogToken !== token || session.cancelling || session.restarting || session.child !== child) return;
		if (dbState.status === "retrying" && (active.consecutiveErrorSteps ?? 0) < 2) {
			this.armErrorResultWatchdog(session, active);
			return;
		}
		if (dbState.status === "no_terminal_error") return;
		const unresolved = this.unresolvedTools(session);
		const errorText = dbState.status === "terminal_error" ? dbState.error ?? "There was a network issue connecting to the server, please try again." : active.lastErrorStepText || "There was a network issue connecting to the server, please try again.";
		await this.audit(session, "error_result_watchdog_triggered", {
			conversationId,
			stepIndex: active.lastStepIndex,
			consecutiveErrorSteps: active.consecutiveErrorSteps ?? 1,
			dbStatus: dbState.status,
			unresolvedCount: unresolved.length
		});
		if (session.active !== active || session.cancelling) return;
		if (dbState.status === "incomplete_steps" || dbState.status === "db_error" || !active.promptConsumed || unresolved.length > 0) {
			session.broken = true;
			await session.permissionChannel?.close();
			await Promise.resolve(this.stopProcess(child)).catch(() => {});
			await session.exited;
			if (session.active !== active || session.cancelling) return;
			const error = /* @__PURE__ */ new Error(`AGY stalled after error_message step ${active.lastStepIndex ?? "unknown"} without emitting a terminal result (${dbState.status})`);
			error.code = "AGY_ERROR_RESULT_TIMEOUT";
			error.details = {
				conversationId,
				stepIndex: active.lastStepIndex,
				dbStatus: dbState.status
			};
			await this.loseTurn(session, error);
			return;
		}
		await this.event(session, {
			event: "result",
			result: {
				conversation_id: conversationId,
				status: "ERROR",
				error: errorText
			},
			_watchdogSynthesized: true,
			_watchdogConfirmedFlush: dbState.status === "terminal_error" || dbState.status === "missing_db" && NATIVE_ID.test(conversationId ?? "")
		});
	}
	async event(session, event) {
		if (!event || typeof event !== "object") throw new Error("Invalid AGY event");
		if (event.event === "init") {
			if (session.init) throw new Error("AGY sent duplicate init");
			const init = event.init;
			if (!(typeof init?.cwd === "string" && (process.platform === "win32" ? resolve(init.cwd).toLowerCase() === resolve(session.cwd).toLowerCase() : resolve(init.cwd) === resolve(session.cwd)))) throw new Error("AGY init cwd does not match the frozen workspace binding; do not run tools in another project");
			if (session.model !== "engine-default" && init?.model !== session.model) throw new Error("AGY init model does not match the explicit binding");
			if (session.conversationId && event.conversation_id !== session.conversationId) throw new Error("AGY init conversation does not match the exact native resume binding");
			session.init = event;
			await this.audit(session, "agy_init", {
				conversationId: event.conversation_id,
				model: init?.model,
				agent: init?.agent,
				cwd: init?.cwd,
				projectId: init?.project_id ?? event.project_id,
				permissionMode: init?.permission_mode,
				tools: init?.tools
			});
			return;
		}
		const active = session.active;
		if (!active && session.broken) return;
		if (!active) throw new Error("AGY event arrived outside an active turn");
		if (event.event === "step_update") {
			const step = event.step_update;
			if (!step || typeof step.step_type !== "string") throw new Error("Malformed AGY step");
			if (step.step_type === "user_input" && step.state === "DONE") {
				active.promptConsumed = true;
				active.continuationWriter = void 0;
				active.lastStepType = "user_input";
				active.lastStepState = step.state;
				active.lastStepIndex = step.step_index;
				active.consecutiveErrorSteps = 0;
				active.lastErrorStepText = void 0;
				active.finalResponseDone = false;
				active.finalResponseStepIndex = void 0;
				active.finalResponseText = "";
				if (Number.isSafeInteger(step.step_index)) active.progressFloor = Math.max(active.progressFloor, step.step_index);
				await this.audit(session, "prompt_consumed", { stepIndex: step.step_index });
			} else {
				active.lastStepType = step.step_type;
				active.lastStepState = step.state;
				active.lastStepIndex = step.step_index;
				if (step.step_type === "error_message") {
					active.consecutiveErrorSteps = (active.consecutiveErrorSteps ?? 0) + 1;
					const stepError = typeof step.error === "string" && step.error ? step.error : typeof step.error === "object" && step.error !== null && typeof step.error.message === "string" && step.error.message ? step.error.message : typeof step.text_delta === "string" && step.text_delta ? step.text_delta : void 0;
					if (stepError !== void 0) active.lastErrorStepText = stepError;
				} else {
					active.consecutiveErrorSteps = 0;
					active.lastErrorStepText = void 0;
				}
				if (step.step_type !== "agent_response") {
					active.finalResponseDone = false;
					active.finalResponseStepIndex = void 0;
					active.finalResponseText = "";
				}
			}
			active.usageSteps ??= /* @__PURE__ */ new Set();
			active.usage ??= emptyUsage();
			if (accumulateStepUsage(active.usageSteps, active.usage, step)) await this.audit(session, "native_usage", {
				stepIndex: step.step_index,
				usage: { ...active.usage }
			});
			const freshStep = Boolean(active.promptConsumed) && Number.isSafeInteger(step.step_index) && step.step_index > active.progressFloor;
			if (step.step_type === "agent_response") {
				if (active.finalResponseStepIndex !== step.step_index) {
					active.finalResponseStepIndex = step.step_index;
					active.finalResponseText = "";
					active.finalResponseDone = false;
				}
				if (typeof step.text_delta === "string" && step.text_delta) {
					active.text += step.text_delta;
					active.finalResponseText += step.text_delta;
					await active.client.notify("session/update", {
						sessionId: session.id,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: {
								type: "text",
								text: step.text_delta
							}
						}
					});
				}
				active.finalResponseDone = step.state === "DONE" && active.finalResponseText.length > 0;
				if (freshStep && active.finalResponseDone && active.finalResponseText.trim()) active.progressSinceRecovery = true;
			}
			if (step.step_type === "tool" || step.step_type === "subagent") {
				const id = `agy-${event.conversation_id ?? session.init?.conversation_id}-${step.step_index}`;
				const previousName = session.toolDetails.get(id)?.name;
				const detail = {
					name: step.tool_name ?? step.tool_info?.name ?? previousName ?? (step.step_type === "subagent" ? "invoke_subagent" : void 0),
					state: step.state
				};
				const parameters = step.tool_info?.parameters ?? step.parameters;
				const structured = subagentPayload(step);
				const rawInput = structured === void 0 ? parameters : {
					...parameters !== null && typeof parameters === "object" && !Array.isArray(parameters) ? parameters : {},
					...structured
				};
				const previousInput = session.toolInputs.get(id);
				if (rawInput !== void 0) session.toolInputs.set(id, rawInput);
				session.toolDetails.set(id, detail);
				if (!session.toolIds.has(id)) {
					session.toolIds.set(id, "pending");
					await active.client.notify("session/update", {
						sessionId: session.id,
						update: {
							sessionUpdate: "tool_call",
							toolCallId: id,
							title: detail.name ?? "AGY tool",
							name: detail.name,
							kind: "other",
							status: "in_progress",
							rawInput,
							...structured === void 0 ? {} : { _meta: structured }
						}
					});
				} else if (session.active === active && step.state !== "DONE" && step.state !== "ERROR" && session.toolIds.get(id) === "pending" && (detail.name !== previousName || rawInput !== void 0 && JSON.stringify(rawInput) !== JSON.stringify(previousInput))) await active.client.notify("session/update", {
					sessionId: session.id,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: id,
						title: detail.name,
						name: detail.name,
						status: "in_progress",
						rawInput: rawInput ?? previousInput,
						...structured === void 0 ? {} : { _meta: structured }
					}
				});
				await this.audit(session, "tool_state", {
					toolCallId: id,
					...detail
				});
				if (session.active === active && (step.state === "DONE" || step.state === "ERROR") && session.toolIds.get(id) === "pending") {
					const failed = step.state === "ERROR" || Boolean(step.tool_info?.error);
					if (freshStep && !failed) active.progressSinceRecovery = true;
					const error = step.tool_info?.error ?? step.error;
					session.toolIds.set(id, "settled");
					const errorText = typeof error === "string" ? error : error?.message;
					const output = step.tool_info?.output ?? step.tool_info?.result ?? errorText ?? (failed ? "AGY tool reported an error" : void 0);
					const deniedCandidate = typeof errorText === "string" ? errorText : typeof output === "string" ? output : "";
					if (failed && /^tool call denied by pre-tool hook:/i.test(deniedCandidate.trimStart())) {
						(active.preToolDenied ??= /* @__PURE__ */ new Set()).add(id);
						await this.audit(session, "pre_tool_hook_denied", {
							toolCallId: id,
							error: errorText ?? output
						});
					}
					const finalInput = rawInput ?? previousInput;
					await active.client.notify("session/update", {
						sessionId: session.id,
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId: id,
							title: detail.name,
							name: detail.name,
							status: failed ? "failed" : "completed",
							rawInput: finalInput,
							...structured === void 0 ? {} : { _meta: structured },
							rawOutput: output,
							content: typeof output === "string" ? [{
								type: "content",
								content: {
									type: "text",
									text: output
								}
							}] : void 0
						}
					});
				}
			}
			if (step.step_type === "error_message" && step.state === "DONE") this.armErrorResultWatchdog(session, active);
			return;
		}
		this.clearErrorResultWatchdog(active);
		if (event.event !== "result" || !event.result) throw new Error(`Unsupported AGY event: ${event.event}`);
		const result = event.result;
		await this.audit(session, "agy_result", {
			conversationId: result.conversation_id,
			status: result.status,
			numTurns: result.num_turns,
			usage: result.usage,
			deniedActions: result.denied_actions,
			synthesizedByWatchdog: event._watchdogSynthesized === true ? true : void 0,
			responseSha256: createHash("sha256").update(result.response ?? "").digest("hex")
		});
		const newDenials = takeNewDenials(result.denied_actions, session.denialCounts);
		if (session.active !== active || session.cancelling) return;
		if (result.status === "SUCCESS" && session.mcpServers.length !== session.mcpReady.size) throw new Error("AGY did not activate and initialize the requested session MCP plugin; preserve native plugin/MCP off settings and review the connection instead of switching agents");
		const unresolved = this.unresolvedTools(session);
		const unresolvedMessage = unresolved.length ? this.unknownToolMessage("AGY terminal result arrived before a tool terminal update", unresolved) : void 0;
		if (unresolved.length) {
			session.broken = true;
			session.failure = unresolvedMessage;
			await this.audit(session, "tool_terminal_missing", {
				conversationId: result.conversation_id,
				nativeStatus: result.status,
				tools: unresolved
			});
		}
		let error;
		let stopReason = "end_turn";
		let stopAfterResult = false;
		let postResponseTerminalError;
		const nonRecoverableError = /\b(?:401|403|429|RESOURCE_EXHAUSTED|UNAUTHENTICATED|PERMISSION_DENIED)\b|quota[\s_-]*(?:reached|exceeded|exhausted)|rate[\s_-]*limit|insufficient[\s_-]*quota|unauthorized|authentication\s+failed/i;
		const lateTransportDisconnect = result.status === "ERROR" && typeof result.error === "string" && /\b(?:wsarecv|wsasend|connectex|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|EOF|UNAVAILABLE|DEADLINE_EXCEEDED|502|503|504)\b|socket\s+hang\s+up|dial\s+tcp|read\s+tcp|write\s+tcp|actively\s+refused|connection\s+refused|connection\s+attempt\s+failed|connection\s+was\s+forcibly\s+closed|broken\s+pipe|tls\s+handshake\s+timeout|context\s+deadline\s+exceeded|http2:\s+(?:client\s+connection\s+(?:lost|force\s+closed)|server\s+sent\s+GOAWAY)|stream\s+error:\s+stream\s+ID|bad\s+gateway|service\s+unavailable|gateway\s+timeout/i.test(result.error) && !nonRecoverableError.test(result.error);
		const replayedSummaryError = result.status === "ERROR" && typeof result.error === "string" && (result.error === "There was a network issue connecting to the server, please try again." || /^The stream was interrupted\. Please continue the task you were working on\.$/i.test(result.error)) && !nonRecoverableError.test(result.error);
		const confirmedFinalResponse = Boolean((lateTransportDisconnect || replayedSummaryError) && active.promptConsumed && !unresolved.length && active.steering.length === 0 && !active.steerDeliveryUnknown && active.lastStepType === "agent_response" && active.lastStepState === "DONE" && active.finalResponseDone && active.text.length > active.segmentStart && (lateTransportDisconnect ? typeof result.response !== "string" || result.response.length === 0 || result.response === active.text.slice(active.segmentStart) : typeof result.response === "string" && result.response.length > 0 && result.response === active.text.slice(active.segmentStart)));
		const recoverableNetworkError = (lateTransportDisconnect || replayedSummaryError) && !confirmedFinalResponse && Boolean(active.promptConsumed) && unresolved.length === 0 && active.steering.length === 0 && !active.steerDeliveryUnknown && !active.denied && newDenials.length === 0 && !active.preToolDenied?.size;
		if (recoverableNetworkError && active.progressSinceRecovery) {
			active.networkRecoveries = 0;
			active.progressSinceRecovery = false;
		}
		const continuationAllowed = recoverableNetworkError && active.networkRecoveries < this.maxConsecutiveNetworkRecoveries;
		if (continuationAllowed) {
			const attempt = active.networkRecoveries + 1;
			const preservedTools = session.toolIds.size;
			await this.audit(session, "network_recovery_requested", {
				conversationId: result.conversation_id,
				nativeStatus: result.status,
				error: result.error,
				attempt,
				totalAttempts: active.networkRecoveriesTotal + 1,
				preservedTools,
				preservedTextLength: active.text.length,
				liveChild: Boolean(session.child && session.child.exitCode === null && session.child.signalCode === null)
			});
			if (session.active !== active || session.cancelling) return;
			active.networkRecoveries = attempt;
			active.networkRecoveriesTotal += 1;
			try {
				const sent = await this.continueNetworkFailure(session, active, attempt, result, { allowForcedExit: event._watchdogConfirmedFlush === true });
				if (sent?.outcome === "sent") {
					await this.audit(session, "network_recovery_sent", {
						conversationId: sent.conversationId,
						attempt,
						relaunched: sent.relaunched,
						bytes: sent.bytes,
						frameSha256: sent.frameSha256
					});
					return;
				}
				active.networkRecoveries -= 1;
				active.networkRecoveriesTotal -= 1;
				if (sent?.outcome === "unknown") {
					const message = `AGY terminal status ${result.status}: ${result.error ?? "no success result"}; delivery of automatic continuation ${attempt} is unconfirmed; it is not re-sent and no new conversation is opened; inspect the native outcome before continuing`;
					await this.audit(session, "network_recovery_failed", {
						conversationId: result.conversation_id,
						attempt,
						delivery: "unknown"
					});
					error = new Error(message);
					error.details = {
						nativeError: result.error,
						attempt,
						recoveries: active.networkRecoveriesTotal,
						preservedTools,
						conversationId: result.conversation_id,
						delivery: "unknown"
					};
					session.broken = true;
					session.failure = message;
					stopAfterResult = true;
				} else if (sent?.outcome === "exit_unconfirmed") {
					const message = `AGY terminal status ${result.status}: ${result.error ?? "no success result"}; headless CLI did not exit cleanly after the terminal error (${sent.reason}; exitCode: ${sent.exitCode ?? "none"}, signal: ${sent.signal ?? "none"}); native state flush is unconfirmed, so automatic continuation was not sent; inspect the native outcome before continuing`;
					await this.audit(session, "network_recovery_failed", {
						conversationId: result.conversation_id,
						attempt,
						delivery: "not_sent",
						reason: sent.reason,
						exitCode: sent.exitCode ?? null,
						signal: sent.signal ?? null
					});
					error = new Error(message);
					error.details = {
						nativeError: result.error,
						attempt,
						recoveries: active.networkRecoveriesTotal,
						preservedTools,
						conversationId: result.conversation_id,
						delivery: "not_sent",
						reason: sent.reason,
						exitCode: sent.exitCode ?? null,
						signal: sent.signal ?? null
					};
					session.broken = true;
					session.failure = message;
					stopAfterResult = true;
				} else await this.audit(session, "network_recovery_skipped", {
					conversationId: result.conversation_id,
					attempt,
					reason: "conversation_evidence_incomplete"
				});
			} catch (continueError) {
				active.networkRecoveries -= 1;
				active.networkRecoveriesTotal -= 1;
				const continueMsg = continueError instanceof Error ? continueError.message : String(continueError);
				const message = `AGY terminal status ${result.status}: ${result.error ?? "no success result"}; automatic continuation ${attempt} could not be delivered: ${continueMsg}; delivery of the continuation is unknown and it is not retried; inspect the native outcome before continuing`;
				await this.audit(session, "network_recovery_failed", {
					conversationId: result.conversation_id,
					attempt,
					delivery: "unknown",
					error: continueMsg
				});
				error = new Error(message);
				error.details = {
					nativeError: result.error,
					attempt,
					recoveries: active.networkRecoveriesTotal,
					preservedTools,
					conversationId: result.conversation_id,
					delivery: "unknown"
				};
				session.broken = true;
				session.failure = message;
				stopAfterResult = true;
			}
		}
		if (recoverableNetworkError && !continuationAllowed) {
			const preservedTools = session.toolIds.size;
			const consecutiveRecoveries = active.networkRecoveries;
			const message = `AGY terminal status ${result.status}: ${result.error ?? "no success result"}; automatic continuation stopped after ${consecutiveRecoveries} consecutive attempts without progress; every completed tool result (${preservedTools}) and native conversation ${result.conversation_id ?? "(unknown)"} are retained; load that exact native conversation to continue it, instead of replaying the prompt or the finished tool calls`;
			await this.audit(session, "network_recovery_exhausted", {
				conversationId: result.conversation_id,
				error: result.error,
				recoveries: active.networkRecoveriesTotal,
				consecutiveRecoveries,
				preservedTools
			});
			error = new Error(message);
			error.details = {
				nativeError: result.error,
				recoveries: active.networkRecoveriesTotal,
				consecutiveRecoveries,
				preservedTools,
				conversationId: result.conversation_id
			};
			session.broken = true;
			session.failure = message;
			stopAfterResult = true;
		}
		if (active.denied || newDenials.length > 0 || active.preToolDenied?.size) {
			active.denied = false;
			const actions = [...new Set(newDenials.map((action) => typeof action?.action === "string" ? action.action : "unknown"))];
			const message = `AGY permission denied${actions.length ? ` for ${actions.join(", ")}` : ""}; ${active.preToolDenied?.size ? "a PreToolUse hook rejected a tool before execution; retain the denial; terminal SUCCESS is not evidence that the requested work ran" : "the native AGY permission policy did not approve the action"}${unresolvedMessage ? `; ${unresolvedMessage}` : ""}`;
			await this.settlePendingTools(session, active, message);
			process.stderr.write(`${message}\n`);
			error = new Error(message);
			error.code = "AGY_PERMISSION_DENIED";
			error.details = {
				deniedToolCallIds: [...active.preToolDenied ?? []],
				unresolvedTools: unresolved
			};
		} else if (result.status === "CANCELED" || result.status === "INTERRUPTED" || result.status === "ERROR" && result.error === "interrupted") {
			const message = unresolvedMessage ?? `AGY turn ${result.status.toLowerCase()}; do not replay interrupted prompts or commands`;
			session.broken = true;
			session.failure = message;
			await this.settlePendingTools(session, active, message);
			stopReason = "cancelled";
			stopAfterResult = true;
		} else if (result.status !== "SUCCESS" && confirmedFinalResponse) {
			postResponseTerminalError = `AGY terminal status ${result.status}: ${result.error ?? "no success result"}`;
			session.broken = true;
			session.failure = postResponseTerminalError;
			stopAfterResult = true;
		} else if (result.status !== "SUCCESS" && error === void 0) {
			const message = `AGY terminal status ${result.status}: ${result.error ?? "no success result"}`;
			await this.settlePendingTools(session, active, unresolvedMessage ?? message);
			error = new Error(unresolvedMessage ? `${message}; ${unresolvedMessage}` : message);
			session.broken = true;
			session.failure = error.message;
			stopAfterResult = true;
		} else if (unresolvedMessage) {
			await this.settlePendingTools(session, active, unresolvedMessage);
			error = new Error(unresolvedMessage);
			error.code = "AGY_TOOL_TERMINAL_MISSING";
			error.details = {
				conversationId: result.conversation_id,
				unresolvedTools: unresolved
			};
		} else if (error === void 0 && active.text.length === active.segmentStart && result.response) await active.client.notify("session/update", {
			sessionId: session.id,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: {
					type: "text",
					text: result.response
				}
			}
		});
		if (session.active !== active || session.cancelling) return;
		if (postResponseTerminalError !== void 0) await this.audit(session, "post_response_terminal_error", {
			conversationId: result.conversation_id,
			status: result.status,
			error: result.error,
			stepIndex: active.finalResponseStepIndex,
			responseSha256: createHash("sha256").update(active.text).digest("hex")
		});
		if (stopReason === "cancelled") await this.audit(session, "cancel", {
			pid: session.child?.pid,
			processEnded: false,
			resumeSupported: false,
			unresolvedTools: unresolved
		});
		else if (!unresolved.length && error?.details?.["delivery"] !== "unknown" && error?.details?.["delivery"] !== "not_sent") await this.audit(session, "native_turn_reconciled", {
			status: result.status,
			preservedCompletedResponse: postResponseTerminalError !== void 0 ? true : void 0
		});
		if (session.active !== active || session.cancelling) return;
		session.active = void 0;
		if (stopAfterResult) {
			await session.permissionChannel?.close();
			await Promise.resolve(this.stopProcess(session.child)).catch(() => {});
			await session.exited;
			await this.closeSteeringHook(session).catch(() => {});
			await session.mcpPlugin?.close();
			if (!session.restarting) await session.releaseResume?.();
		}
		if (error) active.reject(error);
		else active.resolve({
			stopReason,
			...active.usageSteps?.size ? { usage: { ...active.usage } } : {}
		});
	}
	async prompt(params, client) {
		const session = this.session(params.sessionId);
		if (session.broken) throw new Error(session.failure ?? "AGY process ended; create a fresh session (no implicit resume/history handoff)");
		if (session.active) throw new Error("AGY session already has an active turn");
		const content = promptText(params.prompt);
		const promise = new Promise((resolveTurn, rejectTurn) => {
			const active = {
				client,
				text: "",
				steering: [],
				networkRecoveries: 0,
				networkRecoveriesTotal: 0,
				segmentStart: 0,
				progressSinceRecovery: false,
				progressFloor: -1,
				recoveryAbort: new AbortController(),
				usageSteps: /* @__PURE__ */ new Set(),
				usage: emptyUsage(),
				denied: false,
				finalResponseText: "",
				resolve: (value) => {
					this.clearErrorResultWatchdog(active);
					this.releaseSteering(session, active);
					this.closeSteeringHook(session).catch(() => {}).then(() => resolveTurn(value));
				},
				reject: (error) => {
					this.clearErrorResultWatchdog(active);
					this.releaseSteering(session, active);
					this.closeSteeringHook(session).catch(() => {}).then(() => rejectTurn(error));
				}
			};
			session.active = active;
		});
		promise.catch(() => {});
		try {
			session.preparing = (async () => {
				await this.recoverDeadOwnedResources(session);
				await this.syncPermissionHook(session);
				await this.registerSteeringHook(session);
				if (!session.broken && !session.child) await this.start(session);
			})();
			try {
				await session.preparing;
			} finally {
				session.preparing = void 0;
			}
			if (session.broken) return await promise;
			await this.audit(session, "native_turn_pending");
			if (session.broken) return await promise;
			const frame = JSON.stringify({
				event: "user",
				message: { content }
			}) + "\n";
			try {
				await writeNdjsonFrame(session.child.stdin, frame);
			} catch (error) {
				if (session.broken) return await promise;
				throw error;
			}
			await this.audit(session, "prompt_sent", {
				bytes: Buffer.byteLength(frame),
				promptSha256: createHash("sha256").update(content).digest("hex"),
				frameSha256: createHash("sha256").update(frame).digest("hex"),
				delivery: "unchanged_user_text"
			});
			return await promise;
		} catch (error) {
			if (session.active) {
				this.clearErrorResultWatchdog(session.active);
				this.releaseSteering(session, session.active);
				session.active = void 0;
			}
			await this.closeSteeringHook(session).catch(() => {});
			throw error;
		}
	}
	async cancel(params) {
		const session = this.session(params.sessionId);
		if (session.cancelling) return session.cancelling;
		session.cancelling = this.cancelOwnedSession(session);
		try {
			await session.cancelling;
		} finally {
			session.cancelling = void 0;
		}
	}
	/**
	* Continues the same native conversation after a recoverable network terminal error, using
	* only evidence the adapter already confirmed: the finished terminal result, the native UUID
	* conversation ID it named, settled tool states, and a natural process exit.
	*
	* After emitting a terminal `result: ERROR` frame, headless AGY ends its invocation loop and
	* exits once its native SQLite and transcript flush completes. Close its stdin, wait for that
	* natural exit, relaunch the CLI with the recorded `--conversation`, and send only the
	* continuation frame. If the process must be force-stopped on timeout or exits via a signal,
	* native persistence is unconfirmed and the continuation is not sent.
	*/
	async continueNetworkFailure(session, active, attempt, result, { allowForcedExit = false } = {}) {
		if (session.active !== active || session.cancelling || active.denied) return void 0;
		const conversationId = typeof result?.conversation_id === "string" && result.conversation_id ? result.conversation_id : void 0;
		if (!conversationId || !NATIVE_ID.test(conversationId)) return void 0;
		if (session.init?.conversation_id !== void 0 && session.init.conversation_id !== conversationId) return;
		if (session.conversationId !== void 0 && session.conversationId !== conversationId) return;
		const owned = session.child;
		if (!owned) return void 0;
		const frame = JSON.stringify({
			event: "user",
			message: { content: `${NETWORK_RECOVERY_INSTRUCTION} (automatic continuation ${attempt}).` }
		}) + "\n";
		session.restarting = true;
		let exitUnconfirmed;
		try {
			const prepare = async () => {
				let forceStopped = false;
				if (owned.exitCode === null && owned.signalCode === null) {
					owned.stdin?.end();
					let timer;
					const stopFallback = new Promise((_, reject) => {
						timer = setTimeout(() => {
							forceStopped = true;
							Promise.resolve(this.stopProcess(owned)).catch(reject);
						}, this.continuationExitGraceMs);
					});
					try {
						await Promise.race([session.exited, stopFallback]);
					} finally {
						clearTimeout(timer);
					}
				}
				await session.exited;
				if (session.active !== active || session.cancelling) return;
				const exitCode = owned.exitCode ?? null;
				const signal = owned.signalCode ?? null;
				await session.permissionChannel?.close();
				await this.closeSteeringHook(session);
				await session.mcpPlugin?.close();
				session.child = void 0;
				session.init = void 0;
				session.exited = void 0;
				session.cleanup = void 0;
				session.permissionChannel = void 0;
				session.mcpPlugin = void 0;
				session.mcpBound.clear();
				session.mcpReady.clear();
				if (!allowForcedExit && (forceStopped || signal !== null || !Number.isSafeInteger(exitCode) || exitCode < 0)) {
					exitUnconfirmed = {
						outcome: "exit_unconfirmed",
						conversationId,
						reason: forceStopped ? "exit_timeout_stopped" : signal !== null ? "signal_exit" : "missing_exit_code",
						exitCode,
						signal
					};
					return;
				}
				await this.audit(session, "close", {
					pid: owned.pid,
					processEnded: true,
					exitCode,
					signal,
					forcedAfterWatchdog: allowForcedExit && forceStopped ? true : void 0
				});
				const backoff = this.networkRecoveryBackoffMs[Math.min(attempt - 1, this.networkRecoveryBackoffMs.length - 1)] ?? 0;
				const { signal: recoverySignal } = active.recoveryAbort;
				if (backoff > 0) try {
					await setTimeout$1(backoff, void 0, { signal: recoverySignal });
				} catch (error) {
					if (error.code !== "ABORT_ERR") throw error;
				}
				if (session.active !== active || session.cancelling || recoverySignal.aborted) return;
				session.conversationId = conversationId;
				session.broken = false;
				await this.syncPermissionHook(session);
				await this.registerSteeringHook(session);
				if (session.active !== active || session.cancelling) return;
				await this.start(session);
			};
			session.preparing = prepare();
			try {
				await session.preparing;
			} finally {
				session.preparing = void 0;
			}
		} finally {
			session.restarting = false;
		}
		if (exitUnconfirmed) return exitUnconfirmed;
		if (session.active !== active || session.broken || session.cancelling) return void 0;
		const relaunched = await this.#writeContinuation(session, active, frame);
		if (relaunched === "not-written") return void 0;
		if (relaunched === "unknown") return {
			outcome: "unknown",
			conversationId
		};
		return {
			outcome: "sent",
			conversationId,
			relaunched: true,
			bytes: Buffer.byteLength(frame),
			frameSha256: createHash("sha256").update(frame).digest("hex")
		};
	}
	async #writeContinuation(session, active, frame) {
		const child = session.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return "not-written";
		active.continuationWriter = child;
		active.promptConsumed = false;
		active.consecutiveErrorSteps = 0;
		active.lastErrorStepText = void 0;
		active.segmentStart = active.text.length;
		active.finalResponseDone = false;
		active.finalResponseStepIndex = void 0;
		active.finalResponseText = "";
		active.progressSinceRecovery = false;
		try {
			await writeNdjsonFrame(child.stdin, frame);
			return "written";
		} catch {
			return "unknown";
		}
	}
	async cancelOwnedSession(session) {
		const active = session.active;
		this.clearErrorResultWatchdog(active);
		active?.recoveryAbort.abort();
		session.broken = true;
		let requestAuditError;
		try {
			try {
				await this.audit(session, "cancel_requested", {
					pid: session.child?.pid,
					resumeSupported: false
				});
			} catch (error) {
				requestAuditError = error;
			}
			await session.preparing?.catch(() => {});
			await session.permissionChannel?.close();
			await this.stopProcess(session.child);
			await session.exited;
			await session.cleanup;
			await this.closeSteeringHook(session).catch(() => {});
			await session.mcpPlugin?.close();
			if (requestAuditError !== void 0) throw asAgyError(requestAuditError);
			const unresolved = this.unresolvedTools(session);
			if (active && unresolved.length) await this.settlePendingTools(session, active, this.unknownToolMessage("AGY turn cancelled before a tool terminal update", unresolved));
			await this.audit(session, "cancel", {
				pid: session.child?.pid,
				processEnded: true,
				resumeSupported: false,
				unresolvedTools: unresolved
			});
			active?.resolve({ stopReason: "cancelled" });
		} catch (error) {
			await session.drainReceived?.();
			session.active = void 0;
			const unresolved = this.unresolvedTools(session);
			const exitCode = session.child?.exitCode ?? null;
			const signal = session.child?.signalCode ?? null;
			const outcome = {
				processEnded: exitCode !== null || signal !== null,
				exitCode,
				signal
			};
			const failure = asAgyError(requestAuditError ?? error);
			const errObj = asAgyError(error);
			const cancelError = failure === error ? void 0 : {
				code: errObj.code,
				message: errObj.message
			};
			failure.details = {
				...failure.details,
				...outcome,
				cancelError
			};
			await this.audit(session, "cancel_failed", {
				pid: session.child?.pid,
				...outcome,
				unresolvedTools: unresolved,
				cancelError
			}).catch((auditError) => {
				const msg = auditError instanceof Error ? auditError.message : String(auditError);
				failure.details = {
					...failure.details,
					retirementAuditError: msg
				};
			});
			if (active) await this.rejectUnconfirmedTurn(session, active, failure, unresolved, failure === requestAuditError);
			throw failure;
		} finally {
			session.active = void 0;
		}
	}
	close() {
		this.closePromise ??= Promise.all([...this.sessions.values()].map(async (session) => {
			if (session.cancelling) await session.cancelling.catch(() => {});
			const active = session.active;
			this.clearErrorResultWatchdog(active);
			session.active = void 0;
			session.broken = true;
			try {
				const unresolved = this.unresolvedTools(session);
				if (active && unresolved.length) {
					await this.audit(session, "tool_terminal_missing", {
						reason: "connection_closed",
						tools: unresolved
					});
					await this.settlePendingTools(session, active, this.unknownToolMessage("ACP connection closed before a tool terminal update", unresolved));
				}
			} finally {
				active?.reject(/* @__PURE__ */ new Error("ACP connection closed"));
				await session.preparing?.catch(() => {});
				await session.permissionChannel?.close();
				if (session.child && session.child.exitCode === null && session.child.signalCode === null) {
					session.child.stdin?.end();
					let timer;
					const stopFailure = new Promise((_, reject) => {
						timer = setTimeout(() => {
							Promise.resolve(this.stopProcess(session.child)).catch(reject);
						}, 3e3);
					});
					try {
						await Promise.race([session.exited, stopFailure]);
					} finally {
						clearTimeout(timer);
					}
				}
				await session.cleanup;
				await this.closeSteeringHook(session).catch(() => {});
				await session.mcpPlugin?.close();
				await session.releaseResume?.();
				await this.audit(session, "close", {
					pid: session.child?.pid,
					processEnded: true
				});
			}
		}));
		return this.closePromise;
	}
};

//#endregion
//#region src/sessionMcp.ts
async function runSessionMcp(key) {
	if (!/^KIKI_AGY_MCP_[a-f0-9_]+_[0-9]+$/.test(key)) throw new Error("Invalid session MCP environment key");
	const rawServer = process.env[key];
	if (rawServer === void 0) {
		for await (const line of readNdjsonLines(process.stdin)) {
			if (!line.trim()) continue;
			const request = JSON.parse(line);
			if (!Object.hasOwn(request, "id")) continue;
			let result;
			if (request.method === "initialize") result = {
				protocolVersion: request.params?.protocolVersion,
				capabilities: {
					tools: {},
					resources: {},
					prompts: {}
				},
				serverInfo: {
					name: "kiki-unbound-session",
					version: "1"
				}
			};
			else if (request.method === "tools/list") result = { tools: [] };
			else if (request.method === "resources/list") result = { resources: [] };
			else if (request.method === "resources/templates/list") result = { resourceTemplates: [] };
			else if (request.method === "prompts/list") result = { prompts: [] };
			else if (request.method === "ping") result = {};
			process.stdout.write(JSON.stringify(result === void 0 ? {
				jsonrpc: "2.0",
				id: request.id,
				error: {
					code: -32601,
					message: "No Kiki session lease is bound to this process"
				}
			} : {
				jsonrpc: "2.0",
				id: request.id,
				result
			}) + "\n");
		}
		return;
	}
	const server = JSON.parse(rawServer);
	if (!server || typeof server.command !== "string" || !Array.isArray(server.args) || !Array.isArray(server.env)) throw new Error("Session MCP launch context is invalid");
	if ((await requestHookPermission({
		type: "mcp_bootstrap",
		key
	}, process.env, 1e4)).decision !== "allow") throw new Error("The session MCP bootstrap was not admitted by its owning adapter");
	const env = {
		...process.env,
		...Object.fromEntries(server.env.map((entry) => [entry.name, entry.value]))
	};
	for (const name of Object.keys(env)) if (name.startsWith("KIKI_AGY_")) delete env[name];
	const child = spawn(server.command, server.args, {
		env,
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		],
		windowsHide: true
	});
	const closed = new Promise((done) => child.once("close", done));
	const outputAbort = new AbortController();
	const inputAbort = new AbortController();
	let failure;
	const fail = (error) => {
		failure ??= error;
		outputAbort.abort();
	};
	child.once("error", fail);
	child.stdin.on("error", fail);
	const lists = /* @__PURE__ */ new Set();
	const pumpInput = (async () => {
		try {
			for await (const line of readNdjsonLines(process.stdin, { signal: inputAbort.signal })) {
				try {
					const frame = JSON.parse(line);
					if (frame.method === "tools/list" && frame.id !== void 0) lists.add(frame.id);
				} catch {}
				if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(line + "\n");
			}
			if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
		} catch {}
	})();
	child.stderr.pipe(process.stderr);
	const stop = () => {
		terminate(child).catch(fail);
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		let ready = false;
		for await (const line of readNdjsonLines(child.stdout, { signal: outputAbort.signal })) {
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {}
			if (!ready && lists.has(frame?.id) && Array.isArray(frame?.result?.tools)) {
				if ((await requestHookPermission({
					type: "mcp_ready",
					key
				}, process.env, 1e4)).decision !== "allow") throw new Error("The session MCP readiness was not admitted by its owning adapter");
				ready = true;
			}
			process.stdout.write(line + "\n");
		}
		if (failure instanceof Error) throw new Error(failure.message, { cause: failure });
		if (failure) throw new Error("AGY session MCP child failed", { cause: failure });
		process.exitCode = await closed ?? 1;
	} finally {
		inputAbort.abort();
		process.stdin.pause();
		outputAbort.abort();
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
		if (child.pid !== void 0) await terminate(child);
		await closed;
		await pumpInput;
	}
}

//#endregion
//#region src/index.ts
async function runBridge({ sdkPath, cliPath, cliPrefix = [], auditDir, model = DEFAULT, account } = {}) {
	if (!isAbsolute(sdkPath ?? "")) throw new Error("Pass an installed ACP SDK absolute path");
	const acp = await import(pathToFileURL(sdkPath).href);
	const bridge = new AgyBridge({
		cliPath,
		cliPrefix,
		auditDir,
		model,
		account,
		onAccountExit: () => setImmediate(shutdown)
	});
	await bridge.loadVendorModels();
	const sessionRequest = (handler) => async (ctx) => {
		try {
			return await handler(ctx);
		} catch (error) {
			if (account) setImmediate(shutdown);
			const agyErr = error;
			throw new acp.RequestError(-32603, error instanceof Error ? error.message : String(error), {
				adapterCode: agyErr?.code,
				details: agyErr?.details
			});
		}
	};
	const connection = acp.agent({
		name: "agy-cli-acp",
		version: "0.2.0"
	}).onRequest("initialize", () => bridge.initialize(acp.PROTOCOL_VERSION)).onRequest("session/new", sessionRequest((ctx) => bridge.newSession(ctx.params))).onRequest("session/load", sessionRequest((ctx) => bridge.loadSession(ctx.params))).onRequest("session/set_config_option", (ctx) => bridge.setConfig(ctx.params)).onRequest("session/prompt", sessionRequest((ctx) => bridge.prompt(ctx.params, ctx.client))).onRequest("_session/steering", (params) => params, sessionRequest((ctx) => bridge.steer(ctx.params))).onNotification("session/cancel", (ctx) => bridge.cancel(ctx.params)).connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		bridge.close().then(() => process.exit(0), (error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		});
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
	process.stdin.once("end", shutdown);
	try {
		await connection.closed;
	} finally {
		await bridge.close();
	}
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) if (process.argv.includes("--version") || process.argv.length === 3 && process.argv[2] === "--kiki-harness-account-version") console.log("agy-cli-acp 0.2.0");
else {
	const args = process.argv.slice(2);
	if (args.length === 2 && args[0] === "--mcp-stdio") runSessionMcp(args[1]).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
	else if (args.length === 3 && args[0] === "--recover-project-mcp") {
		if (!isAbsolute(args[1])) throw new Error("AGY MCP recovery workspace must be absolute");
		recoverProjectMcpPlugin({
			cwd: args[1],
			sessionId: args[2]
		}).then((result) => console.log(JSON.stringify(result))).catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
	} else if (args.length === 2 && args[0] === "--recover-project-hook") {
		if (!isAbsolute(args[1])) throw new Error("AGY hook recovery workspace must be absolute");
		recoverProjectHook({
			cwd: args[1],
			nodePath: process.execPath,
			handlerPath: fileURLToPath(new URL("./agy-permission-hook.mjs", import.meta.url))
		}).then((result) => console.log(JSON.stringify(result))).catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
	} else {
		const accountBound = args.at(-1) === "--kiki-harness-account";
		if (accountBound) args.pop();
		if (args.length && (args.length !== 2 || args[0] !== "--model")) throw new Error("Only --model <AGY model ID> or --recover-project-hook <workspace> is supported");
		const account = accountBound ? consumeAccountEnvironment() : void 0;
		runBridge({
			sdkPath: process.env["AGY_ACP_SDK_PATH"],
			cliPath: process.env["AGY_CLI_PATH"],
			auditDir: process.env["AGY_BRIDGE_AUDIT_DIR"],
			model: args[1] ?? "engine-default",
			account
		}).catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
	}
}

//#endregion
export { AgyBridge, NdjsonFrameDecoder, accumulateStepUsage, catalogDiagnostic, configOptions, consumeAccountEnvironment, createNdjsonLineTransform, encodeNativeMessage, encodedEffort, launchArgs, nativeBytesAt, nativeStringsAt, promptText, readLegacyNativeRecovery, readNdjsonLines, readVendorModelCatalog, runBridge, runSessionMcp, takeNewDenials, validateEffort, vendorModelIds, writeNdjsonFrame };