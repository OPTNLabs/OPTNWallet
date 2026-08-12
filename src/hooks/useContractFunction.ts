// src/hooks/useContractFunction.ts

// import { useState } from 'react';
import { useDispatch } from 'react-redux';
import {
  setSelectedFunction,
  setInputValues,
  // resetContract,
} from '../redux/contractSlice';
import { UTXO } from '../types/types';
// import { SignatureTemplate, HashType } from 'cashscript';

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
    // console.log('Selected Contract Function:', contractFunction);
    // console.log('Selected Contract Function Inputs:', inputs);

    // Validate inputs is an object, not an array
    if (typeof inputs !== 'object' || Array.isArray(inputs)) {
      console.error("Error: 'inputs' is not a valid object. Received:", inputs);
      return;
    }

    // Set contract function and inputs
    dispatch(setSelectedFunction(contractFunction));
    dispatch(setInputValues(inputs));

    // **Set the new fields in UTXO**
    const updatedUtxo: UTXO = {
      ...tempUtxos,
      contractFunction,
      contractFunctionInputs: inputs,
    };
    setSelectedUtxos([...selectedUtxos, updatedUtxo]);

    // **Add Logging Here**
    // console.log(
    //   'Updated UTXO in hook with contractFunction and contractFunctionInputs:',
    //   updatedUtxo
    // );
  };

  return { handleContractFunctionSelect };
};

export default useContractFunction;
