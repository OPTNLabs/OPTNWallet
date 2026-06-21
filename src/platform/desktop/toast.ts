// Desktop shim for @capacitor/toast
// Renders a bottom-center auto-dismiss toast that matches the Capacitor Toast UX

let toastEl: HTMLDivElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showDesktopToast(text: string, duration: 'short' | 'long' = 'short') {
  if (toastEl) {
    document.body.removeChild(toastEl);
    if (toastTimer) clearTimeout(toastTimer);
  }

  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = [
    'position:fixed',
    'bottom:80px',
    'left:50%',
    'transform:translateX(-50%)',
    'background:rgba(30,50,40,0.92)',
    'color:#fff',
    'padding:10px 20px',
    'border-radius:24px',
    'font-size:14px',
    'font-family:inherit',
    'z-index:99999',
    'pointer-events:none',
    'white-space:nowrap',
    'box-shadow:0 4px 16px rgba(0,0,0,0.18)',
    'transition:opacity 0.3s',
    'opacity:1',
  ].join(';');

  document.body.appendChild(el);
  toastEl = el;

  const ms = duration === 'long' ? 3500 : 2500;
  toastTimer = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
      if (toastEl === el) toastEl = null;
    }, 300);
  }, ms);
}

export const Toast = {
  show: ({ text, duration }: { text: string; duration?: 'short' | 'long' }) => {
    showDesktopToast(text, duration ?? 'short');
    return Promise.resolve();
  },
};
