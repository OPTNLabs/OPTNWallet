// src/services/Notify.ts
import { LocalNotifications } from '@capacitor/local-notifications';

export async function notifyNewUTXO(
  address: string,
  sats: number,
  txid: string
) {
  const id = Math.floor(Date.now() % 2147483647);
  await LocalNotifications.schedule({
    notifications: [
      {
        id,
        title: 'Funds received',
        body: `${sats} sats to ${address.slice(0, 8)}…`,
        channelId: 'utxo', // Android channel
        extra: { address, sats, txid },
      },
    ],
  });
}
