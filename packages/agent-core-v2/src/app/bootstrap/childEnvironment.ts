export function kikiChildDefaults(homeDir: string | undefined): Readonly<Record<string, string>> {
  return homeDir === undefined ? {} : { KIKI_HOME: homeDir };
}
