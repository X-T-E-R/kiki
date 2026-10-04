export const definition = {
  schemaVersion: 1,
  name: 'documents_extract',
  description: 'Extract one local PDF, Office, HTML or text document into a NEW output directory using nb-extract. Returns Markdown/asset paths, source, engine, warnings and a bounded preview; use Read/Grep on document.md. Auto is local and never does OCR or uploads. Empty content fails; local scans without a text layer need explicit OCR. MinerU explicitly uploads and requires allowUpload=true. Never overwrites source or outputs.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Workspace-relative file or explicitly approved absolute path.' },
      outputDir: { type: 'string', description: 'New workspace-relative or explicitly approved output directory. Must not exist.' },
      engine: { type: 'string', enum: ['auto', 'direct', 'defuddle', 'markitdown', 'mineru'], default: 'auto' },
      allowUpload: { type: 'boolean', description: 'Only set true when the user explicitly authorized sending this file to MinerU; required with engine=mineru.' },
      previewChars: { type: 'integer', minimum: 0, maximum: 16000, default: 4000 },
    },
    required: ['file', 'outputDir'],
    additionalProperties: false,
  },
  accesses: [
    { kind: 'file', operation: 'read', path: '$.file' },
    { kind: 'file', operation: 'write', path: '$.outputDir' },
    { kind: 'all' },
  ],
  disclosure: 'deferred',
};
