import * as bip39 from 'bip39';

const merchantMnemonic = process.env.OPTN_MERCHANT_E2E_MNEMONIC?.trim() ?? '';
const allowBroadcast = process.env.OPTN_MERCHANT_E2E_ALLOW_BROADCAST === '1';

// The normal desktop suite must remain deterministic and non-mutating. The
// dedicated runner supplies the mnemonic and an isolated profile explicitly.
const runMerchantPaymentTest = merchantMnemonic ? it : it.skip;

async function clickButtonContaining(text: string): Promise<void> {
  const button = $(`button*=${text}`);
  await button.waitForDisplayed({ timeout: 30000 });
  await button.waitForEnabled({ timeout: 30000 });
  await button.click();
}

async function importChipnetTestWallet(): Promise<void> {
  const words = merchantMnemonic.split(/\s+/).filter(Boolean);
  expect(
    bip39.validateMnemonic(merchantMnemonic, bip39.wordlists.english)
  ).toBe(true);

  await $('a=Import Wallet').click();
  await $('h1=Import Wallet').waitForDisplayed({ timeout: 15000 });

  const phraseLength = $('select[aria-label="Phrase length"]');
  if (words.length !== 12) {
    await phraseLength.selectByAttribute('value', String(words.length));
  }

  const recoveryInputs = await $$('input[placeholder="word"]');
  expect(recoveryInputs).toHaveLength(words.length);
  for (const [index, input] of recoveryInputs.entries()) {
    await input.setValue(words[index]);
  }

  await $('button=Continue').click();
  await $('h1=Wallet Setup').waitForDisplayed({ timeout: 15000 });

  const mainnetSwitch = $('button[aria-label*="Current: Mainnet"]');
  if (await mainnetSwitch.isExisting()) await mainnetSwitch.click();

  await $('button=Continue').click();
  await $('h1=Name This Wallet').waitForDisplayed({ timeout: 10000 });

  const password = 'optn-merchant-chipnet-e2e-password';
  await $('input[placeholder="Wallet name"]').setValue(
    `Merchant Pay E2E ${Date.now()}`
  );
  await $('input[placeholder="Password (min 8 characters)"]').setValue(
    password
  );
  await $('input[placeholder="Confirm password"]').setValue(password);
  await $('button=Import Wallet').click();
  await $('h1=Home').waitForExist({ timeout: 60000 });
  console.log('[merchant-pay-e2e] wallet imported');
}

async function createMerchantProposal(): Promise<string> {
  console.log('[merchant-pay-e2e] opening Apps');
  await $('a[href="#/apps"]').click();
  await $('h1=Apps').waitForExist({ timeout: 15000 });
  console.log('[merchant-pay-e2e] Apps heading displayed');

  await clickButtonContaining('Merchant Pay');
  console.log('[merchant-pay-e2e] Merchant Pay opened');
  await $('h1=Merchant Pay').waitForDisplayed({ timeout: 15000 });
  // Merchant Pay now asks for the customer's incoming asset. Use a small BCH
  // amount so this exercises the BCH -> PUSD conversion route without tying
  // the test to a particular live exchange rate.
  for (const key of ['0', '.', '0', '2']) {
    const keyId = key === '.' ? 'decimal' : key;
    await $(`[data-testid="merchant-key-${keyId}"]`).click();
  }
  console.log('[merchant-pay-e2e] 0.02 BCH selected; waiting for quote');
  const createRequest = $('button*=Request');
  await createRequest.waitForEnabled({ timeout: 120000 });
  await createRequest.click();

  // Request creation revalidates the public LP outpoints and the merchant
  // address against Chipnet. Allow those bounded network reads to finish
  // before treating the request payload as missing. The QR itself is now
  // shown in a popup, and may use streamed frames when the payload is large.
  const qrCard = $('[data-merchant-proposal-payload]');
  await qrCard.waitForDisplayed({ timeout: 150000 });
  const payload = await qrCard.getAttribute('data-merchant-proposal-payload');
  expect(payload).toMatch(/^\{"application":/);
  return payload as string;
}

async function routeProposalThroughHome(payload: string): Promise<void> {
  await $('a[href^="#/home/"]').click();
  await $('h1=Home').waitForDisplayed({ timeout: 15000 });
  await $('button[aria-label="Scan QR"]').click();

  const payloadInput = $('[data-testid="home-scan-input"]');
  await payloadInput.setValue(payload);
  await $('[data-testid="home-scan-continue"]').click();

  await $('h1=Cauldron').waitForDisplayed({ timeout: 30000 });
  await $('[data-testid="merchant-payment-review"]').waitForDisplayed({
    timeout: 30000,
  });
  const reviewPayment = $('[data-testid="merchant-payment-review-cta"]');
  await reviewPayment.waitForEnabled({ timeout: 120000 });
  await reviewPayment.click();
}

async function slideToConfirm(): Promise<void> {
  const dialog = $('[role="dialog"][aria-label="Review Merchant Payment"]');
  await dialog.waitForDisplayed({ timeout: 15000 });

  const warningCheckbox = dialog.$('input[type="checkbox"]');
  if (await warningCheckbox.isDisplayed().catch(() => false)) {
    if (!(await warningCheckbox.isSelected().catch(() => false))) {
      await warningCheckbox.click();
    }
  }

  const track = dialog.$('[data-testid="swipe-confirm-track"]');
  const handle = dialog.$('[data-testid="swipe-confirm-handle"]');
  const trackLocation = await track.getLocation();
  const trackSize = await track.getSize();
  const handleLocation = await handle.getLocation();
  const handleSize = await handle.getSize();

  await browser.performActions([
    {
      type: 'pointer',
      id: 'merchant-payment-confirm',
      parameters: { pointerType: 'mouse' },
      actions: [
        {
          type: 'pointerMove',
          x: Math.round(handleLocation.x + handleSize.width / 2),
          y: Math.round(handleLocation.y + handleSize.height / 2),
        },
        { type: 'pointerDown', button: 0 },
        {
          type: 'pointerMove',
          x: Math.round(trackLocation.x + trackSize.width - 4),
          y: Math.round(trackLocation.y + trackSize.height / 2),
          duration: 500,
        },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
}

runMerchantPaymentTest(
  'builds a one-transaction Chipnet merchant payment through buyer review',
  async () => {
    await importChipnetTestWallet();
    const payload = await createMerchantProposal();
    await routeProposalThroughHome(payload);

    const reviewDialog = $(
      '[role="dialog"][aria-label="Review Merchant Payment"]'
    );
    await expect(reviewDialog).toBeDisplayed();
    await expect(reviewDialog).toHaveTextContaining('Merchant');
    await expect(reviewDialog).toHaveTextContaining('Change');

    // Review-only is the default. The broadcast branch is deliberately
    // opt-in because it consumes live Chipnet funds and cannot be run in CI.
    if (!allowBroadcast) return;

    await slideToConfirm();
    await $('div*=Merchant payment submitted').waitForDisplayed({
      timeout: 120000,
    });
  }
);
