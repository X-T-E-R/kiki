export function isGeminiModel(model: string): boolean {
  return /(^|\/)gemini[-_0-9.]/iu.test(model);
}
