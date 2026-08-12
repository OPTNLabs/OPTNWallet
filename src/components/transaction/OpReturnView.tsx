import React from 'react';

interface OpReturnViewProps {
  opReturnText: string;
  setOpReturnText: (value: string) => void;
  addOpReturnOutput: () => void;
}

const OpReturnView: React.FC<OpReturnViewProps> = ({
  opReturnText,
  setOpReturnText,
  addOpReturnOutput,
}) => {
  return (
    <>
      <label className="block font-medium mb-1">OP_RETURN Data</label>
      <textarea
        value={opReturnText}
        onChange={(e) => setOpReturnText(e.target.value)}
        placeholder="Enter space-separated ASCII words"
        className="border p-2 w-full break-words whitespace-normal h-32"
      />
      <div className="flex justify-end mt-4">
        <button
          onClick={addOpReturnOutput}
          className="bg-yellow-500 font-bold text-white py-2 px-4 rounded"
        >
          Add OP_RETURN Output
        </button>
      </div>
    </>
  );
};

export default OpReturnView;