// @ts-nocheck
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
    handler: (params: any) => Promise<void>;
}
interface ContractModalProps {
  action: AppAction;
  onSubmit: (params: any) => Promise<void>;
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
  const [params, setParams] = useState<{[key: string]: any}>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(params);
  };

  return (
    <Popup closePopups={onClose}>
      <h2 className="text-lg font-semibold mb-4">{action.name}</h2>
      <p className="text-gray-600 mb-4">{action.description}</p>

      <form onSubmit={handleSubmit}>
        {action.parameters.map((param) => (
          <div key={param.name} className="mb-4">
            <label className="block text-sm font-medium text-gray-700">
              {param.name}
              {param.required && <span className="text-red-500">*</span>}
            </label>
            <input
              type="text"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
              value={params[param.name] || ''}
              onChange={(e) => setParams({...params, [param.name]: e.target.value})}
              required={param.required}
            />
            <p className="text-sm text-gray-500">{param.description}</p>
          </div>
        ))}

        {error && (
          <div className="text-red-500 mb-4">{error}</div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border rounded-md"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isLoading}
            className="px-4 py-2 bg-blue-500 text-white rounded-md disabled:opacity-50"
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