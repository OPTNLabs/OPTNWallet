import * as bip39 from 'bip39';

// This scenario mutates the local desktop wallet database. Keep it opt-in so
// the ordinary smoke suite never creates data in a developer's profile.
const runLifecycleTest =
  process.env.TAURI_E2E_ALLOW_MUTATION === '1' ? it : it.skip;

async function removePreviousLifecycleWallets(): Promise<void> {
  for (const label of await $$('p')) {
    const name = await label.getText();
    if (!/^E2E Lifecycle \d+$/.test(name)) continue;

    const card = label.$('../..');
    await card.$('button[aria-label^="Delete "]').click();
    await $('button=Delete').click();
    await label.waitForExist({ reverse: true, timeout: 10000 });
  }
}

runLifecycleTest(
  'creates a Chipnet wallet, locks it, rejects a wrong password, and reopens it',
  async () => {
    const walletName = `E2E Lifecycle ${Date.now()}`;
    const password = 'optn-e2e-lifecycle-password';
    const words = new Map<number, string>();

    await removePreviousLifecycleWallets();
    await $('a=Create New Wallet').click();
    await $('h1=Your Seed Phrase').waitForDisplayed({ timeout: 15000 });

    // Read the displayed words only into memory; never log or persist them.
    const seedText = await $('div.grid.grid-cols-2').getText();
    for (const match of seedText.matchAll(/(\d+)\.\s*([a-z]+)/g)) {
      words.set(Number(match[1]), match[2]);
    }
    expect(words.size).toBe(12);
    const mnemonic = Array.from({ length: 12 }, (_, index) =>
      words.get(index + 1)
    ).join(' ');
    expect(bip39.validateMnemonic(mnemonic, bip39.wordlists.english)).toBe(
      true
    );

    await $("button=I've written it down").click();
    await $('h1=Confirm Your Seed Phrase').waitForDisplayed({ timeout: 10000 });

    const confirmationRows = await $$('div.flex.items-center.gap-2');
    expect(confirmationRows.length).toBe(3);
    for (const row of confirmationRows) {
      const requestedWord = await row.$('span').getText();
      const index = Number(requestedWord.replace('Word ', ''));
      const word = words.get(index);
      expect(word).toBeDefined();
      const input = row.$('input');
      await input.setValue(word ?? '');
      await expect(input).toHaveValue(word ?? '');
    }

    await $('button=Confirm').click();
    await $('h1=Wallet Setup').waitForDisplayed({ timeout: 10000 });

    // Wallet creation E2E must stay on Chipnet/test funds.
    await $('[aria-label="Switch network. Current: Mainnet"]').click();
    await $('button=Continue').click();
    await $('h1=Name This Wallet').waitForDisplayed({ timeout: 10000 });

    await $('input[placeholder="Wallet name"]').setValue(walletName);
    await $('input[placeholder="Password (or leave blank)"]').setValue(
      password
    );
    await $('input[placeholder="Confirm password"]').setValue(password);
    await $('button=Create Wallet').click();
    await $('h1=Home').waitForExist({ timeout: 30000 });

    // Ctrl+L is the desktop menu shortcut and exercises the same lock path as
    // the native Wallet → Lock Wallet menu action.
    await browser.keys(['Control', 'l']);
    await $('h1=OPTN Wallet').waitForDisplayed({ timeout: 15000 });

    const walletLabel = await $(`p=${walletName}`);
    const walletCard = walletLabel.$('../..');
    await walletCard.$('button=Open').click();

    const passwordInput = await $('input[placeholder="Password"]');
    await passwordInput.setValue('wrong-password');
    await $('button=Unlock').click();
    await expect($('p=Incorrect password.')).toBeDisplayed();

    await passwordInput.setValue(password);
    await $('button=Unlock').click();
    await $('h1=Home').waitForExist({ timeout: 30000 });

    // Clean up the wallet created by this test so repeated runs remain safe.
    await browser.keys(['Control', 'l']);
    await $('h1=OPTN Wallet').waitForDisplayed({ timeout: 15000 });
    const createdWallet = await $(`p=${walletName}`);
    await createdWallet.$('../..').$('button[aria-label^="Delete "]').click();
    await $('button=Delete').click();
    await createdWallet.waitForExist({ reverse: true, timeout: 10000 });
  }
);
