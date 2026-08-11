describe('OPTN Wallet import-wallet onboarding', () => {
  it('validates phrase length, missing words, and invalid mnemonics without importing', async () => {
    await $('a=Import Wallet').click();
    await $('h1=Import Wallet').waitForDisplayed({ timeout: 10000 });

    const wordCount = $('select[aria-label="Phrase length"]');
    expect(await $$('input[placeholder="word"]')).toHaveLength(12);
    await wordCount.selectByAttribute('value', '24');
    expect(await $$('input[placeholder="word"]')).toHaveLength(24);

    await $('button=Continue').click();
    await expect($('p=Word 1 is missing.')).toBeDisplayed();

    const recoveryInputs = await $$('input[placeholder="word"]');
    for (const input of recoveryInputs) {
      await input.setValue('abandon');
    }
    await $('button=Continue').click();
    await expect(
      $(
        'p=Enter a valid English BIP39 recovery phrase with 12, 15, 18, 21, or 24 words.'
      )
    ).toBeDisplayed();
    await expect($('h1=Import Wallet')).toBeDisplayed();

    await wordCount.selectByAttribute('value', '12');
    const validPhrase =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const validInputs = await $$('input[placeholder="word"]');
    for (const [index, word] of validPhrase.split(' ').entries()) {
      await validInputs[index].setValue(word);
    }

    await $('button=Continue').click();
    await $('h1=Wallet Setup').waitForDisplayed({ timeout: 10000 });
    await $('button=Continue').click();
    await $('h1=Name This Wallet').waitForDisplayed({ timeout: 10000 });

    // Stop at form validation so createWalletWithPassword is never called.
    await $('button=Import Wallet').click();
    await expect($('p=Give this wallet a name.')).toBeDisplayed();

    await $('input[placeholder="Wallet name"]').setValue('E2E validation only');
    await $('input[placeholder="Password (or leave blank)"]').setValue(
      'e2e-password'
    );
    await $('input[placeholder="Confirm password"]').setValue(
      'different-password'
    );
    await $('button=Import Wallet').click();
    await expect($('p=Passwords do not match.')).toBeDisplayed();
  });
});
