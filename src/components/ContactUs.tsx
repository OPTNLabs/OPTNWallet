// @ts-expect-error
// src/components/ContactUs.tsx

import React from 'react';

const ContactUs = () => {
  return (
    <div>
      <p className="border p-4 rounded-lg bg-gray-100">
        Telegram
        <br />
        <a href="https://t.me/+KLBMsVW0xHY1YWI5" className="text-sky-600">
          https://t.me/+KLBMsVW0xHY1YWI5
        </a>
        <br />
        <br />
        Website
        <br />
        <a href="https://optn-website.vercel.app/" className="text-sky-600">
          https://optn-website.vercel.app/
        </a>
        <br />
        <br />
        GitHub
        <br />
        <a
          href="https://github.com/BitcoinBay/OPTNWallet"
          className="text-sky-600"
        >
          https://github.com/BitcoinBay/OPTNWallet
        </a>
      </p>
      <div className="flex justify-center mt-4">
        <img
          src="/assets/images/OPTNWelcome2.png"
          alt="Welcome"
          className="max-w-full h-auto"
        />
      </div>
    </div>
  );
};

export default ContactUs;
