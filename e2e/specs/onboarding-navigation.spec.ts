describe('OPTN Wallet onboarding navigation', () => {
  it('opens the watch-only preview, validates empty input, and returns to the picker', async () => {
    const watchOnlyAction = await $('button=Create Watch-Only Wallet');
    await watchOnlyAction.waitForDisplayed({ timeout: 15000 });
    await watchOnlyAction.click();

    const heading = await $('h1=Watch-Only Wallet Preview');
    await heading.waitForDisplayed({ timeout: 10000 });
    await expect(heading).toBeDisplayed();

    await $('button=Preview public addresses').click();
    const validationError = await $('[role="alert"]');
    await validationError.waitForDisplayed({ timeout: 5000 });
    await expect(validationError).toHaveText('Enter a valid BCH account xPub.');

    await $('button=Back to wallets').click();
    const landingHeading = await $('h1=OPTN Wallet');
    await landingHeading.waitForDisplayed({ timeout: 10000 });
    await expect(landingHeading).toBeDisplayed();
  });
});
