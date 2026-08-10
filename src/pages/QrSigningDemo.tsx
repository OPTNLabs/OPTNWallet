import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QrStreamDisplay } from '../components/qr/QrStreamDisplay';
import { QrStreamScanner } from '../components/qr/QrStreamScanner';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import WalletScreen from '../components/ui/WalletScreen';
import { createMocknetSigningRequest } from '../services/mocknetSigningFixtures';
import {
  createSigningResponse,
  deserializePartiallySignedTransaction,
  deserializeTransactionSigningResponse,
  serializePartiallySignedTransaction,
  serializeTransactionSigningResponse,
  type PartiallySignedTransaction,
} from '../services/partiallySignedTransaction';
import { useI18n } from '../i18n/useI18n';

type DemoMode = 'requester' | 'signer';

const formatBytes = (value: Uint8Array) => `${value.length} bytes`;

const QrSigningDemo: React.FC = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [mode, setMode] = useState<DemoMode>('requester');
  const [localRequest, setLocalRequest] =
    useState<PartiallySignedTransaction | null>(null);
  const [request, setRequest] = useState<PartiallySignedTransaction | null>(
    null
  );
  const [responsePayload, setResponsePayload] = useState<Uint8Array | null>(
    null
  );
  const [scanResponse, setScanResponse] = useState(false);
  const [responseMessage, setResponseMessage] = useState<string | null>(null);

  const [requestPayload, setRequestPayload] = useState<Uint8Array | null>(null);

  useEffect(() => {
    let cancelled = false;
    void createMocknetSigningRequest()
      .then((nextRequest) => {
        if (cancelled) return;
        setLocalRequest(nextRequest);
        setRequestPayload(serializePartiallySignedTransaction(nextRequest));
      })
      .catch((error) => {
        if (!cancelled) {
          setResponseMessage(
            error instanceof Error
              ? error.message
              : t('qrSigning.prepareFailed')
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const handleRequestComplete = useCallback(
    (payload: Uint8Array) => {
      try {
        setRequest(deserializePartiallySignedTransaction(payload));
        setResponseMessage(null);
      } catch (error) {
        setResponseMessage(
          error instanceof Error ? error.message : t('qrSigning.invalidRequest')
        );
      }
    },
    [t]
  );

  const handleResponseComplete = useCallback(
    (payload: Uint8Array) => {
      try {
        const response = deserializeTransactionSigningResponse(payload);
        if (
          !localRequest ||
          response.requestId !== localRequest.metadata.requestId ||
          response.transactionFingerprint !==
            localRequest.metadata.transactionFingerprint
        ) {
          throw new Error(t('qrSigning.mismatch'));
        }
        setResponseMessage(
          response.approved
            ? t('qrSigning.approvedBy', { name: response.signerLabel })
            : t('qrSigning.rejectedBy', { name: response.signerLabel })
        );
        setScanResponse(false);
      } catch (error) {
        setResponseMessage(
          error instanceof Error
            ? error.message
            : t('qrSigning.invalidResponse')
        );
      }
    },
    [localRequest, t]
  );

  const approveRequest = () => {
    if (!request) return;
    const response = createSigningResponse({
      request,
      signerLabel: 'Demo signer',
      approved: true,
      inputIndex: request.inputs[0]?.index ?? 0,
      publicKey: '02-demo-public-key',
      signature: 'demo-signature-not-for-broadcast',
    });
    setResponsePayload(serializeTransactionSigningResponse(response));
  };

  return (
    <WalletScreen maxWidthClassName="max-w-md">
      <div className="space-y-4">
        <PageHeader
          title={t('qrSigning.title')}
          subtitle={t('qrSigning.subtitle')}
          compact
        />

        <SectionCard>
          <div className="flex gap-2">
            {(['requester', 'signer'] as const).map((nextMode) => (
              <button
                key={nextMode}
                type="button"
                onClick={() => {
                  setMode(nextMode);
                  setRequest(null);
                  setResponsePayload(null);
                  setScanResponse(false);
                  setResponseMessage(null);
                }}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${
                  mode === nextMode
                    ? 'bg-[var(--wallet-accent)] text-black'
                    : 'border border-[var(--wallet-border)] wallet-text-strong'
                }`}
              >
                {nextMode === 'requester'
                  ? t('qrSigning.requestSignature')
                  : t('qrSigning.signRequest')}
              </button>
            ))}
          </div>
        </SectionCard>

        {mode === 'requester' ? (
          <>
            <SectionCard title={t('qrSigning.showRequest')}>
              <p className="mb-3 text-sm wallet-text-muted">
                {t('qrSigning.showRequestHelp')}
              </p>
              {requestPayload ? (
                <div className="mx-auto w-full max-w-[320px] rounded-xl bg-white p-3">
                  <QrStreamDisplay
                    payload={requestPayload}
                    blockLength={360}
                    framesPerSecond={18}
                  />
                </div>
              ) : (
                <p className="text-sm wallet-text-muted">
                  {t('qrSigning.preparing')}
                </p>
              )}
              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="wallet-text-muted">
                    {t('qrSigning.network')}
                  </dt>
                  <dd>mocknet</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="wallet-text-muted">
                    {t('qrSigning.purpose')}
                  </dt>
                  <dd>
                    {localRequest?.metadata.purpose ?? t('qrSigning.preparing')}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="wallet-text-muted">
                    {t('qrSigning.payload')}
                  </dt>
                  <dd>
                    {requestPayload
                      ? formatBytes(requestPayload)
                      : t('qrSigning.preparing')}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="wallet-text-muted">
                    {t('qrSigning.fingerprint')}
                  </dt>
                  <dd className="font-mono text-xs">
                    {localRequest?.metadata.transactionFingerprint ??
                      t('qrSigning.preparing')}
                  </dd>
                </div>
              </dl>
            </SectionCard>
            <SectionCard title={t('qrSigning.collectResponse')}>
              {scanResponse ? (
                <QrStreamScanner onComplete={handleResponseComplete} />
              ) : (
                <button
                  type="button"
                  onClick={() => setScanResponse(true)}
                  className="w-full rounded-lg bg-[var(--wallet-accent)] px-3 py-2 text-sm font-semibold text-black"
                >
                  {t('qrSigning.scanApproval')}
                </button>
              )}
              {responseMessage ? (
                <p className="mt-3 text-sm wallet-text-strong">
                  {responseMessage}
                </p>
              ) : null}
            </SectionCard>
          </>
        ) : (
          <>
            <SectionCard title={t('qrSigning.scanRequest')}>
              {request ? (
                <div className="space-y-2 text-sm">
                  <p className="font-semibold">
                    {t('qrSigning.requestReceived')}
                  </p>
                  <p>
                    {t('qrSigning.purpose')}: {request.metadata.purpose}
                  </p>
                  <p>
                    {t('qrSigning.network')}: {request.network}
                  </p>
                  <p className="font-mono text-xs">
                    {t('qrSigning.fingerprint')}:{' '}
                    {request.metadata.transactionFingerprint}
                  </p>
                  <button
                    type="button"
                    onClick={() => setRequest(null)}
                    className="rounded-lg border border-[var(--wallet-border)] px-3 py-2 text-sm"
                  >
                    {t('qrSigning.scanAnother')}
                  </button>
                </div>
              ) : (
                <QrStreamScanner onComplete={handleRequestComplete} />
              )}
            </SectionCard>
            {request ? (
              <SectionCard title={t('qrSigning.approveReturn')}>
                <p className="mb-3 text-sm wallet-text-muted">
                  {t('qrSigning.placeholderWarning')}
                </p>
                <button
                  type="button"
                  onClick={approveRequest}
                  className="w-full rounded-lg bg-[var(--wallet-accent)] px-3 py-2 text-sm font-semibold text-black"
                >
                  {t('qrSigning.approveDemo')}
                </button>
                {responsePayload ? (
                  <div className="mt-4 mx-auto w-full max-w-[320px] rounded-xl bg-white p-3">
                    <QrStreamDisplay
                      payload={responsePayload}
                      blockLength={360}
                      framesPerSecond={18}
                    />
                  </div>
                ) : null}
              </SectionCard>
            ) : null}
            {responseMessage ? (
              <p className="text-sm wallet-text-strong">{responseMessage}</p>
            ) : null}
          </>
        )}

        <button
          type="button"
          onClick={() => navigate(-1)}
          className="w-full rounded-lg border border-[var(--wallet-border)] px-3 py-2 text-sm font-semibold wallet-text-strong"
        >
          {t('qrSigning.close')}
        </button>
      </div>
    </WalletScreen>
  );
};

export default QrSigningDemo;
