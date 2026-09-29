import { describe, expect, it } from 'vitest';

import type { PermissionRule } from '#/agent/permissionRules/permissionRules';
import {
  matchPermissionRule,
  parsePattern,
} from '#/agent/permissionRules/matchesRule';
import type { PermissionRuleMatchExecution } from '#/agent/permissionRules/matchesRule';
import {
  matchesGlobRuleSubject,
  matchesPathRuleSubject,
  matchesStringRuleSubject,
} from '#/tool/rule-match';
import { matchBashPattern, matchesBashRuleSubject } from '#/tool/bash-rule-match';

function rule(pattern: string): PermissionRule {
  return { decision: 'allow', scope: 'user', pattern };
}

const noArgs: PermissionRuleMatchExecution = {};
const matchAll: PermissionRuleMatchExecution = {
  matchesRule: () => true,
};
const matchNone: PermissionRuleMatchExecution = {
  matchesRule: () => false,
};

describe('permissionRules/parsePattern', () => {
  it('parses a bare tool name', () => {
    expect(parsePattern('bash')).toEqual({ toolName: 'bash' });
  });

  it('trims whitespace', () => {
    expect(parsePattern('  read  ')).toEqual({ toolName: 'read' });
  });

  it('parses tool(args)', () => {
    expect(parsePattern('bash(src/**)')).toEqual({
      toolName: 'bash',
      argPattern: 'src/**',
    });
  });

  it('treats empty parens as tool-name-only', () => {
    expect(parsePattern('bash()')).toEqual({ toolName: 'bash' });
  });

  it('throws on empty string', () => {
    expect(() => parsePattern('')).toThrow(/empty/);
  });

  it('throws on missing closing paren', () => {
    expect(() => parsePattern('bash(src')).toThrow(/missing closing paren/);
  });

  it('throws on empty tool name', () => {
    expect(() => parsePattern('(src)')).toThrow(/empty tool name/);
  });
});

describe('permissionRules/matchPermissionRule', () => {
  it('matches by tool name only when pattern has no args', () => {
    expect(matchPermissionRule({ rule: rule('bash'), toolName: 'bash', execution: noArgs }))
      .toMatchObject({ strategy: 'tool_name_only', hasRuleArgs: false });
  });

  it('returns undefined when tool name does not match', () => {
    expect(
      matchPermissionRule({ rule: rule('bash'), toolName: 'read', execution: noArgs }),
    ).toBeUndefined();
  });

  it('supports glob tool patterns', () => {
    expect(
      matchPermissionRule({ rule: rule('mcp__*'), toolName: 'mcp__search', execution: noArgs }),
    ).toMatchObject({ strategy: 'tool_name_only' });
  });

  it('delegates arg matching to execution.matchesRule', () => {
    expect(
      matchPermissionRule({
        rule: rule('bash(src/**)'),
        toolName: 'bash',
        execution: matchAll,
      }),
    ).toMatchObject({ strategy: 'matches_rule', hasRuleArgs: true });

    expect(
      matchPermissionRule({
        rule: rule('bash(src/**)'),
        toolName: 'bash',
        execution: matchNone,
      }),
    ).toBeUndefined();
  });

  it('returns undefined for an unparseable rule pattern', () => {
    expect(
      matchPermissionRule({ rule: rule('('), toolName: 'bash', execution: noArgs }),
    ).toBeUndefined();
  });

  it('matches rules against tool-specific argument fields through execution matchers', () => {
    expect(matches(rule('Bash(git *)'), 'Bash', {
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'git status'),
    })).toBe(true);
    expect(matches(rule('Bash(git *)'), 'Bash', {
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'npm test'),
    })).toBe(false);
    expect(matches(rule('Read(/etc/**)'), 'Read', {
      matchesRule: (ruleArgs) => matchesPathRuleSubject(ruleArgs, '/etc/passwd'),
    })).toBe(true);
    expect(matches(rule('Edit(!./src/**)'), 'Edit', {
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, '/workspace/README.md', {
          cwd: '/workspace',
          pathClass: 'posix',
        }),
    })).toBe(true);
    expect(matches(rule('Edit(!./src/**)'), 'Edit', {
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, '/workspace/src/a.ts', {
          cwd: '/workspace',
          pathClass: 'posix',
        }),
    })).toBe(false);
    expect(matches(rule('AgentRun(review-*)'), 'AgentRun', {
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'review-code'),
    })).toBe(true);
    expect(matches(rule('mcp__github__*'), 'mcp__github__list_issues', noArgs)).toBe(true);
    expect(matches(rule('Bash(git *)'), 'Bash', {
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, '42'),
    })).toBe(false);
    expect(matches(rule('Bad(unclosed'), 'Bad', noArgs)).toBe(false);
  });

  it('separates SSH host-qualified approvals from local rules', () => {
    const remote = { approvalRule: 'Read@dev(/home/tester/file.txt)', matchesRule: (pattern: string) => matchesPathRuleSubject(pattern, '/home/tester/file.txt') };
    for (const localRule of ['*', 'Read', 'Read(*)', 'Read(/home/**)']) {
      expect(matches(rule(localRule), 'Read', remote)).toBe(false);
    }
    expect(matches(rule('Read@dev'), 'Read', remote)).toBe(true);
    expect(matches(rule('Read@dev(/home/**)'), 'Read', remote)).toBe(true);
    expect(matches(rule('Read@prod(/home/**)'), 'Read', remote)).toBe(false);
    expect(matches(rule('Read@dev(/etc/**)'), 'Read', remote)).toBe(false);
    expect(matches(rule('Read@dev'), 'Read', { approvalRule: 'Read(/home/tester/file.txt)' })).toBe(false);
  });

  it('keeps legacy Cron and Goal approval rules scoped to their original actions', () => {
    const create = { approvalRule: 'CronCreate({"cron":"0 9 * * *"})' };
    expect(matches(rule('CronCreate'), 'Cron', create)).toBe(true);
    expect(matches(rule('CronDelete'), 'Cron', create)).toBe(false);
    expect(matches(rule(create.approvalRule), 'Cron', create)).toBe(true);
    expect(matches(rule('CreateGoal'), 'Goal', { approvalRule: 'CreateGoal' })).toBe(true);
    expect(matches(rule('UpdateGoal'), 'Goal', { approvalRule: 'CreateGoal' })).toBe(false);
    expect(matches(rule('Goal(create)'), 'Goal', {
      approvalRule: 'CreateGoal', matchesRule: (value) => value === 'create',
    })).toBe(true);
  });

  it('does not match rule arguments without an execution matcher', () => {
    expect(matches(rule('Custom("query":"a.b")'), 'Custom', noArgs)).toBe(false);
    expect(matches(rule('Bash("command":"git status")'), 'Bash', noArgs)).toBe(false);
    expect(matches(rule('Bash(^git status$)'), 'Bash', noArgs)).toBe(false);
    expect(matches(rule('Bash(arena $(cat k)'), 'Bash', {
      approvalRule: 'Bash(arena $(cat k)',
      matchesRule: () => false,
    })).toBe(false);
    expect(matches(rule('Read([invalid'), 'Read', noArgs)).toBe(false);
    expect(matches(rule('AgentSwarm(swarm)'), 'AgentSwarm', noArgs)).toBe(false);
  });

  it('matches path rule subjects case-insensitively', () => {
    expect(matches(rule('Edit(/repo/secrets.env)'), 'Edit', {
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, '/repo/Secrets.env', {
          cwd: '/repo',
          pathClass: 'posix',
        }),
    })).toBe(true);
    expect(matches(rule('Edit(/repo/Sub/**)'), 'Edit', {
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, '/repo/sub/a.ts', {
          cwd: '/repo',
          pathClass: 'posix',
        }),
    })).toBe(true);
  });
});

describe('tool/rule-match string subjects', () => {
  it('matches non-path subjects without path or extglob semantics', () => {
    expect(matchesStringRuleSubject('https://example.com/*', 'https://example.com/a/b')).toBe(true);
    expect(matchesStringRuleSubject('task-*', 'task-.hidden')).toBe(true);
    expect(matchesStringRuleSubject('name[ab]', 'name[ab]')).toBe(true);
    expect(matchesStringRuleSubject('name[ab]', 'namea')).toBe(false);
    expect(matchesStringRuleSubject('name\\*', 'name*')).toBe(true);
  });
});

describe('tool/bash-rule-match', () => {
  it('uses only anchored star and question wildcards', () => {
    expect(matchBashPattern('arena*', 'arena status')).toBe(true);
    expect(matchBashPattern('arena*', 'arena/status')).toBe(true);
    expect(matchBashPattern('arena*', 'xarena status')).toBe(false);
    expect(matchBashPattern('arena ?', 'arena x')).toBe(true);
    expect(matchBashPattern('arena ?', 'arena xx')).toBe(false);
    expect(matchBashPattern('arena[?]', 'arena[?]')).toBe(true);
    expect(matchBashPattern('arena[?]', 'arena?')).toBe(false);
  });

  it('supports escapes for wildcard characters and backslashes', () => {
    const slash = '\\';
    expect(matchBashPattern(`arena ${slash}*`, 'arena *')).toBe(true);
    expect(matchBashPattern(`arena ${slash}?`, 'arena ?')).toBe(true);
    expect(matchBashPattern(`arena ${slash}${slash}`, `arena ${slash}`)).toBe(true);
    expect(matchBashPattern(`arena ${slash}*`, 'arena status')).toBe(false);
  });

  it.each([
    ['arena status;ls', 'semicolon'],
    ['arena status && cat x', 'and list'],
    ['arena status || cat x', 'or list'],
    ['arena status | tee', 'pipeline'],
    ['arena status\nls', 'newline'],
    ['arena $(cat k)', 'dollar substitution'],
    ['arena `cat k`', 'backtick substitution'],
  ])('requires every command segment to match an allow pattern: $1 ($2)', (command) => {
    expect(matchesBashRuleSubject('arena*', command, 'all')).toBe(false);
  });

  it('matches ordinary command arguments including slash and dot-file text', () => {
    expect(matchesBashRuleSubject('arena *', 'arena ../state/.engine_key', 'all')).toBe(true);
    expect(matchesBashRuleSubject('arena*', 'arena ../state/.engine_key', 'all')).toBe(true);
  });

  it('lets deny and ask patterns match the raw composite command or one segment', () => {
    expect(matchesBashRuleSubject('*;*', 'arena status; ls ../state', 'any')).toBe(true);
    expect(matchesBashRuleSubject('*&&*', 'arena status && cat x', 'any')).toBe(true);
    expect(matchesBashRuleSubject('*|*', 'arena status | tee', 'any')).toBe(true);
    expect(matchesBashRuleSubject('*$(*)', 'arena $(cat k)', 'any')).toBe(true);
    expect(matchesBashRuleSubject('*`*`', 'arena `cat k`', 'any')).toBe(true);
    expect(matchesBashRuleSubject('cat *', 'arena $(cat k)', 'any')).toBe(true);
  });

  it('does not allow a parser failure to satisfy an allow pattern', () => {
    expect(matchesBashRuleSubject('arena*', 'arena $(cat k', 'all')).toBe(false);
    expect(matchesBashRuleSubject('*$(*)', 'arena $(cat k', 'any')).toBe(false);
  });
});

function matches(
  permissionRule: PermissionRule,
  toolName: string,
  execution: PermissionRuleMatchExecution,
): boolean {
  return matchPermissionRule({ rule: permissionRule, toolName, execution }) !== undefined;
}
