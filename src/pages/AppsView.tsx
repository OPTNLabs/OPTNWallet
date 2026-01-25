// src/pages/AppsView.tsx

import React, { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { RootState } from '../redux/store';

import AddonsRegistry from '../services/AddonsRegistry';

type AppCard = {
  id: string; // route id
  name: string;
  icon?: string | null;
  description?: string;
  source: 'builtin' | 'addon';
};

const AppsView: React.FC = () => {
  const navigate = useNavigate();
  const wallet_id = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );

  const [addonApps, setAddonApps] = useState<AppCard[]>([]);
  const [addonInitErr, setAddonInitErr] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const reg = AddonsRegistry();
        await reg.init();
        const apps = reg.getApps().map((a) => ({
          id: `addon:${a.fullId}`, // route-safe prefix
          name: a.name,
          icon: a.iconUri ?? null,
          description: a.description ?? '',
          source: 'addon' as const,
        }));
        if (mounted) setAddonApps(apps);
      } catch (e: any) {
        if (mounted) setAddonInitErr(e?.message ?? String(e));
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  const builtinApps: AppCard[] = useMemo(
    () => [
      {
        id: 'fundme',
        name: 'FundMe',
        icon: '/assets/images/fundme.png',
        description: 'BCH Crowdfunding',
        source: 'builtin',
      },
    ],
    []
  );

  const apps: AppCard[] = useMemo(
    () => [...builtinApps, ...addonApps],
    [builtinApps, addonApps]
  );

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

      <div className="flex justify-between items-center mb-6 mt-4">
        <h1 className="text-2xl font-bold">Apps</h1>
        <button
          onClick={() => navigate(`/home/${wallet_id}`)}
          className="bg-red-500 hover:bg-red-600 text-white py-2 px-4 rounded"
        >
          Go Back
        </button>
      </div>

      {addonInitErr && (
        <div className="mb-4 p-2 rounded border border-yellow-400 bg-yellow-50 text-sm">
          Addons failed to initialize: {addonInitErr}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {apps.map((app) => (
          <div
            key={app.id}
            onClick={() => handleAppClick(app.id)}
            className="p-4 border rounded-lg shadow hover:shadow-md transition-shadow cursor-pointer"
          >
            <div className="flex flex-col items-center">
              <img
                src={app.icon ?? '/assets/images/OPTNLogo.png'}
                alt={app.name}
                className="w-16 h-16 mb-2"
              />
              <h3 className="font-semibold text-center">{app.name}</h3>
              <p className="text-sm text-gray-600 text-center">
                {app.description}
              </p>
              <span className="mt-2 text-xs text-gray-500">
                {app.source === 'addon' ? 'Marketplace' : 'Built-in'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AppsView;
