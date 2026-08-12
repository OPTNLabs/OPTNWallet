// src/components/ContactUs.tsx

import { FaTelegramPlane, FaGlobe, FaGithub } from 'react-icons/fa';
import { FiExternalLink } from 'react-icons/fi'; // External link icon

const ContactUs = () => {
  const contactMethods = [
    {
      name: 'Telegram',
      href: 'https://t.me/+KLBMsVW0xHY1YWI5',
      icon: <FaTelegramPlane size={24} />,
      tooltip: 'Join our Telegram group',
    },
    {
      name: 'Website',
      href: 'https://www.optnlabs.com/',
      icon: <FaGlobe size={24} />,
      tooltip: 'Visit our official website',
    },
    {
      name: 'GitHub',
      href: 'https://github.com/OPTNLabs/OPTNWallet',
      icon: <FaGithub size={24} />,
      tooltip: 'Check out our GitHub repository',
    },
  ];

  return (
    <div className="flex flex-col items-center justify-center max-h-full p-4 h-4/5 mb-4">
      {/* Image Section */}
      <div className="flex justify-center items-base line my-4">
        <img
          src="/assets/images/OPTNWelcome3.png"
          alt="Welcome"
          className="max-w-full h-auto"
          width={'68%'}
          height={'68%'}
        />
      </div>

      {/* Contact Methods */}
      <div className="w-full max-w-md space-y-4">
        {contactMethods.map((method) => (
          <a
            key={method.name}
            href={method.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={method.name}
            className="wallet-btn-primary flex items-center p-4 transition transform hover:scale-[1.01] focus:outline-none"
          >
            {/* Icon */}
            <div className="mr-4">{method.icon}</div>

            {/* Text */}
            <div className="flex-1 font-semibold text-lg">
              {method.name}
            </div>

            {/* External Link Indicator */}
            <div>
              <FiExternalLink size={20} />
            </div>
          </a>
        ))}
      </div>
    </div>
  );
};

export default ContactUs;
