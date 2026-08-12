// Add this pattern inside renderApp() switch in src/pages/apps/MarketplaceAppHost.tsx

// 1) Import your app component near existing app imports.
// import ExampleAddonApp from './<your-addon>/ExampleAddonApp';

// 2) Add a case that matches manifest apps[].config.screen.
case 'ExampleAddonApp':
case 'example-app':
  return <ExampleAddonApp sdk={sdk} />;
