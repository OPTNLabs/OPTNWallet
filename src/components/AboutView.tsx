const AboutView = () => {
  return (
    <div className="flex flex-col items-center justify-center p-4">
      {/* Content Card */}
      <div className="w-full max-w-2xl overflow-y-auto max-h-[65vh]">
        {/* Overview Section */}
        <h2 className="text-3xl font-bold mb-4">Overview</h2>
        <p className="mb-4">
          The OPTN Wallet App is a cutting-edge solution designed to give you
          unparalleled control and security over your digital assets. By
          leveraging <strong>Bitcoin covenants</strong>—advanced features that
          allow you to set custom rules for how your bitcoins can be spent—it
          ensures your funds are protected according to your preferences.
          Whether you're a seasoned crypto enthusiast or just starting out, OPTN
          offers a secure, flexible, and user-friendly way to manage your
          bitcoins.
        </p>

        {/* Key Features Section */}
        <h3 className="text-2xl font-bold mb-2">Key Features</h3>
        <ul className="list-disc list-inside mb-4">
          <li className="mb-2">
            <strong>Creating and Importing Wallets:</strong> Easily create new
            wallets or import existing ones to manage your assets seamlessly.
            Our wallet supports standard formats, ensuring compatibility with
            other Bitcoin wallets.
          </li>
          <li className="mb-2">
            <strong>Viewing Covenants:</strong> Access and review the specific
            rules (covenants) that govern your transactions. This transparency
            ensures you always know how your funds are protected.
          </li>
          <li className="mb-2">
            <strong>Building and Sending Transactions:</strong> Construct
            transactions with custom covenant conditions. Enforce rules like
            time locks, multi-signature requirements, or whitelisted addresses
            to enhance security.
          </li>
          <li className="mb-2">
            <strong>Security:</strong> Benefit from state-of-the-art security
            measures powered by Bitcoin covenants. Your assets are safeguarded
            against unauthorized transactions, giving you peace of mind.
          </li>
        </ul>

        {/* Why Choose OPTN Wallet Section */}
        <h3 className="text-2xl font-bold mb-2">Why Choose OPTN Wallet?</h3>
        <ul className="list-disc list-inside mb-4">
          <li className="mb-2">
            <strong>Unmatched Security:</strong> With Bitcoin covenants, you
            have the power to define exactly how your bitcoins can be spent.
          </li>
          <li className="mb-2">
            <strong>Flexibility:</strong> Tailor your wallet experience with
            custom transaction conditions.
          </li>
          <li className="mb-2">
            <strong>Intuitive Design:</strong> A user-friendly interface that
            makes managing your assets easy, even for beginners.
          </li>
          <li className="mb-2">
            <strong>Community Feedback:</strong> Built with input from our beta
            testers, ensuring it meets real user needs.
          </li>
        </ul>

        {/* Intended Use Section */}
        <h3 className="text-2xl font-bold mb-2">Intended Use</h3>
        <p className="mb-4">
          The OPTN wallet is now live and ready for you to securely manage your
          digital assets with advanced covenant features. Whether you're
          handling personal funds or exploring the power of Bitcoin covenants,
          OPTN provides a robust and accessible solution for all your needs.
        </p>

        {/* Additional Information Section */}
        <h3 className="text-2xl font-bold mb-2">
          Learn More About Bitcoin Covenants
        </h3>
        <p className="mb-4">
          Curious about Bitcoin covenants and how they work? Explore these
          resources to deepen your understanding:
        </p>
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
          Your feedback helps us improve the OPTN wallet. If you have
          suggestions, run into issues, or need support, please contact us at{' '}
          <a
            href="mailto:info@optnlabs.com"
            className="text-blue-600 hover:underline"
          >
            info@optnlabs.com
          </a>
          . We’re here to assist you!
        </p>
      </div>
    </div>
  );
};

export default AboutView;
