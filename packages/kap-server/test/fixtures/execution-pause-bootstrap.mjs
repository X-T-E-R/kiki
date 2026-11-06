process.send?.({ type: 'phase', phase: 'imports', pid: process.pid });
await import('@kiki/agent-core-v2');
process.send?.({ type: 'phase', phase: 'server.import', pid: process.pid });
await import('./execution-pause-server.ts');
