import { z } from 'zod';

import { Error2, ErrorCodes } from '#/errors';

const frameSchema = z.object({
  path: z.string().refine((path) => path === '' || path.split('/').every((part) =>
    part !== '' && part !== '.' && part !== '..' && !part.includes('\u0000'),
  )),
  offset: z.number().int().nonnegative(),
  mtime: z.number().optional(),
  ino: z.number().optional(),
});
const cursorSchema = z.object({
  version: z.literal(2),
  binding: z.string(),
  stack: z.array(frameSchema).min(1),
});

export type SearchFrame = z.infer<typeof frameSchema>;

export function invalidSearchCursor(): Error2 {
  return new Error2(
    ErrorCodes.VALIDATION_FAILED,
    'invalid or changed file search cursor; restart the search',
  );
}

export function readSearchCursor(
  cursor: string | undefined,
  binding: string,
  separator: string,
): SearchFrame[] {
  if (cursor === undefined) return [{ path: '', offset: 0 }];
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (parsed.binding !== binding || parsed.stack[0]!.path !== '') throw invalidSearchCursor();
    for (let i = 1; i < parsed.stack.length; i++) {
      const parent = parsed.stack[i - 1]!.path;
      const child = parsed.stack[i]!.path;
      if (separator === '\\' && /[\\:]/u.test(child)) throw invalidSearchCursor();
      if (child === '' || child.includes('/') || child === '.git') throw invalidSearchCursor();
      parsed.stack[i]!.path = parent === '' ? child : `${parent}/${child}`;
    }
    return parsed.stack;
  } catch {
    throw invalidSearchCursor();
  }
}

export function writeSearchCursor(stack: SearchFrame[], binding: string): string | undefined {
  if (stack.length === 0) return undefined;
  const compact = stack.map((frame) => ({
    ...frame,
    path: frame.path.slice(frame.path.lastIndexOf('/') + 1),
  }));
  return Buffer.from(JSON.stringify({ version: 2, binding, stack: compact })).toString('base64url');
}
