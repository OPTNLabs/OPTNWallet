import { Navigate, useLocation } from 'react-router-dom';

import { getReturnPath } from '../utils/navigation';

export default function Paryon() {
  const location = useLocation();
  const returnTarget = getReturnPath(location, '/apps');

  return (
    <Navigate
      replace
      to="/apps/optn.builtin.demo:paryonWorkspaceApp"
      state={{
        ...(typeof location.state === 'object' && location.state != null
          ? location.state
          : {}),
        returnTo: returnTarget,
      }}
    />
  );
}
