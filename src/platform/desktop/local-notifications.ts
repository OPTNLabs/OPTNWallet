// Desktop shim for @capacitor/local-notifications
// Uses the Web Notifications API (works in Tauri WebView with OS notification permission).

export type LocalNotificationSchema = {
  id: number;
  title: string;
  body: string;
  schedule?: { at?: Date };
  extra?: unknown;
};

async function requestWebNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
}

export const LocalNotifications = {
  requestPermissions: async () => {
    const perm = await requestWebNotificationPermission();
    return { display: perm === 'granted' ? 'granted' : 'denied' } as const;
  },

  checkPermissions: async () => {
    const perm = 'Notification' in window ? Notification.permission : 'denied';
    return { display: perm === 'granted' ? 'granted' : 'denied' } as const;
  },

  schedule: async ({ notifications }: { notifications: LocalNotificationSchema[] }) => {
    const perm = await requestWebNotificationPermission();
    if (perm !== 'granted') return { notifications: [] };
    for (const n of notifications) {
      new Notification(n.title, { body: n.body, icon: '/icons/128x128.png' });
    }
    return { notifications: notifications.map((n) => ({ id: n.id })) };
  },

  cancel: async () => {},
  getPending: async () => ({ notifications: [] }),
  registerActionTypes: async () => {},
  removeAllListeners: async () => {},

  addListener: (event: string, handler: (data: unknown) => void) => {
    void event;
    void handler;
    return Promise.resolve({ remove: async () => {} });
  },
};
