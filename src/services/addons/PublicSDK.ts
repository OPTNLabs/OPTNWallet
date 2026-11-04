/**
 * Public add-on SDK entrypoint.
 *
 * Keep this module limited to the third-party contract. Internal built-in
 * compatibility APIs remain in AddonsSDK.ts and must not be imported by
 * published add-ons.
 */
export {
  createPublicAddonSDK,
  type AddonPublicAuditEvent,
  type AddonPublicSDK,
  type AddonPublicToken,
  type AddonPublicUTXO,
  type AddonCashTokenIntent,
  type AddonTransactionProposal,
  type AddonExecutionOperation,
  type AddonExecutionResult,
  sanitizeAddonAuditEvent,
  sanitizeAddonUTXO,
} from '../AddonsSDK';
export {
  ADDON_SDK_VERSION,
  ADDON_SDK_PROTOCOL_VERSION,
  ADDON_SDK_FEATURES,
  ADDON_SDK_CASHTOKEN_INTENTS,
  ADDON_SDK_CASHTOKEN_LIMITS,
  ADDON_SDK_LIMITS,
  getAddonSDKInfo,
  type AddonSDKInfo,
  type AddonSDKModule,
} from './SDKContract';
export {
  createMockPublicAddonSDK,
  type MockAddonHostOptions,
} from './MockAddonHost';
