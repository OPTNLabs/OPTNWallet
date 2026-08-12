export function isComingSoonApp(appId: string, appName: string): boolean {
  const normalizedId = appId.toLowerCase();
  const normalizedName = appName.toLowerCase();
  return (
    normalizedId.endsWith(':authguard') ||
    normalizedName === 'authguard' ||
    normalizedId.endsWith(':fundmeapp') ||
    normalizedName === 'fundme'
  );
}
