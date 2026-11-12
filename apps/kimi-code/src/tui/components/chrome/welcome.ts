/**
 * Welcome panel shown at the top of the TUI.
 * Renders a round-bordered box or a compact welcome for small terminals.
 */

import type { Component } from '@kiki/pi-tui';
import { truncateToWidth, visibleWidth } from '@kiki/pi-tui';
import chalk from 'chalk';

import { effectiveModelAlias } from '@kiki/node-sdk';

import { isRainbowDancing, renderDanceWelcomeHeader } from '#/tui/easter-eggs/dance';
import type { AppState } from '#/tui/types';
import { currentTheme } from '#/tui/theme';
import { shortenCwd } from '#/tui/utils/shorten-cwd';

const LOGIN_HINT = 'Run /login to get started.';
const MODEL_SELECTION_HINT = 'Choose a model with /model.';
const BOXED_DISCOVERY_HINT =
  'Type / for commands · /help for shortcuts · End a line with \\ + Enter for newline';
const COMPACT_DISCOVERY_HINT = '/ commands · /help keys · \\ + Enter newline';
const MODEL_UNSET_HINT = 'not set';
const HINT_SEPARATOR = ' · ';
const COMPACT_WIDTH = 60;
const BOXED_MIN_STARTUP_ROWS = 24;

type StyledSegment = {
  text: string;
  style: (text: string) => string;
};

function wrapSegments(
  segments: readonly StyledSegment[],
  width: number,
  styleSeparator: (text: string) => string,
): string[] {
  if (width <= 0) return [''];

  const lines: string[] = [];
  let line = '';
  let lineText = '';

  for (const segment of segments) {
    if (!segment.text) continue;

    const separator = lineText ? HINT_SEPARATOR : '';
    if (lineText && visibleWidth(lineText + separator + segment.text) > width) {
      lines.push(line);
      line = '';
      lineText = '';
    }

    if (visibleWidth(segment.text) > width) {
      if (lineText) {
        lines.push(line);
        line = '';
        lineText = '';
      }
      lines.push(truncateToWidth(segment.style(segment.text), width, ''));
      continue;
    }

    if (lineText) {
      line += styleSeparator(separator);
      lineText += separator;
    }
    line += segment.style(segment.text);
    lineText += segment.text;
  }

  if (lineText) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

function modelDisplayName(state: AppState): string {
  const model = state.availableModels[state.model];
  const effective = model === undefined ? undefined : effectiveModelAlias(model);
  return effective?.displayName ?? effective?.model ?? state.model;
}

function hintForState(state: AppState, hasModels: boolean): string {
  if (state.model || state.agentProfile) return BOXED_DISCOVERY_HINT;
  return hasModels ? MODEL_SELECTION_HINT : LOGIN_HINT;
}

export class WelcomeComponent implements Component {
  private readonly state: AppState;
  private readonly startupRows: number;

  constructor(state: AppState, startupRows = BOXED_MIN_STARTUP_ROWS) {
    this.state = state;
    this.startupRows = startupRows;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    const colors = currentTheme.palette;
    const hasModels = Object.keys(this.state.availableModels).length > 0;
    const modelUnset = !this.state.model && !this.state.agentProfile;
    const modelValue = modelDisplayName(this.state) || this.state.agentProfile || MODEL_UNSET_HINT;
    const modelStyle = modelUnset
      ? chalk.hex(colors.warning)
      : chalk.hex(colors.text);

    if (safeWidth < COMPACT_WIDTH || this.startupRows < BOXED_MIN_STARTUP_ROWS) {
      const title = `Kiki ${this.state.version}`;
      let directory = shortenCwd(this.state.workDir);
      const compactSegments = (path: string): StyledSegment[] => [
        { text: ` ${title}`, style: chalk.bold.hex(colors.primary) },
        { text: modelValue, style: modelStyle },
        ...(path ? [{ text: path, style: chalk.hex(colors.textDim) }] : []),
      ];
      const joinedWidth = (segments: readonly StyledSegment[]): number =>
        visibleWidth(segments.map((segment) => segment.text).join(HINT_SEPARATOR));

      if (directory && joinedWidth(compactSegments(directory)) > safeWidth) {
        for (let segmentLimit = 2; segmentLimit >= 1; segmentLimit--) {
          directory = shortenCwd(this.state.workDir, segmentLimit);
          if (joinedWidth(compactSegments(directory)) <= safeWidth) break;
        }
      }
      if (safeWidth <= 2 && directory.startsWith('…/')) directory = '';

      const dim = chalk.hex(colors.textDim);
      const hint = hintForState(this.state, hasModels);
      const hintStyle = modelUnset
        ? chalk.hex(colors.warning)
        : dim;
      const discoverySegments = modelUnset
        ? [{ text: hint, style: hintStyle }]
        : COMPACT_DISCOVERY_HINT.split(HINT_SEPARATOR).map((text) => ({ text, style: hintStyle }));
      const modelLines = wrapSegments(compactSegments(directory), safeWidth, (text) =>
        chalk.hex(colors.textMuted)(text),
      );
      const hintLines = wrapSegments(discoverySegments, safeWidth, (text) =>
        chalk.hex(colors.textMuted)(text),
      );

      return ['', ...modelLines, ...hintLines, ''].map((line) =>
        truncateToWidth(line, safeWidth, ''),
      );
    }

    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';
    const primary = (text: string): string => chalk.hex(colors.primary)(text);
    const dim = chalk.hex(colors.textDim);
    const labelStyle = chalk.bold.hex(colors.textDim);

    const logo = ['▐█▛█▛█▌', '▐█████▌'] as const;
    const logoWidth = Math.max(...logo.map((row) => visibleWidth(row)));
    const gap = '  ';
    const textWidth = Math.max(4, innerWidth - logoWidth - gap.length);
    const rightRow0 = truncateToWidth(
      chalk.bold.hex(colors.primary)('Welcome to Kiki!'),
      textWidth,
      '…',
    );
    const boxedHint = hintForState(this.state, hasModels);
    const hintStyle = modelUnset ? chalk.hex(colors.warning) : dim;
    const hintLines = wrapSegments(
      boxedHint === BOXED_DISCOVERY_HINT
        ? boxedHint.split(HINT_SEPARATOR).map((text) => ({ text, style: hintStyle }))
        : [{ text: boxedHint, style: hintStyle }],
      textWidth,
      (text) => hintStyle(text),
    );

    let renderedHeaderLines = [
      primary(logo[0].padEnd(logoWidth)) + gap + rightRow0,
      primary(logo[1].padEnd(logoWidth)) + gap + (hintLines[0] ?? ''),
      ...hintLines.slice(1).map((line) => ' '.repeat(logoWidth + gap.length) + line),
    ];
    if (isRainbowDancing()) {
      renderedHeaderLines = [
        ...renderDanceWelcomeHeader(logo, textWidth, hintLines[0] ?? ''),
        ...hintLines.slice(1).map((line) => ' '.repeat(logoWidth + gap.length) + line),
      ];
    }

    const infoLines = [labelStyle('Directory: ') + this.state.workDir];
    if (this.state.sessionId) {
      infoLines.push(labelStyle('Session:   ') + this.state.sessionId);
    }
    infoLines.push(
      labelStyle('Model:     ') + modelStyle(modelValue),
      labelStyle('Version:   ') + this.state.version,
    );

    if (this.state.mcpServersSummary) {
      infoLines.push(labelStyle('MCP:       ') + this.state.mcpServersSummary);
    }

    const contentLines: string[] = [...renderedHeaderLines, '', ...infoLines];
    const lines: string[] = [
      '',
      primary('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      primary('│') + ' '.repeat(safeWidth - 2) + primary('│'),
    ];

    for (const content of contentLines) {
      const truncated = truncateToWidth(content, innerWidth, '…');
      const vis = visibleWidth(truncated);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(primary('│') + pad + truncated + ' '.repeat(rightPad) + primary('│'));
    }

    lines.push(primary('│') + ' '.repeat(safeWidth - 2) + primary('│'));
    lines.push(primary('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, ''));
  }
}
