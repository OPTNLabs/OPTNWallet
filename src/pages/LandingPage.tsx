import { Link } from 'react-router-dom';
// import NavBar from '../components/NavBar';

const LandingPage = () => {
  return (
    <>
      <section className="min-h-screen bg-black flex flex-col">
        {/* <NavBar /> */}
        <div className="flex flex-col lg:flex-row mt-16 lg:mt-64 mx-4 lg:mx-20">
          <div className="flex flex-col w-full lg:w-1/2 lg:pr-4">
            <div className="text-white font-bold text-4xl lg:text-7xl text-center lg:text-left">
              OPTN Wallet
            </div>
            <div className="text-white text-base lg:text-xl mt-4 text-center lg:text-left">
              <h3>In-Development</h3>
              <p>Wallet for Transaction Covenants</p>
            </div>

            {/* Add the image here */}
            <div className="flex justify-center mt-4">
              <img
                src="/public/OPTNWelcome1.png"
                alt="Welcome"
                className="max-w-full h-auto"
              />
            </div>

            <div className="flex flex-row mt-4 justify-center lg:justify-start">
              <Link
                to="/createwallet"
                className="bg-white mr-4 text-gray-800 font-semibold py-2 px-4 border-gray-400 rounded-xl text-center"
              >
                Create Wallet
              </Link>
              <Link
                to="/importwallet"
                className="bg-white text-gray-800 font-semibold py-2 px-4 border-gray-400 rounded-xl text-center"
              >
                Import Wallet
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
};

export default LandingPage;
