// @ts-expect-error
// src/components/ContactUs.tsx

import React from 'react';

const ContactUs = () => {
  return (
    <div>
      <p className="border p-4 rounded-lg bg-gray-100">
        Email: contact@example.com
        <br />
        Telegram: @example
        <br />
        Discord: example#1234
      </p>
    </div>
  );
};

export default ContactUs;
