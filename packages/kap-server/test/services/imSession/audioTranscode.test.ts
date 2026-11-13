import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { HostProcessService } from '@kiki/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';

import { audioWavAttachmentPath, convertAudioToWav, findWingetPackageFfmpeg, inspectWav } from '../../../src/lib/ffmpegAudio';

const roots: string[] = [];

function pcmWav(sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const blockAlign = channels * bitsPerSample / 8;
  const dataBytes = blockAlign * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.byteLength - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * blockAlign, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
});

describe('IM audio ffmpeg conversion', () => {
  it('uses a deterministic session attachment path without accepting path segments or unsafe filename characters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-im-audio-path-'));
    roots.push(root);
    const path = audioWavAttachmentPath(root, '../../f_audio');
    expect(dirname(path)).toBe(root);
    expect(basename(path)).toBe('______f_audio.wav');
    expect(audioWavAttachmentPath(root, '../../f_audio')).toBe(path);
  });

  it('transcodes a real generated audio source to mono 16 kHz PCM WAV with an owned child process', async ({ skip }) => {
    const binary = await findWingetPackageFfmpeg() ?? 'ffmpeg';
    const probe = spawnSync(binary, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (probe.status !== 0) skip();
    const root = await mkdtemp(join(tmpdir(), 'kiki-im-audio-ffmpeg-'));
    roots.push(root);
    const inputPath = join(root, 'source.wav');
    const fileId = 'f_real_child_asr';
    const outputPath = audioWavAttachmentPath(root, fileId);
    const generated = spawnSync(binary, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2',
      '-c:a', 'pcm_s16le', '-f', 'wav', inputPath,
    ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    expect(generated.status, generated.stderr).toBe(0);
    const service = new HostProcessService();
    try {
      expect(await convertAudioToWav(inputPath, outputPath, new AbortController().signal, service)).toBe(outputPath);
      const result = await readFile(outputPath);
      expect(result.subarray(0, 4).toString()).toBe('RIFF');
      expect(result.subarray(8, 12).toString()).toBe('WAVE');
      expect(result.readUInt16LE(20)).toBe(1);
      expect(result.readUInt16LE(22)).toBe(1);
      expect(result.readUInt32LE(24)).toBe(16_000);
      expect(result.readUInt16LE(34)).toBe(16);
      expect(await stat(outputPath).then((value) => value.size)).toBeGreaterThan(44);
    } finally {
      await service.dispose();
    }
  });

  it('publishes a valid input WAV at the canonical derivative path when ffmpeg is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-im-audio-fallback-'));
    roots.push(root);
    const inputPath = join(root, 'source.wav');
    const outputPath = audioWavAttachmentPath(join(root, 'attachments'), 'f_voice');
    const input = pcmWav(44_100, 2, 24);
    await writeFile(inputPath, input);
    const commands: string[] = [];
    const spawn = async (command: string) => {
      commands.push(command);
      throw Object.assign(new Error('ffmpeg not found'), { code: 'ENOENT' });
    };
    await expect(convertAudioToWav(inputPath, outputPath, new AbortController().signal, { spawn }, 'configured-ffmpeg'))
      .resolves.toBe(outputPath);
    expect(commands[0]).toBe('configured-ffmpeg');
    expect(commands[1]).toBe('ffmpeg');
    expect(await readFile(outputPath)).toEqual(input);
    expect(await inspectWav(outputPath)).toEqual({ audioFormat: 1, channels: 2, sampleRate: 44_100, bitsPerSample: 24 });
    expect(await readdir(dirname(outputPath))).toEqual(['f_voice.wav']);
  });

  it('falls back to the original valid WAV after a short child timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-im-audio-timeout-'));
    roots.push(root);
    const inputPath = join(root, 'source.wav');
    const outputPath = audioWavAttachmentPath(join(root, 'attachments'), 'f_timeout');
    const input = pcmWav(44_100, 2, 24);
    await writeFile(inputPath, input);
    let finishWait: (code: number) => void = () => undefined;
    const spawn = async () => ({
      _serviceBrand: undefined,
      pid: 1,
      exitCode: null,
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      wait: () => new Promise<number>((resolve) => { finishWait = resolve; }),
      kill: async () => { finishWait(137); },
      dispose: () => undefined,
    });
    await expect(convertAudioToWav(inputPath, outputPath, new AbortController().signal, { spawn }, 'fixture-ffmpeg', 10))
      .resolves.toBe(outputPath);
    expect(await readFile(outputPath)).toEqual(input);
    expect(await readdir(dirname(outputPath))).toEqual(['f_timeout.wav']);
  });

  it('does not publish partial output from a failed child process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-im-audio-partial-'));
    roots.push(root);
    const inputPath = join(root, 'source.ogg');
    const outputPath = audioWavAttachmentPath(join(root, 'attachments'), 'f_partial');
    await writeFile(inputPath, 'not a WAV');
    const spawn = async (_command: string, args: readonly string[]) => {
      await writeFile(args.at(-1)!, 'partial');
      return {
        _serviceBrand: undefined,
        pid: 1,
        exitCode: null,
        stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        wait: async () => 1,
        kill: async () => undefined,
        dispose: () => undefined,
      };
    };
    await expect(convertAudioToWav(inputPath, outputPath, new AbortController().signal, { spawn }, 'fixture-ffmpeg'))
      .rejects.toThrow('Audio conversion failed');
    expect(await readdir(dirname(outputPath)).catch(() => [])).toEqual([]);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not spawn after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = async () => { throw new Error('ffmpeg should not run'); };
    await expect(convertAudioToWav('source.wav', 'result.wav', controller.signal, { spawn })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
