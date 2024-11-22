function TransactionBuilder({
  totalSelectedUtxoAmount,
  loading,
  buildTransaction,
  sendTransaction,
  returnHome,
}) {
  return (
    <>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">
          Total Selected UTXO Amount: {totalSelectedUtxoAmount.toString()}
        </h3>
      </div>

      {/* Spinning Loader */}
      {loading && (
        <div className="flex justify-center items-center mb-6">
          <div className="w-8 h-8 border-4 border-t-4 border-blue-500 rounded-full animate-spin"></div>
        </div>
      )}

      <div className="mb-6">
        <button
          onClick={buildTransaction}
          className="bg-green-500 text-white py-2 px-4 rounded mr-2"
        >
          Build Transaction
        </button>
        <button
          onClick={sendTransaction}
          className="bg-red-500 text-white py-2 px-4 rounded"
        >
          Send Transaction
        </button>
      </div>
      <button
        onClick={returnHome}
        className="bg-red-500 text-white py-2 px-4 rounded"
      >
        Go Back
      </button>
    </>
  );
}
export default TransactionBuilder;
