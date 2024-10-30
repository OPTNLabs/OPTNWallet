import { shortenTxHash } from '../utils/shortenHash';

const CashTokenUTXOs = ({ utxos, loading }) => {
  const safelyParseTokenData = (tokenData) => {
    if (!tokenData) return {}; // Return an empty object if null/undefined
    if (typeof tokenData === 'string') {
      try {
        return JSON.parse(tokenData);
      } catch (error) {
        console.error(`Error parsing token_data for address:`, error);
        return {}; // Fallback to empty object on parsing failure
      }
    }
    return tokenData; // Return as-is if already an object
  };

  return (
    <div>
      <h4 className="font-semibold">CashToken UTXOs:</h4>
      {loading ? (
        <div className="flex items-center">
          <svg
            className="animate-spin h-5 w-5 mr-3 text-gray-500"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            ></circle>
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v8H4z"
            ></path>
          </svg>
          <span>Loading UTXOs...</span>
        </div>
      ) : (
        utxos &&
        utxos.map((utxo, idx) => {
          const tokenData = safelyParseTokenData(utxo.token_data);

          return (
            <div
              key={idx}
              className="p-2 mb-2 border rounded-lg overflow-x-auto"
            >
              <p className="break-words">
                <strong>Amount:</strong> {utxo.amount} satoshis
              </p>
              <p className="break-words">
                <strong>Token Amount:</strong> {tokenData.amount || 'N/A'}
              </p>
              <p className="break-words">
                <strong>Token Category:</strong>{' '}
                {shortenTxHash(tokenData.category) || 'N/A'}
              </p>
              <p className="break-words">
                <strong>Transaction Hash:</strong> {shortenTxHash(utxo.tx_hash)}
              </p>
              <p className="break-words">
                <strong>Position:</strong> {utxo.tx_pos}
              </p>
              <p className="break-words">
                <strong>Height:</strong> {utxo.height}
              </p>
            </div>
          );
        })
      )}
    </div>
  );
};

export default CashTokenUTXOs;
