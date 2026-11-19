export interface HljsRuntime {
  getLanguage(languageName: string): unknown;
  highlight(
    code: string,
    options: { readonly language: string; readonly ignoreIllegals?: boolean },
  ): { readonly value: string };
}

export const hljs: HljsRuntime;
