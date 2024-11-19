const AboutView = () => {
  return (
    <div className="overflow-y-auto h-5/6">
      <div className="p-4 rounded-lg bg-gray-100">
        <strong>Overview</strong>
        <p>
          The OPTN wallet is a powerful and innovative application designed to
          enhance the security and flexibility of your digital asset
          transactions. By integrating Bitcoin covenants, it ensures robust
          management of your cryptocurrencies with state-of-the-art security
          measures.
        </p>

        <br />
        <strong>Key Features</strong>
        <ul className="list-disc list-inside">
          <li>
            <strong>Creating and Importing Wallets:</strong> Easily create new
            wallets or import existing ones to manage your assets seamlessly.
          </li>
          <li>
            <strong>Viewing Covenants:</strong> Access and review transaction
            covenants directly within the wallet interface, ensuring
            transparency and control.
          </li>
          <li>
            <strong>Building and Sending Transactions:</strong> Construct and
            send transactions with ease, leveraging covenant-enforced conditions
            for enhanced security.
          </li>
          <li>
            <strong>Security:</strong> Implemented with transaction covenant
            security measures to protect your digital assets against
            unauthorized transactions.
          </li>
        </ul>

        <br />
        <strong>Intended Use</strong>
        <p>
          The OPTN wallet is currently provided as a prototype for demonstration
          purposes. It is intended for investors and potential clients to
          evaluate its innovative functionality and user-centric design.
        </p>

        <br />
        <strong>Additional Information</strong>
        <ul className="list-disc list-inside">
          <li>
            <a href="https://covenants.info/" style={{ color: 'blue' }}>
              Bitcoin Covenants Wiki
            </a>
          </li>
          <li>
            <a
              href="https://next.cashscript.org/docs/guides/covenants"
              style={{ color: 'blue' }}
            >
              CashScript - Writing Covenants & Introspection
            </a>
          </li>
          <li>
            <a
              href="https://github.com/CashScript/cashscript/tree/master/examples"
              style={{ color: 'blue' }}
            >
              CashScript Covenant Examples
            </a>
          </li>
          <li>
            <a
              href="https://cointelegraph.com/news/what-are-bitcoin-covenants-and-how-do-they-work"
              style={{ color: 'blue' }}
            >
              Cointelegraph - What are Bitcoin covenants, and how do they work?
            </a>
          </li>
        </ul>
        <br />
        <strong>Feedback and Support</strong>
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
