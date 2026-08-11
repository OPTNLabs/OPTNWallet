describe('OPTN Wallet create-wallet onboarding', () => {
  it('rejects incorrect seed confirmation and allows backing out before creation', async () => {
    await $('a=Create New Wallet').click();
    await $('h1=Your Seed Phrase').waitForDisplayed({ timeout: 15000 });

    // Verify the generated phrase is rendered without reading or logging its
    // contents. This test deliberately stops before any wallet is persisted.
    const seedRows = await $('div.grid.grid-cols-2').$$(
      'div.flex.items-center.mb-2'
    );
    expect(seedRows).toHaveLength(12);

    await $("button=I've written it down").click();
    await $('h1=Confirm Your Seed Phrase').waitForDisplayed({ timeout: 10000 });

    const confirmationRows = await $$('div.flex.items-center.gap-2');
    expect(confirmationRows).toHaveLength(3);
    for (const row of confirmationRows) {
      await row.$('input').setValue('not-the-requested-word');
    }

    await $('button=Confirm').click();
    await expect(
      $("p=Those don't match your seed phrase. Check the words and try again.")
    ).toBeDisplayed();
    await expect($('h1=Confirm Your Seed Phrase')).toBeDisplayed();

    await $('button=Back').click();
    await $('h1=Your Seed Phrase').waitForDisplayed({ timeout: 10000 });
    await $('button=Back').click();
    await expect($('h1=OPTN Wallet')).toBeDisplayed();
  });
});
