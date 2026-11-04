process.send?.({ type: 'phase', phase: 'imports', pid: process.pid });
await import('./execution-pause-server.ts');
