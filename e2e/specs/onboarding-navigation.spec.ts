describe('OPTN Wallet onboarding navigation', () => {
  it('opens watch-only setup, enforces required fields, and returns to the picker', async () => {
    const watchOnlyAction = await $('button=Create Watch-Only Wallet');
    await watchOnlyAction.waitForDisplayed({ timeout: 15000 });
    await watchOnlyAction.click();

    const heading = await $('h1=Create Watch-Only Wallet');
    await heading.waitForDisplayed({ timeout: 10000 });
    await expect(heading).toBeDisplayed();

    const saveButton = await $('button=Save and open wallet');
    await expect(saveButton).toBeDisabled();
    await $('input:not([type])').setValue('E2E watch-only validation');
    const passwordInputs = await $$('input[type="password"]');
    await expect(passwordInputs).toHaveLength(2);
    await passwordInputs[0].setValue('e2e-password');
    await passwordInputs[1].setValue('e2e-password');
    await expect(saveButton).toBeDisabled();

    await $('button=Back to wallets').click();
    const landingHeading = await $('h1=OPTN Wallet');
    await landingHeading.waitForDisplayed({ timeout: 10000 });
    await expect(landingHeading).toBeDisplayed();
  });
});
