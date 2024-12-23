// src/components/ContractDetails.tsx

const ContractDetails = () => {
  return (
    <div className="flex flex-col items-center justify-center p-4">
      {/* Content Card */}
      <div className="w-full max-w-2xl overflow-y-auto max-h-[65vh]">
        <p className="mb-4">
          Explore the variety of covenant contracts available in the OPTN
          wallet. These contracts enhance the security and functionality of your
          digital asset transactions by setting specific conditions and rules.
        </p>

        {/* Available Contracts Section */}
        <h3 className="text-2xl font-bold mb-2">Available Contracts</h3>
        <div className="mb-4">
          {/* Escrow Contract */}
          <div className="mb-6">
            <h4 className="text-xl font-semibold">
              <a
                href="https://cashscript.org/docs/guides/covenants#restricting-p2pkh-recipients"
                className="text-blue-600 hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Escrow
              </a>
            </h4>
            <p className="mb-2">
              Facilitates secure transactions between a buyer and a seller with
              an arbiter overseeing the process. Ensures all funds are released
              only when predefined conditions are met (hard-coded fees REMOVED).
            </p>
            <ul className="list-disc list-inside mb-2">
              <li>
                <strong>Arbiter:</strong> Single trusted party to resolve
                disputes.
              </li>
              <li>
                <strong>Buyer & Seller:</strong> Parties involved in the
                transaction.
              </li>
              <li>
                <strong>Security:</strong> Conditional release of funds based on
                arbiter approval.
              </li>
            </ul>
          </div>

          {/* EscrowMS2 Contract */}
          <div className="mb-6">
            <h4 className="text-xl font-semibold">
              EscrowMS2 (Multi-Signature Escrow)
            </h4>
            <p className="mb-2">
              Enhances the basic escrow functionality by introducing multiple
              arbiters. Allows for either single or combined authorization to
              release all funds (hard-coded fees REMOVED).
            </p>
            <ul className="list-disc list-inside mb-2">
              <li>
                <strong>Multiple Arbiters:</strong> Two arbiters can authorize
                the release.
              </li>
              <li>
                <strong>Buyer & Seller:</strong> Parties involved in the
                transaction.
              </li>
              <li>
                <strong>Authorization Modes:</strong> Single arbiter approval or
                combined approvals.
              </li>
            </ul>
          </div>

          {/* P2PKH Contract */}
          <div className="mb-6">
            <h4 className="text-xl font-semibold">
              <a
                href="https://github.com/CashScript/cashscript/blob/master/examples/p2pkh.cash"
                className="text-blue-600 hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                P2PKH (Pay-to-Public-Key-Hash)
              </a>
            </h4>
            <p className="mb-2">
              A fundamental Bitcoin script ensuring that only the rightful owner
              can spend the funds. Utilizes a public key hash to secure
              transactions.
            </p>
            <ul className="list-disc list-inside mb-2">
              <li>
                <strong>Simplicity:</strong> Standard and widely used Bitcoin
                transaction method.
              </li>
            </ul>
          </div>

          {/* TransferWithTimeout Contract */}
          <div className="mb-6">
            <h4 className="text-xl font-semibold">
              <a
                href="https://github.com/CashScript/cashscript/blob/master/examples/transfer_with_timeout.cash"
                className="text-blue-600 hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                TransferWithTimeout{' '}
              </a>
            </h4>
            <p className="mb-2">
              Introduces a time-based condition to transfers, allowing funds to
              be claimed by the recipient or returned to the sender after a
              specified timeout.
            </p>
            <ul className="list-disc list-inside mb-2">
              <li>
                <strong>Time-Based Control:</strong> Defines a timeout after
                which funds can be reclaimed.
              </li>
              <li>
                <strong>Dual Authorization:</strong> Recipient can claim funds,
                or sender can reclaim after timeout.
              </li>
              <li>
                <strong>Flexibility:</strong> Suitable for conditional payments
                and subscriptions.
              </li>
            </ul>
          </div>
        </div>

        {/* How to Use Section */}
        <h3 className="text-2xl font-bold mb-2">
          How to Use Covenant Contracts
        </h3>
        <p className="mb-4">
          To create a covenant contract, navigate to the "Covenant Contracts"
          section in your OPTN wallet. Select the type of contract you wish to
          create, define the necessary conditions, and finalize the contract.
          Detailed instructions and examples are available in the documentation.
        </p>
      </div>
    </div>
  );
};

export default ContractDetails;
