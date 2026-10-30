import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImSessionSnapshot } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { extractConflictDetails, isIdentityAlreadyBoundError } from '../../im/channelTypes';
import { IM_KEY } from './imModel';

/** The two-way chat snapshot, the target catalog and the bot setup catalog. */
export function useImData() {
  const { client } = useConnection();
  const snapshot = useQuery({
    queryKey: IM_KEY,
    queryFn: () => client.imSessions.snapshot(),
    placeholderData: (previous) => previous,
    refetchInterval: (query) => query.state.data?.instances.some((item) => item.listening) === true ? 2_000 : false,
  });
  const catalog = useQuery({
    queryKey: [...IM_KEY, 'catalog'],
    queryFn: () => client.imSessions.catalog(),
    enabled: snapshot.data !== undefined,
  });
  const setupCatalog = useQuery({
    queryKey: [...IM_KEY, 'setup-catalog'],
    queryFn: () => client.imSessions.setupCatalog(),
    enabled: snapshot.data !== undefined && typeof client.imSessions.setupCatalog === 'function',
    staleTime: 60_000,
  });
  return { snapshot, catalog, setupCatalog };
}

/** One write against the IM snapshot: the echo lands in the cache, failures become local copy. */
export function useImAction() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (work: () => Promise<ImSessionSnapshot | void>): Promise<boolean> => {
    setSaving(true);
    setError(undefined);
    try {
      const next = await work();
      if (next !== undefined) queryClient.setQueryData(IM_KEY, next);
      return true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '';
      if (isIdentityAlreadyBoundError(caught)) {
        const details = extractConflictDetails(caught);
        setError(details?.previous_session_id
          ? `${t('st.im.rebind.title')}: ${t('st.im.occupiedBy')} ${details.previous_session_title ?? details.previous_session_id}`
          : t('st.im.error'));
      } else if (message.includes('unsupported_wechat_group')) {
        setError(t('st.im.wechatDirectOnly'));
      } else if (message.includes('topic_scope_unavailable')) {
        setError(t('st.im.error.topicScopeUnavailable'));
      } else if (message.includes('group_binding_scope_required')) {
        setError(t('st.im.error.groupBindingScopeRequired'));
      } else if (message.includes('direction_unsupported') || message.includes('input_unsupported') || message.includes('output_unsupported')) {
        setError(t('st.im.error.directionUnsupported'));
      } else {
        setError(imErrorText(t, message));
      }
      return false;
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, run, clear: () => { setError(undefined); } };
}

/** Known server and check codes in the person's words; anything else stays as sent. */
export function imErrorText(t: ReturnType<typeof useI18n>['t'], message: string): string {
  if (message === '' ) return t('st.im.error');
  if (message === 'missing') return t('st.channels.error.missing');
  if (message === 'unauthorized') return t('st.channels.error.unauthorized');
  if (message === 'setup_failed') return t('st.channels.error.setupFailed');
  return message;
}

/** Check the credential, then start listening; a refused check stops before listening. */
export function useStartListening() {
  const { t } = useI18n();
  const { client } = useConnection();
  return useCallback(async (id: string) => {
    const checked = await client.imSessions.check(id);
    if (!checked.ok) throw new Error(checked.conflict === 'webhook' ? t('st.im.webhook') : imErrorText(t, checked.detail ?? ''));
    return client.imSessions.listen(id, true);
  }, [client, t]);
}

export type WechatQr = ReturnType<typeof useWechatQr>;

/**
 * One WeChat QR attempt, held above the add panel so closing the panel does
 * not cancel a scan in progress. Each confirmed scan is a new account; once
 * the server names it, it is checked and starts listening.
 */
export function useWechatQr(onConfirmed: (instanceId: string | undefined) => void) {
  const { t } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const [loginId, setLoginId] = useState<string>();
  const [image, setImage] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [verifyCode, setVerifyCode] = useState('');
  const [error, setError] = useState<string>();
  const [requesting, setRequesting] = useState(false);
  const polling = loginId !== undefined && (status === undefined || status === 'wait' || status === 'scaned' || status === 'scaned_but_redirect');

  const settle = useCallback((result: { status: string; provider_instance_id?: string }) => {
    setStatus(result.status);
    if (result.status === 'confirmed') {
      setLoginId(undefined);
      void queryClient.invalidateQueries({ queryKey: IM_KEY });
      onConfirmed(result.provider_instance_id);
    }
  }, [onConfirmed, queryClient]);

  useEffect(() => {
    if (!polling || loginId === undefined) return;
    let stop = false;
    const tick = () => {
      void client.imSessions.pollWechatQr(loginId).then((result) => { if (!stop) settle(result); }).catch((caught: unknown) => {
        if (stop) return;
        const message = caught instanceof Error ? caught.message : '';
        if (message === 'wechat_login_cancelled' || message === 'unknown_login') return;
        setError(message.length > 0 ? message : t('st.im.error'));
      });
    };
    const timer = setInterval(tick, 1500);
    return () => { stop = true; clearInterval(timer); };
  }, [client, loginId, polling, settle, t]);

  const start = useCallback(() => {
    setError(undefined);
    setVerifyCode('');
    setImage(undefined);
    setStatus(undefined);
    setRequesting(true);
    void client.imSessions.startWechatQr().then((started) => {
      setLoginId(started.login_id);
      setImage(started.image);
      setStatus('wait');
    }).catch(() => {
      setError(t('st.channels.wechat.startFailed'));
    }).finally(() => { setRequesting(false); });
  }, [client, t]);

  const cancel = () => {
    const id = loginId;
    setLoginId(undefined);
    setImage(undefined);
    setStatus('cancelled');
    if (id !== undefined) void client.imSessions.cancelWechatQr(id);
  };

  const submitCode = () => {
    if (loginId === undefined) return;
    void client.imSessions.pollWechatQr(loginId, verifyCode.trim()).then(settle).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : t('st.im.error'));
    });
  };

  /** Forget a finished attempt so the next visit asks for a fresh code; a live one keeps polling. */
  const reset = useCallback(() => {
    if (loginId !== undefined) return;
    setStatus(undefined); setImage(undefined); setError(undefined);
  }, [loginId]);

  return { loginId, image, status, verifyCode, error, requesting, active: loginId !== undefined, setVerifyCode, start, cancel, submitCode, reset };
}
