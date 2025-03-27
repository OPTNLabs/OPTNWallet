import React, { useState } from 'react';
import styled from 'styled-components';
import BCHLogo from './bch.png';

interface ConsolidateModalProps {
  onRequestClose: () => void;
  onSubmit: () => void;
  stringPledgeAmount: string;
}

const ConsolidateModal: React.FC<ConsolidateModalProps> = ({ onRequestClose, onSubmit, stringPledgeAmount }) => {

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit();
    onRequestClose();
  };

 return (
  <div 
    className="fixed inset-0 bg-black/70 flex justify-center items-center z-[1000]"
    onClick={onRequestClose}
  >
    <div 
      className="relative flex flex-col bg-black text-gray-50 p-5 rounded-lg w-[300px] h-[340px] border-2 border-[#0AC18E] justify-center items-center"
      onClick={(e) => e.stopPropagation()}
    >
      <button 
        onClick={onRequestClose}
        className="absolute flex items-start top-0.5 right-1.5 bg-black text-gray-50 h-[30px] border-2 border-gray-50 rounded-lg text-2xl font-bold leading-[19px] cursor-pointer z-5 hover:bg-[#0AC18E] hover:border-gray-50"
      >
        &times;
      </button>
      
      <div className="absolute w-full h-[35px] top-0 bg-[#0AC18E] rounded-t-lg text-gray-50 text-xl font-semibold text-center drop-shadow-[2px_2px_3px_rgba(0,0,0,0.8)]">
        Combine your UTXOs
      </div>

      <p />
      You tried to pledge {stringPledgeAmount} BCH but your wallet has the coins spread across multiple UTXOs. FundMe needs them to be on one UTXO.
      <p />
      The Combine button will merge them, then you can try pledging again.
      
      <form onSubmit={handleSubmit} className="relative flex flex-col justify-center items-center">
        <button 
          type="submit"
          className="relative mt-4 mb-1.5 bg-[#0AC18E] text-gray-50 border border-white rounded-[20px] text-lg cursor-pointer z-10 w-[150px] min-w-[50px] h-8 text-center drop-shadow-[2px_2px_3px_rgba(0,0,0,0.8)] hover:bg-[#0cd9a0] hover:border-2 hover:border-white disabled:bg-gray-400 disabled:cursor-not-allowed disabled:border-2 disabled:border-gray-400 md:w-[125px]"
        >
          Combine
        </button>
      </form>
      
      <p />
      If this still doesn't work then in your wallet try sending all your BCH to your wallets own receiving address and try again.
    </div>
  </div>
  );
}
// Note: The BCH logo styling can be handled like this if needed:
// <div className="relative h-10 w-10 flex bg-cover bg-center bg-no-repeat" style={{ backgroundImage: `url(${BCHLogo})` }}
export default ConsolidateModal;