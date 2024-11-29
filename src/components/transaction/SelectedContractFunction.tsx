// src/components/transaction/SelectedContractFunction.tsx

import React from 'react';
import { SignatureTemplate, HashType } from 'cashscript';
import { UTXO } from '../../types/types';
import { setSelectedFunction, setInputValues } from '../../redux/contractSlice';
import { useDispatch } from 'react-redux';

interface SelectedContractFunctionProps {
  contractFunction: string;
  inputs: { [key: string]: string };
  tempUtxos: UTXO | undefined;
  selectedUtxos: UTXO[];
  setSelectedUtxos: React.Dispatch<React.SetStateAction<UTXO[]>>;
}

const SelectedContractFunction: React.FC<SelectedContractFunctionProps> = ({
  contractFunction,
  inputs,
  tempUtxos,
  selectedUtxos,
  setSelectedUtxos,
}) => {
  const dispatch = useDispatch();

  const handleContractFunctionSelect = () => {
    console.log('Selected Contract Function:', contractFunction);
    console.log('Selected Contract Function Inputs:', inputs);

    // Validate inputs is an object, not an array
    if (typeof inputs !== 'object' || Array.isArray(inputs)) {
      console.error("Error: 'inputs' is not a valid object. Received:", inputs);
      return;
    }

    // Dispatch actions to set the selected function and input values
    dispatch(setSelectedFunction(contractFunction));
    dispatch(setInputValues(inputs));

    // Create an unlocker template from the input values
    const unlockerInputs = Object.entries(inputs).map(([key, value]) =>
      key === 's' ? new SignatureTemplate(value, HashType.SIGHASH_ALL) : value
    );

    const unlocker = {
      contractFunction,
      unlockerInputs,
    };

    // Find the matching UTXO and update it with unlocker
    if (tempUtxos) {
      const updatedUtxo: UTXO = {
        ...tempUtxos,
        unlocker,
      };
      setSelectedUtxos([...selectedUtxos, updatedUtxo]);
    }
  };

  return (
    <button onClick={handleContractFunctionSelect}>
      Confirm Contract Function
    </button>
  );
};

export default SelectedContractFunction;
