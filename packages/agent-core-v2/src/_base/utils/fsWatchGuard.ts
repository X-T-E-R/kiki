import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import {
  installNativeFsWatchErrorGuard,
  isNativeFsWatchErrorGuardInstalled,
  setNativeFsWatchErrorReporter,
} from '#/_base/utils/nativeFsWatchErrorGuard';

installNativeFsWatchErrorGuard();
setNativeFsWatchErrorReporter(onUnexpectedError);

export { installNativeFsWatchErrorGuard, isNativeFsWatchErrorGuardInstalled };
