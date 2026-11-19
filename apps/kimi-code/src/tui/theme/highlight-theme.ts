/**
 * Shared highlight.js theme for code previews (Write/Edit tool calls,
 * approval panels) and markdown code blocks.
 *
 * Every styled token routes through `currentTheme` semantic palette tokens so
 * theme switches take effect immediately and no raw chalk named colors appear.
 * `string` and `regexp` remain plain so highlighted code contains no red, and
 * diff `addition`/`deletion` map to the palette's diff colors.
 */

import { currentTheme } from './theme';

export type CodeHighlightStyler = (code: string) => string;

export type CodeHighlightTheme = Readonly<Record<string, CodeHighlightStyler>>;

const plain: CodeHighlightStyler = (code) => code;

export const codeHighlightTheme: CodeHighlightTheme = {
  keyword: (code) => currentTheme.fg('primary', code),
  built_in: (code) => currentTheme.fg('accent', code),
  type: (code) => currentTheme.fg('accent', code),
  literal: (code) => currentTheme.fg('warning', code),
  number: (code) => currentTheme.fg('warning', code),
  regexp: plain,
  string: plain,
  subst: plain,
  symbol: (code) => currentTheme.fg('primary', code),
  title: (code) => currentTheme.fg('accent', code),
  section: (code) => currentTheme.boldFg('primary', code),
  comment: (code) => currentTheme.dimFg('textDim', code),
  doctag: (code) => currentTheme.dimFg('textDim', code),
  meta: (code) => currentTheme.dimFg('textDim', code),
  attr: (code) => currentTheme.fg('textStrong', code),
  attribute: (code) => currentTheme.fg('textStrong', code),
  property: (code) => currentTheme.fg('textStrong', code),
  variable: (code) => currentTheme.fg('textStrong', code),
  name: (code) => currentTheme.fg('primary', code),
  tag: (code) => currentTheme.fg('textDim', code),
  selector: (code) => currentTheme.fg('primary', code),
  bullet: (code) => currentTheme.fg('primary', code),
  link: (code) => currentTheme.underlineFg('primary', code),
  emphasis: (code) => currentTheme.italic(code),
  strong: (code) => currentTheme.bold(code),
  addition: (code) => currentTheme.fg('diffAdded', code),
  deletion: (code) => currentTheme.fg('diffRemoved', code),
};
