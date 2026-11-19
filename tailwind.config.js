module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx}', // Adjust this glob pattern according to your project's file structure
  ],
  theme: {
    extend: {
      spacing: {
        '50vh': '50vh', // Custom height class
        '36vw': '36vw',
        '12vw': '12vw',
        '24vw': '24vw',
        '64vh': '64vh',
        '16vh': '16vh',
        '8vh': '8vh',
        '2vw': '2vw',
        125: '500px',
      },
      maxWidth: {
        90: '90%',
      },
    },
  },
  plugins: [],
};
