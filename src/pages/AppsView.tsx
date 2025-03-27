// src/pages/AppsView.tsx

import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { RootState } from '../redux/store';

interface App {
  id: string;
  name: string;
  icon: string;
  description: string;
}

const AppsView = () => {
  const navigate = useNavigate();
  const wallet_id = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );

    // Apps data
    const apps: App[] = [
      {
        id: 'fundme',
        name: 'FundMe',
        icon: '/assets/images/fundme.png',
        description: 'BCH Crowdfunding'
      }
    ];

    const handleAppClick = (appId: string) => {
      navigate(`/apps/${appId}`);
    };

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-center mt-4">
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="Welcome"
          className="max-w-full h-auto"
        />
      </div>

      <div className="container mx-auto p-4">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Apps</h1>
        <button
          onClick={() => navigate(`/home/${wallet_id}`)}
          className="bg-red-500 hover:bg-red-600 text-white py-2 px-4 rounded"
        >
          Go Back
        </button>
      </div>

      {/* Grid of apps */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {apps.map((app) => (
          <div
            key={app.id}
            onClick={() => handleAppClick(app.id)}
            className="p-4 border rounded-lg shadow hover:shadow-md transition-shadow cursor-pointer"
          >
            <div className="flex flex-col items-center">
              <img src={app.icon} alt={app.name} className="w-16 h-16 mb-2" />
              <h3 className="font-semibold text-center">{app.name}</h3>
              <p className="text-sm text-gray-600 text-center">{app.description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
    </div>
  );
};

export default AppsView;
