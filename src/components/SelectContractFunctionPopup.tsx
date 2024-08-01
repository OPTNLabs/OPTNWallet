// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { useDispatch } from 'react-redux';
import {
  setSelectedFunction,
  setInputs,
  setInputValues,
} from '../redux/contractSlice';

interface SelectContractFunctionPopupProps {
  contractABI: any[];
  onClose: () => void;
  onFunctionSelect: (contractFunction: string, inputs: any[]) => void;
}

const SelectContractFunctionPopup: React.FC<
  SelectContractFunctionPopupProps
> = ({ contractABI, onClose, onFunctionSelect }) => {
  const [functions, setFunctions] = useState<any[]>([]);
  const [selectedFunction, setSelectedFunction] = useState<string>('');
  const [inputs, setInputs] = useState<any[]>([]);
  const [inputValues, setInputValues] = useState<{ [key: string]: string }>({});
  const dispatch = useDispatch();

  useEffect(() => {
    if (!contractABI || !Array.isArray(contractABI)) {
      console.error('Contract ABI is null, undefined, or not an array');
      return;
    }

    const allFunctionNames = contractABI
      .filter((item) => item.type === 'function' || item.type === undefined)
      .map((item) => ({ name: item.name, inputs: item.inputs }))
      .filter(
        (item, index, self) =>
          self.findIndex((f) => f.name === item.name) === index
      );

    setFunctions(allFunctionNames);
  }, [contractABI]);

  const handleFunctionSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedFunctionName = e.target.value;
    setSelectedFunction(selectedFunctionName);

    const functionAbi = functions.find(
      (item) => item.name === selectedFunctionName
    );
    setInputs(functionAbi?.inputs || []);
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
    const inputValuesArray = inputs.map((input) => ({
      type: input.type,
      value: inputValues[input.name] || '',
    }));
    console.log(
      `selectedFunction ${typeof selectedFunction}: ${selectedFunction}`
    );
    console.log(`inputs ${typeof inputs}: ${inputs}`);
    console.log(`inputValues ${typeof inputValues}: ${inputValues}`);

    if (!selectedFunction || !inputs) {
      console.error('Selected function or inputs are undefined');
      return;
    }

    // Create an object to store the input values in the desired format
    const inputValuesObject = inputs.reduce((acc, input) => {
      acc[input.name] = inputValues[input.name] || '';
      return acc;
    }, {});

    console.log('inputValuesObject', inputValuesObject);

    try {
      console.log('Dispatching setSelectedFunction');
      dispatch(setSelectedFunction(selectedFunction));

      console.log('Dispatching setInputs');
      dispatch(setInputs(inputs));

      console.log('Dispatching setInputValues');
      dispatch(setInputValues(inputValuesObject)); // Dispatch input values to Redux store
    } catch (error) {
      console.error('Error dispatching actions:', error);
    }

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
