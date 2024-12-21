// src/components/AboutView.tsx

// import React from 'react';

const AboutView = () => {
  return (
    <div className="flex flex-col items-center justify-center p-4">
      {/* Content Card */}
      <div className="w-full max-w-2xl overflow-y-auto max-h-[65vh]">
        {/* Overview Section */}
        <h2 className="text-3xl font-bold mb-4">Overview</h2>
        <p className="mb-4">
          The OPTN wallet is a powerful and innovative application designed to
          enhance the security and flexibility of your digital asset
          transactions. By integrating Bitcoin covenants, it ensures robust
          management of your cryptocurrencies with state-of-the-art security
          measures.
        </p>

        {/* Key Features Section */}
        <h3 className="text-2xl font-bold mb-2">Key Features</h3>
        <ul className="list-disc list-inside mb-4">
          <li className="mb-2">
            <strong>Creating and Importing Wallets:</strong> Easily create new
            wallets or import existing ones to manage your assets seamlessly.
          </li>
          <li className="mb-2">
            <strong>Viewing Covenants:</strong> Access and review transaction
            covenants directly within the wallet interface, ensuring
            transparency and control.
          </li>
          <li className="mb-2">
            <strong>Building and Sending Transactions:</strong> Construct and
            send transactions with ease, leveraging covenant-enforced conditions
            for enhanced security.
          </li>
          <li className="mb-2">
            <strong>Security:</strong> Implemented with transaction covenant
            security measures to protect your digital assets against
            unauthorized transactions.
          </li>
        </ul>

        {/* Intended Use Section */}
        <h3 className="text-2xl font-bold mb-2">Intended Use</h3>
        <p className="mb-4">
          The OPTN wallet is currently provided as a prototype for demonstration
          purposes. It is intended for investors and potential clients to
          evaluate its innovative functionality and user-centric design.
        </p>

        {/* Additional Information Section */}
        <h3 className="text-2xl font-bold mb-2">Additional Information</h3>
        <ul className="list-disc list-inside mb-4">
          <li className="mb-2">
            <a
              href="https://covenants.info/"
              className="text-blue-600 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Bitcoin Covenants Wiki
            </a>
          </li>
          <li className="mb-2">
            <a
              href="https://next.cashscript.org/docs/guides/covenants"
              className="text-blue-600 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              CashScript - Writing Covenants & Introspection
            </a>
          </li>
          <li className="mb-2">
            <a
              href="https://github.com/CashScript/cashscript/tree/master/examples"
              className="text-blue-600 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              CashScript Covenant Examples
            </a>
          </li>
          <li className="mb-2">
            <a
              href="https://cointelegraph.com/news/what-are-bitcoin-covenants-and-how-do-they-work"
              className="text-blue-600 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Cointelegraph - What are Bitcoin covenants, and how do they work?
            </a>
          </li>
        </ul>

        {/* Feedback and Support Section */}
        <h3 className="text-2xl font-bold mb-2">Feedback and Support</h3>
        <p>
          We welcome feedback and inquiries regarding the OPTN wallet. Please
          refer to the contact information provided separately for any questions
          or support needs.
        </p>
      </div>
    </div>
  );
};

export default AboutView;
