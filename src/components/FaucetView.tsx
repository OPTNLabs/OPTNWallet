// src/components/FaucetView.tsx

import { FaDonate } from 'react-icons/fa'; // Icon representing the faucet
import { FiExternalLink } from 'react-icons/fi'; // External link icon

const FaucetView = () => {
  const faucetMethod = {
    name: 'Testnet Faucet',
    href: 'https://tbch.googol.cash/',
    icon: <FaDonate size={24} />,
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
          title={faucetMethod.tooltip}
          className="wallet-btn-primary flex items-center p-4 transition transform hover:scale-[1.01] focus:outline-none"
        >
          {/* Icon */}
          <div className="mr-4">{faucetMethod.icon}</div>

          {/* Text */}
          <div className="flex-1 font-semibold text-lg">
            {faucetMethod.name}
          </div>

          {/* External Link Indicator */}
          <div>
            <FiExternalLink size={20} />
          </div>
        </a>

        {/* Instructions Section */}
        <div className="wallet-card p-4">
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
