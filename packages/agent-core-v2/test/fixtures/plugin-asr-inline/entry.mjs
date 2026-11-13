export function register(api) {
  api.registerAsrProvider({ id: 'inline', label: 'Inline speech', connectionSetting: 'connectionId' }, {
    async transcribe(input, context) {
      const connection = await context.connection();
      return { text: `${input.wavPath}:${connection?.id ?? 'none'}` };
    },
  });
}
