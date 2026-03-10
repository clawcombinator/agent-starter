// ============================================================
// Deprecated — this module has been superseded by the
// provider architecture in src/providers/.
//
// The Coinbase wallet is now a PaymentProvider adapter at
// src/providers/coinbase.ts. Registration happens in
// src/index.ts via PaymentRouter.registerProvider().
//
// This file is kept as a re-export shim for backwards
// compatibility. New code should import from providers/coinbase.ts
// directly.
// ============================================================

export { CoinbaseProvider as AgentWallet } from './providers/coinbase.js';
