// src/components/ContractDetails.tsx

const ContractDetails = () => {
  return (
    <div className="flex flex-col items-center justify-center p-4">
      {/* Content Card */}
      <div className="w-full max-w-2xl overflow-y-auto max-h-[65vh]">
        <p className="mb-4">
          Covenant contracts in the OPTN Crypto Wallet App are smart contracts
          that enforce specific rules for spending your digital assets,
          enhancing security and flexibility. Each contract locks funds in
          Unspent Transaction Outputs (UTXOs) that can only be spent by meeting
          predefined conditions. Below, explore the available contracts and
          learn how their UTXOs are spent to unlock funds.
        </p>

        {/* Available Contracts Section */}
        <h3 className="text-2xl font-bold mb-2">Available Contracts</h3>
        <div className="mb-4">
          {/* BIP38 Contract */}
          <div className="mb-6">
            <h4 className="text-xl font-semibold">
              <a
                href="https://github.com/OPTNLabs/OPTNWallet/blob/main/src/apis/ContractManager/artifacts/bip38.json"
                className="text-blue-600 hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                BIP38 (Password-Protected Private Keys)
              </a>
            </h4>
            <p className="mb-2">
              The BIP38 contract secures your private keys with a password,
              adding an extra layer of protection. Funds locked in this
              contract’s UTXOs can only be spent by providing both the correct
              password and a valid signature.
            </p>
            <ul className="list-disc list-inside mb-2">
              <li>
                <strong>Password Protection:</strong> Encrypts your private key
                with a user-defined password.
              </li>
              <li>
                <strong>Spending Requirements:</strong> To unlock funds, you
                must provide a valid signature matching the owner’s public key
                and a data signature verifying the correct password.
              </li>
              <li>
                <strong>Use Case:</strong> Ideal for securing private keys
                against theft or unauthorized access, especially for long-term
                storage.
              </li>
            </ul>
          </div>

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
              The Escrow contract ensures secure transactions between a buyer
              and a seller, with a trusted arbiter overseeing the process. Funds
              are locked in UTXOs and released only upon the arbiter’s approval
              to either the buyer or seller.
            </p>
            <ul className="list-disc list-inside mb-2">
              <li>
                <strong>Arbiter:</strong> A single trusted party who authorizes
                the release of funds.
              </li>
              <li>
                <strong>Spending Requirements:</strong> To unlock funds, the
                arbiter must provide a valid signature, and the transaction must
                send the full amount to either the buyer’s or seller’s public
                key hash address.
              </li>
              <li>
                <strong>Security:</strong> Funds remain locked until the arbiter
                approves, preventing fraud or disputes.
              </li>
            </ul>
          </div>

          {/* EscrowMS2 Contract */}
          <div className="mb-6">
            <h4 className="text-xl font-semibold">
              <a
                href="https://github.com/OPTNLabs/OPTNWallet/blob/main/src/apis/ContractManager/artifacts/escrowMS2.json"
                className="text-blue-600 hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                EscrowMS2 (Multi-Party Escrow)
              </a>
            </h4>
            <p className="mb-2">
              The EscrowMS2 contract extends the basic escrow by supporting two
              arbiters, offering flexible authorization options. Funds in UTXOs
              can be released with either one arbiter’s approval or both
              arbiters’ combined approval.
            </p>
            <ul className="list-disc list-inside mb-2">
              <li>
                <strong>Multiple Arbiters:</strong> Two arbiters can authorize
                the release of funds.
              </li>
              <li>
                <strong>Spending Requirements:</strong> To unlock funds, either
                one arbiter provides a valid signature, or both arbiters provide
                valid signatures. The transaction must send the full amount to
                either the buyer’s or seller’s public key hash address.
              </li>
              <li>
                <strong>Enhanced Trust:</strong> Ideal for complex transactions
                requiring multiple trusted parties.
              </li>
            </ul>
          </div>

          {/* MSvault Contract */}
          <div className="mb-6">
            <h4 className="text-xl font-semibold">
              <a
                href="https://github.com/OPTNLabs/OPTNWallet/blob/main/src/apis/ContractManager/artifacts/msvault.json"
                className="text-blue-600 hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                MSVault (Multi-Signature Vault)
              </a>
            </h4>
            <p className="mb-2">
              The MSVault contract creates a secure vault for long-term or
              shared storage, requiring multi-signature authorization and a
              password. It enforces a minimum balance and a time lock for added
              security.
            </p>
            <ul className="list-disc list-inside mb-2">
              <li>
                <strong>Multi-Signature:</strong> Requires signatures from
                multiple authorized parties.
              </li>
              <li>
                <strong>Spending Requirements:</strong> To unlock funds, you
                must provide a valid signature and a password-verified data
                signature, maintaining a minimum balance of 4000 satoshis in the
                vault. Alternatively, after the time lock expires, one of two
                predefined public key hashes can unlock funds with a valid
                signature.
              </li>
              <li>
                <strong>Use Case:</strong> Perfect for shared ownership or
                secure long-term storage with strict access controls.
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
              The P2PKH contract is a standard Bitcoin script that secures funds
              in UTXOs by requiring a signature from the owner of a specified
              public key hash. It’s the most widely used method for protecting
              bitcoins.
            </p>
            <ul className="list-disc list-inside mb-2">
              <li>
                <strong>Simplicity:</strong> Easy to use and compatible with
                most Bitcoin wallets.
              </li>
              <li>
                <strong>Spending Requirements:</strong> To unlock funds, you
                must provide a valid signature matching the public key hash
                specified in the contract.
              </li>
              <li>
                <strong>Security:</strong> A proven and reliable method for
                securing digital assets.
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
                TransferWithTimeout
              </a>
            </h4>
            <p className="mb-2">
              The TransferWithTimeout contract enables conditional transfers
              with a time limit. Funds in UTXOs can be claimed by the recipient
              before the timeout or reclaimed by the sender afterward.
            </p>
            <ul className="list-disc list-inside mb-2">
              <li>
                <strong>Time-Based Control:</strong> Sets a deadline for the
                recipient to claim funds.
              </li>
              <li>
                <strong>Spending Requirements:</strong> To unlock funds, the
                recipient must provide a valid signature before the timeout.
                After the timeout, the sender can reclaim funds with their valid
                signature.
              </li>
              <li>
                <strong>Use Cases:</strong> Ideal for subscriptions, conditional
                payments, or escrow-like scenarios.
              </li>
            </ul>
          </div>
        </div>

        {/* How to Use Section */}
        <h3 className="text-2xl font-bold mb-2">
          How to Use Covenant Contracts
        </h3>
        <p className="mb-4">
          To create a covenant contract, navigate to the "Contracts" section in
          your OPTN wallet. Select the desired contract type, configure the
          required conditions (e.g., public keys, passwords, or timeouts), and
          deploy the contract. To spend funds from a contract’s UTXOs, ensure
          you meet the specific spending requirements outlined above. Detailed
          instructions and examples are available in the app’s documentation.
        </p>
      </div>
    </div>
  );
};

export default ContractDetails;
