import React, { useState, useEffect } from 'react';

interface SelectContractFunctionPopupProps {
  contractAddress: string;
  contractABI: any[];
  onClose: () => void;
  onFunctionSelect: (contractFunction: string, inputs: any[]) => void;
}

const SelectContractFunctionPopup: React.FC<
  SelectContractFunctionPopupProps
> = ({ contractAddress, contractABI, onClose, onFunctionSelect }) => {
  const [functions, setFunctions] = useState<any[]>([]);
  const [selectedFunction, setSelectedFunction] = useState<string>('');
  const [inputs, setInputs] = useState<any[]>([]);
  const [inputValues, setInputValues] = useState<{ [key: string]: string }>({});

  useEffect(() => {
    const functionNames = contractABI
      .filter((item) => item.type === 'function')
      .map((item) => ({ name: item.name, inputs: item.inputs }));
    setFunctions(functionNames);
  }, [contractABI]);

  const handleFunctionSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedFunctionName = e.target.value;
    setSelectedFunction(selectedFunctionName);

    const functionAbi = functions.find(
      (item) => item.name === selectedFunctionName
    );
    setInputs(functionAbi.inputs || []);
    setInputValues({});
  };

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    index: number
  ) => {
    const { name, value } = e.target;
    setInputValues({ ...inputValues, [name]: value });
  };

  const handleSelect = () => {
    const inputValuesArray = inputs.map(
      (input, index) => inputValues[input.name] || ''
    );
    onFunctionSelect(selectedFunction, inputValuesArray);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center">
      <div className="bg-white p-6 rounded shadow-lg w-96">
        <h2 className="text-xl font-semibold mb-4">Select a function</h2>
        <select
          className="border p-2 w-full mb-4"
          value={selectedFunction}
          onChange={handleFunctionSelect}
        >
          <option value="">Select a function</option>
          {functions.map((func, index) => (
            <option key={index} value={func.name}>
              {func.name}
            </option>
          ))}
        </select>
        <div className="mb-4">
          {inputs.map((input, index) => (
            <div key={index} className="mb-2">
              <label className="block text-sm font-medium text-gray-700">
                {input.name} ({input.type})
              </label>
              <input
                type="text"
                name={input.name}
                value={inputValues[input.name] || ''}
                onChange={(e) => handleInputChange(e, index)}
                className="border p-2 w-full"
                placeholder={`Enter ${input.name}`}
              />
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <button
            className="bg-blue-500 text-white py-2 px-4 rounded mr-2"
            onClick={handleSelect}
          >
            Select
          </button>
          <button
            className="bg-gray-300 text-gray-700 py-2 px-4 rounded"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default SelectContractFunctionPopup;
