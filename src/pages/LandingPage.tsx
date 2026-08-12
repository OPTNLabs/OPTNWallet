import { Link } from 'react-router-dom';

const LandingPage = () => {
  return (
    <section className="min-h-[100dvh] bg-gradient-to-br from-slate-600 via-slate-600 to-slate-600 flex flex-col justify-center items-center px-4">
      <div className="safe-area-top" />
      <main className="flex flex-col lg:flex-row items-center max-w-6xl mx-auto gap-8 lg:gap-12">
        {/* Image Section */}
        <div className="flex justify-center w-full lg:w-1/2">
          <img
            src={`${import.meta.env.BASE_URL}assets/images/OPTNWelcome1.png`}
            alt="Smart BCH Wallet"
            className="max-w-full h-auto w-3/4 lg:w-full object-contain transition-transform duration-300 hover:scale-105"
          />
        </div>
        {/* Text and CTA Section */}
        <div className="flex flex-col w-full lg:w-1/2 items-center lg:items-start text-center lg:text-left">
          {/* <h1 className="text-3xl lg:text-5xl font-bold text-white mb-4 tracking-tight">
            Bitcoin Cash Wallet
          </h1> */}
          <h1 className="text-lg font-bold lg:text-xl text-gray-200 mx-12 max-w-md">
            Powered with Bitcoin Covenants for Bitcoin Cash
          </h1>
          <div className="flex flex-col sm:flex-row gap-4 mt-20">
            <Link
              to="/createwallet"
              className="bg-white text-black font-semibold py-3 px-24 rounded-lg mx-4 my-4 shadow-md"
            >
              Create Wallet
            </Link>
            <Link
              to="/importwallet"
              className="bg-white text-black font-semibold py-3 px-24 rounded-lg mx-4 my-4 shadow-md"
            >
              Import Wallet
            </Link>
          </div>
        </div>
      </main>
      <div className="safe-area-bottom" />
    </section>
  );
};

export default LandingPage;
