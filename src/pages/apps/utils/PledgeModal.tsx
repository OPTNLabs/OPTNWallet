import React, { useState } from 'react';
import styled from 'styled-components';
import BCHLogo from './bch.png';

interface PledgeModalProps {
  isOpen: boolean;
  onRequestClose: () => void;
  onSubmit: (name: string, message: string) => void;
  pledgeAmount: string;
}

const PledgeModal: React.FC<PledgeModalProps> = ({ isOpen, onRequestClose, onSubmit, pledgeAmount }) => {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [messageOver, setMessageOver] = useState(false);
  const [nameOver, setNameOver] = useState(false);
  const [nameCharacters, setNameCharacters] = useState(15);
  const [messageCharacters, setMessageCharacters] = useState(100);

  const handleSetName = (name: string) => {
    if (name.length <=  15) {
      setName(name);
      setNameCharacters(15 - name.length);
    }
  };
  const handleSetMessage = (message: string) => {
    if (message.length <=  100) {
      setMessage(message);
      setMessageCharacters(100 - message.length);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(name, message);
    onRequestClose();
  };

  if (!isOpen) return null;

 return (
  <div 
    className="fixed inset-0 bg-black/70 flex justify-center items-center z-[1000]"
    onClick={onRequestClose}
  >
    <div 
      className="relative flex flex-col bg-black text-gray-50 p-5 rounded-lg w-[300px] h-[310px] border-2 border-[#0AC18E] justify-center items-center"
      onClick={(e) => e.stopPropagation()}
    >
      <button 
        onClick={onRequestClose}
        className="absolute flex items-start top-0.5 right-1.5 bg-black text-gray-50 h-[30px] border-2 border-gray-50 rounded-lg text-2xl font-bold leading-[19px] cursor-pointer z-5 hover:bg-[#0AC18E] hover:border-gray-50"
      >
        &times;
      </button>
      
      <div className="absolute w-full h-[35px] top-0 bg-[#0AC18E] rounded-t-lg text-gray-50 text-xl font-semibold text-center drop-shadow-[2px_2px_3px_rgba(0,0,0,0.8)]">
        Enter Pledge Details
      </div>

      <div className="relative h-[50px] w-full flex justify-center items-center text-2xl gap-1.5">
        <div 
          className="relative h-10 w-10 flex bg-cover bg-center bg-no-repeat" 
          style={{ backgroundImage: `url(${BCHLogo})` }}
        />
        {pledgeAmount}
      </div>

      <form onSubmit={handleSubmit} className="relative flex flex-col justify-center items-center">
        <label className="relative">
          <b>Name:</b> 
          <div className="absolute top-0 right-0">{nameCharacters} left</div>
          <br/>
          <input
            type="text"
            value={name}
            onChange={(e) => handleSetName(e.target.value)}
            placeholder="Anonymous"
            required
            className="relative bg-white border border-[#0AC18E] text-lg w-[275px] h-[30px] resize-none"
          />
        </label>
        
        <br />
        
        {messageOver && 
          <div className="text-red-500 text-base">
            Message must be 100 characters or less
          </div>
        }
        
        <label className="relative">
          <b>Message:</b> 
          <div className="absolute top-[55px] right-0">{messageCharacters} left</div>
          <br/>
          <textarea
            value={message}
            onChange={(e) => handleSetMessage(e.target.value)}
            maxLength={100}
            placeholder="Public message"
            required
            className="relative bg-white border border-[#0AC18E] text-lg w-[275px] h-[100px] resize-none"
          />
        </label>
        
        <button 
          type="submit"
          className="relative mt-4 mb-1.5 bg-[#0AC18E] text-gray-50 border border-white rounded-[20px] text-lg cursor-pointer z-10 w-[150px] min-w-[50px] h-8 text-center drop-shadow-[2px_2px_3px_rgba(0,0,0,0.8)] hover:bg-[#0cd9a0] hover:border-2 hover:border-white disabled:bg-gray-400 disabled:cursor-not-allowed disabled:border-2 disabled:border-gray-400 md:w-[125px]"
        >
          Submit
        </button>
      </form>
    </div>
  </div>
  );
}
export default PledgeModal;