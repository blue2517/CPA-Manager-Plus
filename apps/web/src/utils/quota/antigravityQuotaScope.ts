import type { QuotaModelScope } from '@/types';

export const ANTIGRAVITY_ARGON_SCOPE = 'gemini_argon';
export const ANTIGRAVITY_NON_ARGON_SCOPE = 'gemini_non_argon';

// Use the provider's Argon name marker; no tier or model-ID mapping is needed.
export const isAntigravityArgonQuota = (identity: string): boolean =>
  identity.toLowerCase().includes('argon');

export const resolveAntigravityQuotaScope = (
  identity: string,
  fallback: QuotaModelScope,
  hasArgonQuota: boolean
): QuotaModelScope => {
  if (isAntigravityArgonQuota(identity)) {
    return { kind: 'family', key: ANTIGRAVITY_ARGON_SCOPE, complete: true };
  }
  if (
    /gemini/i.test(identity) &&
    (hasArgonQuota || (fallback.kind === 'family' && fallback.key === ANTIGRAVITY_NON_ARGON_SCOPE))
  ) {
    // An explicit model list must not bypass the account's separate quota pools.
    return {
      kind: 'family',
      key: hasArgonQuota ? ANTIGRAVITY_NON_ARGON_SCOPE : 'gemini',
      complete: true,
    };
  }
  return fallback;
};
