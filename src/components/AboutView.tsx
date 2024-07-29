const AboutView = () => {
  return (
    <div>
      <h2 className="text-xl font-bold mb-2">About</h2>
      <p className="p-4 rounded-lg bg-gray-100">
        <strong>Overview</strong>
        <br />
        The OPTN wallet is a secure and easy-to-use application designed for
        managing your digital assets. It provides users with a range of
        functionalities to ensure seamless interaction with cryptocurrencies.
        <br />
        <br />
        <strong>Key Features</strong>
        <br />
        <ul className="list-disc list-inside">
          <li>
            <strong>Creating and Importing Wallets:</strong> Easily create new
            wallets or import existing ones to manage your assets.
          </li>
          <li>
            <strong>Viewing Contracts:</strong> Access and review smart
            contracts directly within the wallet interface.
          </li>
          <li>
            <strong>Building and Sending Transactions:</strong> Construct and
            send transactions with a user-friendly interface.
          </li>
          <li>
            <strong>Security:</strong> Implemented with transaction covenant
            security measures to protect your digital assets.
          </li>
        </ul>
        <br />
        <strong>Intended Use</strong>
        <br />
        The OPTN wallet is currently provided as a prototype for demonstration
        purposes. It is intended for investors and potential clients to evaluate
        its functionality and usability.
        <br />
        <br />
        <strong>Feedback and Support</strong>
        <br />
        We welcome feedback and inquiries regarding the OPTN wallet. Please
        refer to the contact information provided separately for any questions
        or support needs.
      </p>
    </div>
  );
};

export default AboutView;
