// Real smoke test proving the whole harness works end-to-end: Tauri launches,
// tauri-driver bridges WebDriver to it, and WebdriverIO can query the actual
// rendered DOM. This is deliberately scoped to "the app launches and shows
// its landing screen" rather than the mutation-gated create/lock/reopen wallet
// flow. The latter is covered by create-lock-reopen.spec.ts and stays opt-in
// because it creates local wallet data.
describe('OPTN Wallet desktop app', () => {
  it('launches and renders the landing screen', async () => {
    const heading = await $('h1=OPTN Wallet');
    await heading.waitForDisplayed({ timeout: 15000 });
    await expect(heading).toBeDisplayed();
  });
});
