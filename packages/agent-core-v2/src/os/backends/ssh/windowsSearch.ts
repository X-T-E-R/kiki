import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import { win32 } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import picomatch from 'picomatch';
import type { SSHKaos } from '@kiki/kaos/ssh';
import type { KaosProcess } from '@kiki/kaos';
import type { IHostProcess } from '#/os/interface/hostProcess';
const TYPES: Readonly<Record<string, string>> = {
  ts: '*.{ts,tsx,cts,mts}', js: '*.{js,jsx,cjs,mjs}', json: '*.json', md: '*.{md,markdown}',
  py: '*.py', rust: '*.rs', go: '*.go', c: '*.{c,h}', cpp: '*.{cpp,hpp,cc,hh,cxx,hxx}',
  cs: '*.cs', java: '*.java', html: '*.{html,htm}', css: '*.css', scss: '*.scss',
  xml: '*.{xml,xsd,xsl,svg}', yaml: '*.{yaml,yml}', toml: '*.toml', sh: '*.{sh,bash,zsh}',
  ps: '*.{ps1,psm1,psd1}', txt: '*.txt', log: '*.log', sql: '*.sql', vue: '*.vue', svelte: '*.svelte',
};

interface SearchOptions {
  files: boolean;
  mode: 'files_with_matches' | 'count_matches' | 'content';
  globs: string[];
  paths: string[];
  pattern: string;
  insensitive: boolean;
  multiline: boolean;
  noIgnore: boolean;
  lineNumbers: boolean;
  before: number;
  after: number;
}

function parseArgs(args: readonly string[], cwd: string): SearchOptions {
  const result: SearchOptions = { files: false, mode: 'content', globs: [], paths: [], pattern: '',
    insensitive: false, multiline: false, noIgnore: false, lineNumbers: false, before: 0, after: 0 };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const next = () => {
      const value = args[++index];
      if (value === undefined) throw new Error(`Missing Windows search argument for ${arg}`);
      return value;
    };
    if (arg === '--files') result.files = true;
    else if (arg === '-l') result.mode = 'files_with_matches';
    else if (arg === '--count-matches') result.mode = 'count_matches';
    else if (arg === '-i') result.insensitive = true;
    else if (arg === '-U') result.multiline = true;
    else if (arg === '--no-ignore') result.noIgnore = true;
    else if (arg === '-n') result.lineNumbers = true;
    else if (arg === '--glob') result.globs.push(next());
    else if (arg === '--type') {
      const type = next();
      const glob = TYPES[type];
      if (glob === undefined) throw new Error(`Windows PowerShell search does not support file type ${JSON.stringify(type)}. Use glob instead.`);
      result.globs.push(glob);
    } else if (arg === '-C') result.before = result.after = Number(next());
    else if (arg === '-B') result.before = Number(next());
    else if (arg === '-A') result.after = Number(next());
    else if (arg === '--max-columns' || arg === '--field-context-separator' || arg === '-j') next();
    else if (arg === '--') {
      result.pattern = next();
      result.paths = args.slice(index + 1).map((path) => win32.resolve(cwd, path).replaceAll('\\', '/'));
      break;
    } else if (['--hidden', '--sortr=modified', '--null', '--with-filename', '--multiline-dotall'].includes(arg)) continue;
    else if (!arg.startsWith('-')) result.paths.push(win32.resolve(cwd, arg).replaceAll('\\', '/'));
    else throw new Error(`Unsupported Windows search option: ${arg}`);
  }
  if (result.paths.length === 0) result.paths.push(cwd);
  return result;
}

function enumerationScript(options: SearchOptions): string {
  const filters = options.globs.map((glob) => {
    const pattern = glob.replace(/^!/, '');
    return { exclude: glob.startsWith('!'), basename: !pattern.includes('/'),
      source: picomatch.makeRe(pattern.replace(/^\//, ''), { dot: true }).source };
  });
  const config = Buffer.from(JSON.stringify({ ...options, filters })).toString('base64');
  return `
$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${config}')) | ConvertFrom-Json
$filters=@($c.filters | ForEach-Object { @{ exclude=$_.exclude; basename=$_.basename; regex=[regex]::new($_.source,[Text.RegularExpressions.RegexOptions]::IgnoreCase) } })
function Encode([string]$value) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)) }
function EmitFile($file,[string]$root) {
  $path=$file.FullName.Replace('\\','/')
  $relative=$path.Substring([Math]::Min($path.Length,$root.TrimEnd('/').Length+1))
  foreach ($f in $filters) {
    $target=if ($f.basename) { $file.Name } else { $relative }
    $matches=$f.regex.IsMatch($target) -or $f.regex.IsMatch($path)
    if (($f.exclude -and $matches) -or (!$f.exclude -and !$matches)) { return }
  }
  [Console]::WriteLine('f'+[char]9+$file.LastWriteTimeUtc.Subtract([DateTime]::new(1970,1,1)).TotalMilliseconds+[char]9+(Encode $path))
}
foreach ($root in $c.paths) {
  $item=Get-Item -LiteralPath $root -Force
  if (!$item.PSIsContainer) { EmitFile $item $item.DirectoryName.Replace('\\','/'); continue }
  $pending=New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
  $pending.Push([IO.DirectoryInfo]::new($root))
  while ($pending.Count -gt 0) {
    $directory=$pending.Pop()
    $base=$directory.FullName.Replace('\\','/')
    try {
      if (!$c.noIgnore) {
        foreach ($name in @('.git/info/exclude','.gitignore','.ignore','.rgignore')) {
          $rule=[IO.Path]::Combine($directory.FullName,$name)
          if ([IO.File]::Exists($rule)) { [Console]::WriteLine('i'+[char]9+(Encode $base)+[char]9+(Encode ([IO.File]::ReadAllText($rule)))) }
        }
      }
      foreach ($entry in $directory.EnumerateFileSystemInfos()) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        if (($entry.Attributes -band [IO.FileAttributes]::Directory) -ne 0) {
          if (@('.git','.svn','.hg','.bzr','.jj','.sl') -notcontains $entry.Name) { $pending.Push($entry) }
        } else { EmitFile $entry $root }
      }
    } catch { [Console]::WriteLine('e'+[char]9+(Encode $base)+[char]9+(Encode $_.ToString())) }
  }
}
`;
}

async function enumerate(ssh: SSHKaos, options: SearchOptions, signal: AbortSignal,
  found: { path: string; mtimeMs: number }[], setProcess: (process: KaosProcess) => void): Promise<void> {
  const process = await ssh.execPowerShell(enumerationScript(options));
  setProcess(process);
  process.stdin.end();
  const rules = new Map<string, Ignore>();
  const ignored = (path: string) => {
    let result = false;
    const scopes = [...rules].filter(([base]) => path.toLowerCase().startsWith(`${base.toLowerCase()}/`))
      .toSorted(([a], [b]) => a.length - b.length);
    for (const [base, rule] of scopes) {
      const relative = path.slice(base.length + 1);
      if (relative === '') continue;
      const match = rule.test(relative);
      if (match.ignored) result = true;
      else if (match.unignored) result = false;
    }
    return result;
  };
  let diagnostics = '';
  const errors = (async () => { for await (const chunk of process.stderr) diagnostics += String(chunk); })();
  void errors.catch(() => {});
  let pending = '';
  try {
    for await (const chunk of process.stdout) {
      signal.throwIfAborted();
      pending += String(chunk);
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const [kind, first, second] = pending.slice(0, newline).replace(/\r$/, '').split('\t');
        pending = pending.slice(newline + 1);
        if (!first || second === undefined || !['i', 'f', 'e'].includes(kind!)) throw new Error('Windows search returned an invalid enumeration record');
        if (kind === 'i') {
          const base = Buffer.from(first, 'base64').toString('utf8').replace(/\/$/, '');
          if (ignored(`${base}/`)) continue;
          const rule = rules.get(base) ?? ignore();
          rule.add(Buffer.from(second, 'base64').toString('utf8')); rules.set(base, rule);
        } else {
          const path = Buffer.from(kind === 'f' ? second : first, 'base64').toString('utf8');
          if (ignored(kind === 'e' ? `${path}/` : path)) continue;
          if (kind === 'e') throw new Error(`Windows search could not read ${path}: ${Buffer.from(second, 'base64').toString('utf8')}`);
          found.push({ path, mtimeMs: Number(first) });
        }
      }
    }
    await errors;
    const code = await process.wait();
    if (code !== 0 || diagnostics.trim() !== '') throw new Error(`Windows search enumeration failed (exit ${code}): ${diagnostics.trim()}`);
    if (pending.trim() !== '') throw new Error('Windows search enumeration ended with an incomplete record');
  } finally { await process.dispose(); }
}

function grepScript(options: SearchOptions, files: readonly { path: string }[]): string {
  const config = Buffer.from(JSON.stringify({ ...options, paths: files.map((file) => file.path) })).toString('base64');
  return `
$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${config}')) | ConvertFrom-Json
$flags=[Text.RegularExpressions.RegexOptions]::None
if ($c.insensitive) { $flags=$flags -bor [Text.RegularExpressions.RegexOptions]::IgnoreCase }
if ($c.multiline) { $flags=$flags -bor [Text.RegularExpressions.RegexOptions]::Singleline }
$regex=[Text.RegularExpressions.Regex]::new($c.pattern,$flags,[TimeSpan]::FromSeconds(2))
$matched=$false
foreach ($path in $c.paths) {
  $stream=[IO.File]::OpenRead($path)
  try {
    $sample=New-Object byte[] 8192
    $size=$stream.Read($sample,0,$sample.Length)
    if ([Array]::IndexOf($sample,[byte]0,0,$size) -ge 0) { continue }
    if ($stream.Length -gt 134217728) { throw "Windows search cannot read a text file larger than 128 MiB: $path. Narrow the path or glob." }
  } finally { $stream.Dispose() }
  $text=[IO.File]::ReadAllText($path)
  $lines=[regex]::Split($text,'\\r\\n|\\n|\\r')
  if ($text.Length -eq 0) { $lines=@() } elseif ($lines.Length -gt 1 -and $lines[-1] -eq '') { $lines=$lines[0..($lines.Length-2)] }
  $hits=New-Object 'System.Collections.Generic.HashSet[int]'
  $count=0
  if ($c.multiline) {
    foreach ($m in $regex.Matches($text)) {
      $count++
      $first=([regex]::Matches($text.Substring(0,$m.Index),'\\r\\n|\\n|\\r')).Count
      $last=$first+([regex]::Matches($m.Value.TrimEnd([char]10,[char]13),'\\r\\n|\\n|\\r')).Count
      for ($i=$first; $i -le $last; $i++) { [void]$hits.Add($i) }
    }
  } else {
    for ($i=0; $i -lt $lines.Length; $i++) {
      $n=$regex.Matches($lines[$i]).Count
      if ($n -gt 0) { $count+=$n; [void]$hits.Add($i) }
    }
  }
  if ($count -eq 0) { continue }
  $matched=$true
  if ($c.mode -eq 'files_with_matches') { [Console]::Write($path+[char]0); continue }
  if ($c.mode -eq 'count_matches') { [Console]::Write($path+[char]0+$count+[char]10); continue }
  $shown=New-Object 'System.Collections.Generic.SortedSet[int]'
  foreach ($hit in $hits) {
    for ($i=[Math]::Max(0,$hit-$c.before); $i -le [Math]::Min($lines.Length-1,$hit+$c.after); $i++) { [void]$shown.Add($i) }
  }
  $previous=-1
  foreach ($i in $shown) {
    if ($previous -ge 0 -and $i -gt $previous+1) { [Console]::WriteLine('--') }
    $separator=if ($hits.Contains($i)) { ':' } else { '-' }
    $payload=if ($c.lineNumbers) { [string]($i+1)+$separator+$lines[$i] } else { $lines[$i] }
    [Console]::Write($path+[char]0+$payload+[char]10)
    $previous=$i
  }
}
if (!$matched) { exit 1 }
`;
}

async function write(stream: NodeJS.WritableStream, data: string | Buffer): Promise<void> {
  if (!stream.write(data)) await once(stream, 'drain');
}

export function spawnWindowsSearch(ssh: SSHKaos, args: readonly string[]): IHostProcess {
  const options = parseArgs(args, ssh.getcwd());
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({ write: (_chunk, _encoding, done) => { done(); } });
  const controller = new AbortController();
  let remote: KaosProcess | undefined;
  let exitCode: number | null = null;
  let settle!: (code: number) => void;
  const wait = new Promise<number>((resolve) => { settle = resolve; });
  const finish = (code: number) => {
    if (exitCode !== null) return;
    exitCode = code;
    stdout.end(); stderr.end(); settle(code);
  };
  const files: { path: string; mtimeMs: number }[] = [];
  let emitting = false;
  const emitFiles = async (partial = false): Promise<void> => {
    emitting = true;
    files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
    for (const file of files) {
      if (!partial) controller.signal.throwIfAborted();
      await write(stdout, `${file.path}\n`);
    }
  };
  void (async () => {
    try {
      await enumerate(ssh, options, controller.signal, files, (process) => { remote = process; });
      controller.signal.throwIfAborted();
      if (options.files) {
        await emitFiles();
        finish(files.length > 0 ? 0 : 1);
        return;
      }
      remote = await ssh.execPowerShell(grepScript(options, files));
      remote.stdin.end();
      const copy = async (source: NodeJS.ReadableStream, target: PassThrough) => {
        for await (const chunk of source) await write(target, chunk as Buffer);
      };
      await Promise.all([copy(remote.stdout, stdout), copy(remote.stderr, stderr)]);
      finish(await remote.wait());
    } catch (error) {
      if (!controller.signal.aborted) { stderr.write(error instanceof Error ? error.message : String(error)); finish(2); }
    } finally { await Promise.resolve(remote?.dispose()).catch(() => {}); }
  })();
  return {
    _serviceBrand: undefined, pid: -1, stdin, stdout, stderr,
    get exitCode() { return exitCode; }, wait: () => wait,
    kill: async (signal) => {
      controller.abort();
      try { if (options.files && !emitting) await emitFiles(true); }
      finally {
        finish(143);
        try { await remote?.kill(signal); } finally { await remote?.dispose(); }
      }
    },
    dispose: async () => {
      controller.abort(); finish(143);
      try { await remote?.dispose(); } finally { stdin.destroy(); stdout.destroy(); stderr.destroy(); }
    },
  };
}
