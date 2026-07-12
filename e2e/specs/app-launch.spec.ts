// Real smoke test proving the whole harness works end-to-end: Tauri launches,
// tauri-driver bridges WebDriver to it, and WebdriverIO can query the actual
// rendered DOM. This is deliberately scoped to "the app launches and shows
// its landing screen" rather than the full create/lock/reopen wallet flow —
// that flow is a multi-step wizard (generate seed -> confirm seed words read
// back from the DOM -> set a password) that deserves its own spec once this
// harness is proven out, rather than a rushed first pass. See
// docs/e2e-testing.md for status and the next specs to add.
describe('OPTN Wallet desktop app', () => {
  it('launches and renders the landing screen', async () => {
    const heading = await $('h1=OPTN Wallet');
    await heading.waitForDisplayed({ timeout: 15000 });
    await expect(heading).toBeDisplayed();
  });
});
