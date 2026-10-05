import React, { ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import styled from 'styled-components';
import { Account, Document, isLedgerAccount, isSessionAccount } from 'adena-module';

import { GNO_ADDRESS_PREFIX as GNO_PREFIX } from '@common/constants/chain.constant';
import { decodeParameter, parseParameters } from '@common/utils/client-utils';
import {
  resolveSessionAdminGasFee,
  SESSION_ADMIN_GAS_WANTED_FALLBACK,
} from '@common/utils/session-admin-gas';
import { BottomFixedButtonGroup } from '@components/molecules/bottom-fixed-button-group';
import { SessionDetailCard } from '@components/molecules/session-detail-card';
import { useAdenaContext, useWalletContext } from '@hooks/use-context';
import { decodeGpub } from '@inject/gnoconnect/session-request';
import { buildSessionMessages, composeNow, reviewModel } from '@inject/gnoconnect/session-tx';
import { GnoSessionAnswer } from '@inject/gnoconnect/types';
import { SessionReviewRequest } from '@inject/message/methods/gno-connect-session';
import { RoutePath } from '@types';
import mixins from '@styles/mixins';
import { fonts, getTheme } from '@styles/theme';

const Container = styled.div`
  ${mixins.flex({ direction: 'column', align: 'stretch', justify: 'flex-start' })};
  width: 100%;
  padding: 16px 20px 120px;
  gap: 12px;
`;

const Title = styled.div`
  ${fonts.header4};
  color: ${getTheme('neutral', '_1')};
`;

const Rows = styled.dl`
  ${mixins.flex({ direction: 'column', align: 'stretch' })};
  background-color: ${getTheme('neutral', '_9')};
  border-radius: 12px;
  padding: 8px 12px;
  gap: 6px;
  margin: 0;
`;

const Row = styled.div`
  ${mixins.flex({ direction: 'row', align: 'flex-start', justify: 'space-between' })};
  gap: 12px;
  dt {
    ${fonts.body3Reg};
    color: ${getTheme('neutral', 'a')};
    flex-shrink: 0;
  }
  dd {
    ${fonts.body3Reg};
    color: ${getTheme('neutral', '_1')};
    margin: 0;
    text-align: right;
    word-break: break-all;
  }
`;

const Warning = styled.div`
  ${fonts.body3Reg};
  color: ${getTheme('red', 'a')};
  border: 1px solid ${getTheme('red', 'a')};
  border-radius: 12px;
  padding: 10px 12px;
`;

const ErrorText = styled.div`
  ${fonts.body3Reg};
  color: ${getTheme('red', 'a')};
`;

// Waits for the transaction's effect to be readable from the node.
const POLL_TRIES = 20;
const POLL_MS = 1000;

type CommitResultLike = {
  hash?: string | null;
  check_tx?: { ResponseBase?: { Error?: unknown; Log?: string } };
  deliver_tx?: { ResponseBase?: { Error?: unknown; Log?: string } };
};

const ApproveGnoConnectSession = (): ReactElement => {
  const location = useLocation();
  const navigate = useNavigate();
  const { wallet, gnoProvider } = useWalletContext();
  const { walletService, transactionService } = useAdenaContext();

  const [key, setKey] = useState('');
  const [request, setRequest] = useState<SessionReviewRequest | null>(null);
  const [signer, setSigner] = useState<Account | null>(null);
  const [nowSec, setNowSec] = useState<number | null>(null);
  const [document, setDocument] = useState<Document | null>(null);
  const [fee, setFee] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    walletService.isLocked().then((locked) => locked && navigate(RoutePath.ApproveLogin + location.search));
  }, [walletService]);

  useEffect(() => {
    const { key, data } = parseParameters(location.search);
    setKey(key);
    setRequest((decodeParameter(data)?.data as SessionReviewRequest) ?? null);
  }, [location]);

  const reply = useCallback(
    (answer: GnoSessionAnswer) => {
      chrome.runtime.sendMessage({
        key,
        code: 0,
        status: 'success',
        type: 'GNOCONNECT_SESSION',
        message: '',
        data: { gnoconnect: answer },
      });
    },
    [key],
  );

  // The identity's account, the time the grant counts from, the transaction.
  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      if (!request || !wallet || !gnoProvider) return;
      let account: Account | null = null;
      for (const candidate of wallet.accounts) {
        if (isSessionAccount(candidate)) continue;
        if ((await candidate.getAddress(GNO_PREFIX)) === request.identity) {
          account = candidate;
          break;
        }
      }
      if (!account) {
        setError(`The identity ${request.identity} is not an account of this wallet.`);
        return;
      }
      if (isLedgerAccount(account)) {
        setError('A Ledger identity cannot sign session requests yet.');
        return;
      }
      const status = await gnoProvider.getStatus().catch(() => null);
      const block = status ? Math.floor(Date.parse(status.sync_info.latest_block_time) / 1000) : null;
      const now = composeNow(Number.isFinite(block) ? block : null, Math.floor(Date.now() / 1000));
      if (now === null) {
        setError('The node gives no usable block time, so the grant cannot be composed.');
        return;
      }
      const messages = buildSessionMessages(request, now);
      const gasWanted = SESSION_ADMIN_GAS_WANTED_FALLBACK * messages.length;
      const gasFee = await resolveSessionAdminGasFee(gnoProvider, gasWanted);
      const doc = await transactionService.createDocument(
        account,
        request.chainId,
        messages,
        GNO_PREFIX,
        gasWanted,
        gasFee,
        '',
      );
      if (cancelled) return;
      setSigner(account);
      setNowSec(now);
      setFee(gasFee);
      setDocument(doc);
    })().catch((e) => !cancelled && setError((e as Error).message));
    return (): void => {
      cancelled = true;
    };
  }, [request, wallet, gnoProvider, transactionService]);

  const model = useMemo(
    () => (request?.host === 'connect' ? reviewModel(request.fields, request.onChainOld) : null),
    [request],
  );

  const approve = useCallback(async () => {
    if (!request || !wallet || !signer || !document || !gnoProvider) return;
    setSending(true);
    try {
      const { signed } = await transactionService.createTransaction(wallet, signer, document);
      const result = (await transactionService.sendTransaction(wallet, signer, signed, true)) as CommitResultLike;
      const failed = result?.check_tx?.ResponseBase?.Error || result?.deliver_tx?.ResponseBase?.Error;
      if (failed) {
        throw new Error(result?.deliver_tx?.ResponseBase?.Log || result?.check_tx?.ResponseBase?.Log || 'The transaction failed');
      }
      const hash = result?.hash ?? undefined;
      const keyAddress = decodeGpub(request.fields.pubkey).address;
      for (let i = 0; i < POLL_TRIES; i++) {
        const session = await gnoProvider.getSession(request.identity, keyAddress).catch(() => null);
        if (request.host === 'disconnect' && !session) {
          reply({ status: 'Approved', args: { revoked: keyAddress, hash } });
          return;
        }
        if (request.host === 'connect' && session) {
          const revoked = request.fields.old && request.onChainOld ? decodeGpub(request.fields.old).address : undefined;
          reply({
            status: 'Approved',
            args: {
              session: keyAddress,
              expiresAt: session.expires_at ?? 0,
              allow: session.allow_paths ?? [],
              spend: session.spend_limit ?? '',
              period: session.spend_period ?? 0,
              ...(revoked ? { revoked } : {}),
              hash,
            },
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      reply({ fail: 'tx_failed', message: 'The transaction was sent, but its effect never showed on the node' });
    } catch (e) {
      reply({ fail: 'tx_failed', message: (e as Error)?.message ?? 'The transaction failed' });
    }
  }, [request, wallet, signer, document, gnoProvider, transactionService, reply]);

  const reject = useCallback(() => reply({ status: 'Rejected' }), [reply]);

  if (!request) {
    return <Container />;
  }

  const disconnect = request.host === 'disconnect';
  return (
    <Container>
      <Title>{disconnect ? 'Revoke a session' : 'Grant a session'}</Title>
      <Rows>
        <Row>
          <dt>Requested by</dt>
          <dd>{request.origin}</dd>
        </Row>
        <Row>
          <dt>Network</dt>
          <dd>
            {request.chainId} ({request.rpcUrl})
          </dd>
        </Row>
        <Row>
          <dt>Identity</dt>
          <dd>{request.identity}</dd>
        </Row>
        {disconnect ? (
          <Row>
            <dt>Key</dt>
            <dd>{decodeGpub(request.fields.pubkey).address}</dd>
          </Row>
        ) : (
          model?.keys.map((k) => (
            <Row key={k.label}>
              <dt>{k.label}</dt>
              <dd>{k.value}</dd>
            </Row>
          ))
        )}
        {model && (
          <>
            <Row>
              <dt>Budget</dt>
              <dd>{model.budget}</dd>
            </Row>
            {model.worstCase && (
              <Row>
                <dt>Worst case</dt>
                <dd>{model.worstCase}</dd>
              </Row>
            )}
          </>
        )}
        {fee !== null && (
          <Row>
            <dt>Network fee</dt>
            <dd>{fee / 1_000_000} GNOT</dd>
          </Row>
        )}
      </Rows>
      {!disconnect && nowSec !== null && (
        <SessionDetailCard
          masterAddress={request.identity}
          expiresAt={nowSec + (request.fields.expires ?? 0)}
          allowPaths={request.fields.allow ?? []}
          spendLimitUgnot={request.fields.spend || undefined}
          spendPeriod={request.fields.period || undefined}
        />
      )}
      {model && model.risky.length > 0 && (
        <Warning>Broad permissions: this session may run arbitrary code or move funds ({model.risky.join(', ')}).</Warning>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      <BottomFixedButtonGroup
        filled
        leftButton={{ text: 'Reject', onClick: reject }}
        rightButton={{
          text: sending ? 'Sending…' : 'Approve',
          primary: true,
          disabled: !document || sending || !!error,
          onClick: approve,
        }}
      />
    </Container>
  );
};

export default ApproveGnoConnectSession;
