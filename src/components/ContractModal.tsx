import React, { useState } from 'react';
import { TailSpin } from 'react-loader-spinner';
import Popup from './transaction/Popup';

interface ActionParameter {
    name: string;
    type: string;
    description: string;
    required: boolean;
}
interface AppAction {
    id: string;
    name: string;
    description: string;
    parameters: ActionParameter[];
    handler: (params: Record<string, string>) => Promise<void>;
}
interface ContractModalProps {
  action: AppAction;
  onSubmit: (params: Record<string, string>) => Promise<void>;
  onClose: () => void;
  isLoading: boolean;
  error: string | null;
}

const ContractModal: React.FC<ContractModalProps> = ({
  action,
  onSubmit,
  onClose,
  isLoading,
  error
}) => {
  const [params, setParams] = useState<Record<string, string>>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(params);
  };

  return (
    <Popup closePopups={onClose}>
      <h2 className="text-lg font-semibold mb-4 wallet-text-strong">{action.name}</h2>
      <p className="wallet-muted mb-4">{action.description}</p>

      <form onSubmit={handleSubmit}>
        {action.parameters.map((param) => (
          <div key={param.name} className="mb-4">
            <label className="block text-sm font-medium wallet-text-strong">
              {param.name}
              {param.required && <span className="wallet-danger-text">*</span>}
            </label>
            <input
              type="text"
              className="mt-1 block w-full wallet-input"
              value={params[param.name] || ''}
              onChange={(e) => setParams({...params, [param.name]: e.target.value})}
              required={param.required}
            />
            <p className="text-sm wallet-muted">{param.description}</p>
          </div>
        ))}

        {error && (
          <div className="wallet-danger-text mb-4">{error}</div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="wallet-btn-secondary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isLoading}
            className="wallet-btn-primary"
          >
            {isLoading ? (
              <TailSpin visible={true} height="24" width="24" color="white" />
            ) : (
              'Confirm'
            )}
          </button>
        </div>
      </form>
    </Popup>
  );
};

export default ContractModal;
