const speech = { id: 'speech', label: 'Speech', description: 'Fixture speech recognition', connectionSetting: 'connectionId' };
export function register(api) {
  api.registerAsrProvider(speech, {
    async transcribe(input, context) {
      const connection = await context.connection();
      context.signal.throwIfAborted();
      if (input.language === 'wait') await new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return { text: `${input.mediaType}:${input.language ?? 'auto'}:${input.wavPath}:${input.originalPath ?? ''}:${context.settings.providerToken ?? ''}:${connection?.id ?? 'none'}`, language: input.language === 'wait' ? undefined : input.language ?? 'en' };
    },
  });
  api.registerAsrProvider('alternate', {
    async transcribe(input) { return { text: `alternate:${input.wavPath}` }; },
  });
}
