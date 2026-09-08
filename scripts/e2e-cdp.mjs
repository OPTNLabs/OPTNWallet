// Keep page code separate from values (including wallet inputs). CDP handles
// argument serialization; values must never be interpolated into source text.
export async function callPageFunction(client, callback, ...args) {
  if (typeof callback !== 'function') {
    throw new TypeError('Page callback must be a function');
  }
  const context = await client.command('Runtime.evaluate', {
    expression: 'globalThis',
    returnByValue: false,
  });
  const objectId = context.result?.result?.objectId;
  if (context.result?.exceptionDetails || !objectId) {
    throw new Error('WebView execution context is unavailable');
  }
  try {
    const response = await client.command('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: callback.toString(),
      arguments: args.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.result?.exceptionDetails) {
      // Exception details can contain input values. Keep them out of logs.
      throw new Error('WebView function call failed');
    }
    return response.result?.result?.value;
  } finally {
    // Navigation can destroy the context before cleanup reaches it.
    await client
      .command('Runtime.releaseObject', { objectId })
      .catch(() => undefined);
  }
}
