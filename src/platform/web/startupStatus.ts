export type StartupStatusHandle = {
  setMessage: (message: string) => void;
  clear: () => void;
};

/** Shows an accessible progress state while embedded wallet WASM initializes. */
export function showStartupStatus(): StartupStatusHandle {
  const root = document.getElementById('root');
  if (!root) {
    return { setMessage: () => undefined, clear: () => undefined };
  }

  const status = document.createElement('div');
  status.className = 'startup-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const panel = document.createElement('div');
  panel.className = 'startup-status-panel';

  const brand = document.createElement('img');
  brand.className = 'startup-status-brand';
  brand.src = '/assets/images/OPTNWelcome1.png';
  brand.alt = '';
  brand.setAttribute('aria-hidden', 'true');

  const progress = document.createElement('div');
  progress.className = 'startup-status-progress';

  const spinner = document.createElement('span');
  spinner.className = 'wallet-spinner startup-status-indicator';
  spinner.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.textContent = 'Starting wallet…';
  progress.append(spinner, label);
  panel.append(brand, progress);
  status.append(panel);
  root.replaceChildren(status);

  return {
    setMessage: (message: string) => {
      label.textContent = message;
    },
    clear: () => {
      if (status.parentElement === root) status.remove();
    },
  };
}
