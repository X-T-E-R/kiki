const OLD_NAMES = {
  Cron: ['CronCreate', 'CronList', 'CronDelete'],
  Goal: ['CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal'],
} as const;

export function legacyToolNames(name: string): readonly string[] {
  return OLD_NAMES[name as keyof typeof OLD_NAMES] ?? [];
}

export function canonicalToolName(name: string): string | undefined {
  for (const [canonical, aliases] of Object.entries(OLD_NAMES)) {
    if ((aliases as readonly string[]).includes(name)) return canonical;
  }
  return undefined;
}

export function isLegacyToolName(name: string): boolean {
  return canonicalToolName(name) !== undefined;
}
