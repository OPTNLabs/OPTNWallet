import { useEffect, useState } from 'react';

/**
 * This example is mounted by OPTN Wallet's built-in add-on host. It uses the
 * same public wallet facade that an external add-on receives; the host owns
 * the concrete adapter and approval policy.
 */
export default function AddonSdkWalletDemo({ sdk }: { sdk: any }) {
  const [state, setState] = useState<{
    walletId: number | null;
    network: string;
    address: string;
    addressCount: number;
    tokenCount: number;
  }>({
    walletId: null,
    network: 'unknown',
    address: '',
    addressCount: 0,
    tokenCount: 0,
  });
  const [status, setStatus] = useState('Loading through the add-on SDK…');
  const [contractAddress, setContractAddress] = useState('');
  const [contractUtxo, setContractUtxo] = useState<any>(null);

  const demoArtifact = {
    contractName: 'AddonSdkDemoP2PKH',
    constructorInputs: [{ name: 'pkh', type: 'bytes20' }],
    abi: [{ name: 'spend', inputs: [{ name: 'pk', type: 'pubkey' }, { name: 's', type: 'sig' }] }],
    bytecode: 'OP_OVER OP_HASH160 OP_EQUALVERIFY OP_CHECKSIG',
    compiler: { name: 'cashc', version: '0.13.0' },
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const context = await sdk.wallet.getContext();
        const addresses = await sdk.wallet.listAddresses();
        const walletUtxos = await sdk.utxos.listForWallet();
        if (!active) return;
        setState({
          walletId: context.walletId,
          network: String(context.network ?? 'unknown'),
          address: addresses[0]?.address ?? '',
          addressCount: addresses.length,
          tokenCount: walletUtxos.tokenUtxos.length,
        });
        setStatus('Connected to the wallet');
      } catch (error) {
        if (active) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [sdk]);

  return (
    <section className="wallet-card rounded-2xl p-4 space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Add-on SDK wallet demo</h2>
        <p className="text-sm wallet-muted">{status}</p>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div><dt className="wallet-muted">Wallet ID</dt><dd>{state.walletId ?? '—'}</dd></div>
        <div><dt className="wallet-muted">Network</dt><dd>{state.network}</dd></div>
        <div><dt className="wallet-muted">Addresses</dt><dd>{state.addressCount}</dd></div>
        <div><dt className="wallet-muted">Token UTXOs</dt><dd>{state.tokenCount}</dd></div>
      </dl>
      <div className="text-xs break-all wallet-muted">
        Primary address: {state.address || 'unavailable'}
      </div>
      <button
        className="wallet-btn-secondary"
        onClick={async () => {
          try {
            const address = await sdk.contracts.deriveAddress({
              artifact: demoArtifact,
              constructorArgs: [{ type: 'bytes20', value: '00'.repeat(20) }],
              contractType: 'p2sh32',
            });
            setContractAddress(address);
            const utxos = await sdk.utxos.listForAddress(address);
            setContractUtxo(utxos.find((utxo: any) => !utxo.token && utxo.value >= 2000) ?? null);
            setStatus('Generic CashScript contract identity derived by the wallet');
          } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        Derive CashScript contract address
      </button>
      {contractAddress && <div className="text-xs break-all wallet-muted">Contract address: {contractAddress}</div>}
      {contractAddress && (
        <button
          className="wallet-btn-secondary"
          disabled={!contractUtxo}
          onClick={async () => {
            if (!contractUtxo) return;
            try {
              const contract = await sdk.contracts.instantiate({
                artifact: demoArtifact,
                constructorArgs: [{ type: 'bytes20', value: '00'.repeat(20) }],
                contractType: 'p2sh32',
              });
              await sdk.contracts.propose({
                contract,
                artifact: demoArtifact,
                constructorArgs: [{ type: 'bytes20', value: '00'.repeat(20) }],
                function: { name: 'spend', args: [{ type: 'sig', signer: { address: contractAddress, purpose: 'wallet-spend' } }] },
                inputs: [contractUtxo],
                contractInputIndexes: [0],
                outputs: [{ recipientAddress: state.address, amount: Math.max(546, Number(contractUtxo.value) - 1000) }],
              });
              setStatus('Contract proposal submitted for wallet review');
            } catch (error) {
              setStatus(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          Propose contract spend for review
        </button>
      )}
      <button
        className="wallet-btn-secondary"
        onClick={async () => {
          const confirmed = await sdk.ui.confirmSensitiveAction({
            title: 'SDK confirmation example',
            description: 'This prompt is controlled by OPTN Wallet.',
            risk: 'low',
          });
          setStatus(confirmed ? 'Wallet user confirmed the request' : 'Wallet user declined the request');
        }}
      >
        Test wallet confirmation
      </button>
    </section>
  );
}
