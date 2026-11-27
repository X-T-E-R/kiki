(process as { noAsar?: boolean }).noAsar = true;
process.env['UV_THREADPOOL_SIZE'] ??= '32';
