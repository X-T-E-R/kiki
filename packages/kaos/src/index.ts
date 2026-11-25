export type { StatResult } from './types';
export type { KaosProcess } from './process';
export type { Kaos } from './kaos';
export type {
  Environment,
  EnvironmentDeps,
  OsKind,
  PathClass,
  ShellName,
} from './environment';
export { detectEnvironment, detectEnvironmentFromNode } from './environment';
export type {
  ShellPathBridge,
  ShellPathBridgeDeps,
  ShellPathBridgeEnv,
} from './shell-path-bridge';
export { createShellPathBridge, getShellPathBridge, translateShellDrivePath } from './shell-path-bridge';
export {
  KaosError,
  KaosValueError,
  KaosFileExistsError,
  KaosShellNotFoundError,
} from './errors';
export {
  ATOMIC_TEMP_READY_SUFFIX,
  AtomicWriteChmodError,
  atomicCreate,
  atomicWrite,
  atomicWriteStream,
  atomicWriteSync,
  registerWin32MoveFileReplace,
  replaceFileNonDestructive,
  syncDir,
  syncDirSync,
  writeFileAtomicDurable,
  type Win32MoveFileReplace,
} from './atomic-fs';
export { LocalKaos } from './local';
export {
  chdir,
  exec,
  execWithEnv,
  getCurrentKaos,
  getcwd,
  gethome,
  glob,
  iterdir,
  mkdir,
  normpath,
  pathClass,
  readBytes,
  readLines,
  readText,
  runWithKaos,
  setCurrentKaos,
  stat,
  writeBytes,
  writeText,
} from './current';
