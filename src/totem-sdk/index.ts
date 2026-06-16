/**
 * @dreamshare/totem-sdk — framework-agnostic delegation mint + verify.
 *
 * Public surface. See docs/Totem_Integration.md §5 for the package boundary:
 * everything here is dependency-light (jose only) and NestJS/Cerebro-free, so it
 * can be extracted into the standalone Totem repo unchanged.
 */
export { mintDelegation } from './mint';
export type { MintDelegationOptions, SignKey } from './mint';
export { verifyDelegation } from './verify';
export type { KeyInput, VerifyDelegationOptions } from './verify';
export { commandPermits, isValidCommand, normalizeCommand } from './command';
export { evaluatePolicy, evaluatePredicate, globMatch, resolveSelector } from './policy';
export type {
  ActorClaim,
  Args,
  AttestationAnchor,
  AuthorizationDecisionRecord,
  DelegationClaims,
  DelegationGrant,
  DelegationResult,
  InvokedAction,
  NonceStore,
  PolicyValue,
  Predicate,
  RevocationRegistry,
  RevocationStatus,
  Selector,
} from './types';
