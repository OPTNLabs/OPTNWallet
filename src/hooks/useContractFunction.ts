// src/hooks/useContractFunction.ts

import { useState } from 'react';
import { useDispatch } from 'react-redux';
import {
  setSelectedFunction,
  setInputValues,
  resetContract,
} from '../redux/contractSlice';
import { UTXO } from '../types/types';
import { SignatureTemplate, HashType } from 'cashscript';

interface ContractFunctionParams {
  contractFunction: string;
  inputs: { [key: string]: string };
  tempUtxos: UTXO | undefined;
  selectedUtxos: UTXO[];
  setSelectedUtxos: React.Dispatch<React.SetStateAction<UTXO[]>>;
}

const useContractFunction = () => {
  const dispatch = useDispatch();

  const handleContractFunctionSelect = ({
    contractFunction,
    inputs,
    tempUtxos,
    selectedUtxos,
    setSelectedUtxos,
  }: ContractFunctionParams) => {
    console.log('Selected Contract Function:', contractFunction);
    console.log('Selected Contract Function Inputs:', inputs);

    // Validate inputs is an object, not an array
    if (typeof inputs !== 'object' || Array.isArray(inputs)) {
      console.error("Error: 'inputs' is not a valid object. Received:", inputs);
      return;
    }

    // Set contract function and inputs
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

  return { handleContractFunctionSelect };
};

export default useContractFunction;
