let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const mode = process.argv[2] ?? 'success';
if (mode === 'wait') {
  setInterval(() => {}, 1000);
} else if (mode === 'nonzero') {
  process.stderr.write('PRIVATE_STDERR_SENTINEL');
  process.exitCode = 2;
} else if (mode === 'large') {
  process.stdout.write('x'.repeat(20_000));
} else if (mode === 'large-stderr') {
  process.stderr.write('x'.repeat(20_000));
} else if (mode === 'invalid') {
  process.stdout.write('{"schema_version":"invalid","content":"PRIVATE_STDOUT_SENTINEL"}');
} else if (request.schema_version === 'kiki.usage.test.v1') {
  process.stdout.write(JSON.stringify({ schema_version: 'kiki.usage.test-receipt.v1', nonce: request.nonce, ready: true }));
} else {
  let items = request.items.map(({ stream_id, bucket_id, revision, payload_hash }) => ({ stream_id, bucket_id, revision, payload_hash, status: 'applied' }));
  if (mode === 'partial') items = [];
  if (mode === 'duplicate') items.push(items[0]);
  if (mode === 'conflict') items[0].status = 'conflict';
  if (mode === 'stale') items[0].status = 'stale';
  if (mode === 'identity') items[0].payload_hash = 'b'.repeat(64);
  process.stdout.write(JSON.stringify({ schema_version: 'kiki.usage.receipt.v1', batch_id: request.batch_id, items }));
}
