# Event Addon Local Dev

Use this setup when developing the event flows locally.

## Services

Backend:

```bash
cd /home/lightswarm/projects/events-Backend
npm install
npm run dev
```

Wallet:

```bash
cd /home/lightswarm/projects/OPTNWallet
npm run dev
```

## Local URLs

- backend: `http://127.0.0.1:8787`
- wallet: `http://127.0.0.1:5173`

## Event addon behavior in local dev

When OPTN Wallet runs under Vite dev mode, the built-in event addon defaults to:

- `http://127.0.0.1:8787`

No rebuild is required for this local backend target.

You can still override the backend manually in the browser console:

```js
localStorage.setItem('optn.eventRewards.apiBaseUrl', 'http://127.0.0.1:8787');
```

To switch back to the hosted backend:

```js
localStorage.setItem('optn.eventRewards.apiBaseUrl', 'https://events.optnlabs.com');
```

To clear the override:

```js
localStorage.removeItem('optn.eventRewards.apiBaseUrl');
```

## Notes

- localhost HTTP access is allowed only for internal addons during local dev
- production addon traffic remains restricted to allowlisted HTTPS domains
- TokenIndex stays remote by default through `https://tokenindex.optnlabs.com`
