describe('OPTN Wallet import-wallet onboarding', () => {
  it('validates phrase length, missing words, and invalid mnemonics without importing', async () => {
    await $('a=Import Wallet').click();
    await $('h1=Import Wallet').waitForDisplayed({ timeout: 10000 });

    const wordCount = $('select[aria-label="Phrase length"]');
    expect(await $$('input[placeholder="word"]')).toHaveLength(12);
    await wordCount.selectByAttribute('value', '24');
    expect(await $$('input[placeholder="word"]')).toHaveLength(24);

    const continueButton = () => $('button=Continue');
    await continueButton().waitForDisplayed({ timeout: 10000 });
    await continueButton().click();
    await expect($('p=Word 1 is missing.')).toBeDisplayed();

    const recoveryInputs = await $$('input[placeholder="word"]');
    for (const input of recoveryInputs) {
      await input.setValue('abandon');
    }
    await continueButton().click();
    await expect(
      $(
        'p=Enter a valid English BIP39 recovery phrase with 12, 15, 18, 21, or 24 words.'
      )
    ).toBeDisplayed();
    await expect($('h1=Import Wallet')).toBeDisplayed();

    // Do not enter the valid phrase here: the next desktop step performs live
    // Electrum derivation discovery, which is covered by unit/UI tests and is
    // intentionally outside this deterministic desktop smoke suite.
    await $('button=Back').click();
    await $('h1=OPTN Wallet').waitForDisplayed({ timeout: 10000 });
  });
});
