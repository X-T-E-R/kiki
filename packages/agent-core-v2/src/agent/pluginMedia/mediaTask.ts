import type { IPluginMediaService } from '#/app/pluginMedia/pluginMedia';
import type { AgentTask } from '#/agent/task/types';

export function mediaTask(media: IPluginMediaService, jobId: string): AgentTask {
  return {
    idPrefix: 'media', kind: 'media', description: `Media generation ${jobId}`,
    async start(sink) {
      const job = await media.run(jobId, (update) => sink.appendOutput(`${update.text ?? update.kind}${update.percent === undefined ? '' : ` (${update.percent}%)`}\n`));
      sink.setFinalOutput?.(JSON.stringify({ type: 'media_generation', job }));
      await sink.settle({ status: job.state === 'stopped' ? 'killed' : job.state === 'succeeded' || job.state === 'partial' ? 'completed' : 'failed', stopReason: job.cancellation?.message ?? job.error?.message });
    },
    async forceStop() { await media.stopLocal(jobId); },
    toInfo(base) { return { ...base, kind: 'media', jobId }; },
  };
}
