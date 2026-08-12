// src/components/TermsOfUse.tsx
const TermsOfUse = () => {
  return (
    <div className="overflow-y-auto h-full">
      <div className="p-4 rounded-lg space-y-4">
        <h3 className="font-bold">1. Acceptance of Terms</h3>
        <p>
          By accessing and using the OPTN Wallet App (“the App”), you agree to
          comply with and be bound by these Terms of Use. If you do not agree to
          these terms, please do not use the App.
        </p>

        <h3 className="font-bold">2. Purpose</h3>
        <p>
          The OPTN Wallet App is a live application designed to allow users to
          securely store, send, and receive cryptocurrency. The App provides a
          user-centric interface for managing digital assets, but it is your
          responsibility to ensure the security of your private keys and assets.
        </p>

        <h3 className="font-bold">3. User Responsibilities</h3>
        <p>
          The OPTN Wallet App handles real cryptocurrency. You are solely
          responsible for:
        </p>
        <ul className="list-disc pl-6">
          <li>Safeguarding your private keys and recovery phrases.</li>
          <li>Verifying transaction details before confirming any actions.</li>
          <li>Ensuring the security of your device and the App.</li>
        </ul>
        <p>
          The development team is not responsible for any loss of assets or
          unauthorized access resulting from your failure to follow these
          practices.
        </p>

        <h3 className="font-bold">4. No Liability</h3>
        <p>
          The developers of the OPTN Wallet App assume no liability for any
          loss, damage, or unauthorized access arising from your use of the App.
          This includes, but is not limited to, loss of cryptocurrency, data
          breaches, or device malfunctions. You acknowledge that you use the App
          at your own risk.
        </p>

        <h3 className="font-bold">5. No Warranty</h3>
        <p>
          The App is provided “as is” without any warranties, express or
          implied. The developers make no guarantees regarding the reliability,
          accuracy, or completeness of the App’s functionality. We do not
          warrant that the App will be error-free or uninterrupted.
        </p>

        <h3 className="font-bold">6. Modifications</h3>
        <p>
          The developers reserve the right to modify, suspend, or discontinue
          the App at any time without prior notice. We may also update these
          Terms of Use, and it is your responsibility to review them
          periodically.
        </p>
      </div>
    </div>
  );
};

export default TermsOfUse;
