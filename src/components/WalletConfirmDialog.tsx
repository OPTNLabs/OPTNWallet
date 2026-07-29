import React, { createContext, useCallback, useContext, useState } from 'react';

type Confirmation = { message: string; resolve: (confirmed: boolean) => void };
type ConfirmContextValue = (message: string) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export const WalletConfirmProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const confirm = useCallback((message: string) => new Promise<boolean>((resolve) => {
    setConfirmation({ message, resolve });
  }), []);

  const close = (confirmed: boolean) => {
    confirmation?.resolve(confirmed);
    setConfirmation(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {confirmation && (
        <div className="wallet-dialog-backdrop" role="presentation" onMouseDown={() => close(false)}>
          <section
            className="wallet-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="wallet-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="wallet-dialog-title" className="wallet-dialog-title">Confirm action</h2>
            <p className="wallet-dialog-message">{confirmation.message}</p>
            <div className="wallet-dialog-actions">
              <button type="button" className="wallet-btn-secondary wallet-dialog-button" onClick={() => close(false)}>Cancel</button>
              <button type="button" className="wallet-btn-primary wallet-dialog-button" onClick={() => close(true)}>OK</button>
            </div>
          </section>
        </div>
      )}
    </ConfirmContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useWalletConfirm = (): ConfirmContextValue => {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useWalletConfirm must be used inside WalletConfirmProvider');
  return confirm;
};
