// src/components/FaucetView.tsx

import { FaDonate } from 'react-icons/fa'; // Icon representing the faucet
import { FiExternalLink } from 'react-icons/fi'; // External link icon

const FaucetView = () => {
  const faucetMethod = {
    name: 'Testnet Faucet',
    href: 'https://tbch.googol.cash/',
    icon: <FaDonate size={24} />,
    bgColor: 'bg-purple-500',
    hoverColor: 'hover:bg-purple-700',
    tooltip: 'Get testnet BCH',
  };

  return (
    <div className="flex flex-col items-center justify-center max-h-full p-4 h-4/5 mb-4">
      {/* Faucet Method Card */}
      <div className="w-full max-w-md space-y-4 mt-4">
        <a
          href={faucetMethod.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={faucetMethod.name}
          className={`flex items-center p-4 rounded-lg shadow-md ${faucetMethod.bgColor} ${faucetMethod.hoverColor} transition transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-${faucetMethod.bgColor.split('-')[1]}-500`}
        >
          {/* Icon */}
          <div className="mr-4 text-white">{faucetMethod.icon}</div>

          {/* Text */}
          <div className="flex-1 text-white font-semibold text-lg">
            {faucetMethod.name}
          </div>

          {/* External Link Indicator */}
          <div className="text-white">
            <FiExternalLink size={20} />
          </div>
        </a>

        {/* Instructions Section */}
        <div className="p-4 rounded-lg shadow-md bg-gray-100">
          <h3 className="text-xl font-bold mb-2">Instructions</h3>
          <ol className="list-decimal ml-6 space-y-2">
            <li>Copy a BCH testnet address</li>
            <li>Click the Testnet Faucet link</li>
            <li>Select "chipnet" in the NETWORK box</li>
            <li>Paste your address</li>
            <li>Answer the captcha question</li>
            <li>Press "Get Coins"</li>
          </ol>
        </div>
      </div>
    </div>
  );
};

export default FaucetView;
