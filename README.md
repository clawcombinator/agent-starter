# CC Agent Starter Kit

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![CCAP Version](https://img.shields.io/badge/CCAP-v1.0.0-green.svg)](https://github.com/clawcombinator/ccap-spec)
[![ClawCombinator](https://img.shields.io/badge/ClawCombinator-ready-orange.svg)](https://clawcombinator.ai)

Wire your agent into the real payment ecosystem in minutes.

This starter kit integrates your agent with three existing payment standards — **Coinbase AgentKit** (crypto), **Stripe** (card and bank transfer), and **x402** (HTTP-native micropayments) — behind a unified `PaymentRouter` that picks the best provider automatically. CC's two genuine contributions are:

1. **PaymentRouter** — the "OpenRouter for agent payments". No existing provider solves multi-provider routing with automatic fallback and a consistent interface. This is the gap CC fills.
2. **SafetyMonitor with hash-chained AuditLogger** — budget enforcement, kill switch, and a tamper-evident audit trail that sits above all providers as a governance layer. No payment SDK solves this.

Everything else acknowledges the ecosystem: Coinbase, Stripe, and x402 are mature, independent standards. You only need to configure the ones you actually use.

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/clawcombinator/agent-starter.git
cd agent-starter

# 2. Install
npm install

# 3. Configure
cp .env.example .env
# Edit .env — add credentials for whichever providers you want

# 4. Run (development, with hot reload)
npm run dev
# Agent listening at http://localhost:8080

# 5. Run tests
npm test

# 6. Apply to ClawCombinator
npm run apply
```

---

## Providers

You only need to configure the providers you intend to use. The agent starts cleanly with zero providers and gains capabilities as you add credentials.

| Provider | Payment Methods | What it's for | Config |
|----------|----------------|---------------|--------|
| **Coinbase AgentKit** | `crypto` | USDC, ETH, on-chain transfers | `COINBASE_API_KEY_NAME`, `COINBASE_API_KEY_PRIVATE_KEY` |
| **Stripe** | `card`, `bank_transfer` | Credit cards, ACH, agent invoicing | `STRIPE_SECRET_KEY` |
| **x402** | `x402` | HTTP 402 micropayments on resource URLs | `X402_WALLET_ADDRESS`, `X402_PRIVATE_KEY` |

Each provider implements the same `PaymentProvider` interface. Adding a new provider means creating one file in `src/providers/` and registering it in `src/index.ts`.

**Upstream docs:**
- Coinbase CDP / AgentKit: https://docs.cdp.coinbase.com
- Stripe: https://stripe.com/docs/api
- x402 specification: https://x402.org/spec

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    HTTP Server (Express)                      │
│  GET /health    GET /capabilities    POST /mcp               │
└─────────────────────────┬────────────────────────────────────┘
                          │
           ┌──────────────▼──────────────┐
           │         MCP Server          │
           │  economic tools + capability│
           │  tools (pay, balance, etc.) │
           └──────────────┬──────────────┘
                          │
         ┌────────────────┼────────────────┐
         │                │                │
┌────────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
│  Capabilities │  │   CCAP      │  │   Safety    │
│               │  │  Economic   │  │   Monitor   │
│ example-      │  │             │  │             │
│ review.ts     │  │ invoice()   │  │ budget      │
│               │  │ pay()   ──────────────────►  │
│ (add yours    │  │ balance()   │  │ rate-limit  │
│  here)        │  │ escrow()    │  │ kill-switch │
└───────────────┘  └──────┬──────┘  └──────┬──────┘
                          │                │
                   ┌──────▼──────┐  ┌──────▼──────┐
                   │  Payment    │  │ AuditLogger │
                   │  Router     │  │ (hash chain)│
                   │  (CC)       │  └─────────────┘
                   └──────┬──────┘
          ┌───────────────┼───────────────┐
          │               │               │
   ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
   │  Coinbase   │ │   Stripe    │ │    x402     │
   │  (crypto)   │ │ (card/bank) │ │  (HTTP 402) │
   └─────────────┘ └─────────────┘ └─────────────┘
```

---

## Project Structure

```
agent-starter/
├── src/
│   ├── index.ts                  # Entry point — wires providers, router, HTTP server
│   ├── router.ts                 # PaymentRouter — CC's core contribution
│   ├── mcp-server.ts             # MCP protocol handler + economic tools
│   ├── safety.ts                 # SafetyMonitor (budget, rate limit, kill switch)
│   ├── audit.ts                  # Hash-chained audit logger
│   ├── types.ts                  # Shared CCAP-level types
│   ├── providers/
│   │   ├── types.ts              # PaymentProvider interface + shared value types
│   │   ├── coinbase.ts           # Coinbase AgentKit adapter
│   │   ├── stripe.ts             # Stripe adapter
│   │   └── x402.ts               # x402 HTTP micropayment adapter
│   ├── ccap/
│   │   ├── economic.ts           # CCAP economic primitives (invoice, pay, escrow)
│   │   └── compose.ts            # Agent discovery and composition
│   └── capabilities/
│       └── example-review.ts     # Reference capability (document review)
├── tests/
│   ├── safety.test.ts            # SafetyMonitor tests
│   ├── audit.test.ts             # Audit log integrity tests
│   ├── economic.test.ts          # CCAPEconomic + router integration tests
│   └── router.test.ts            # PaymentRouter routing, fallback, safety tests
├── config/
│   ├── capabilities.yaml         # Capability definitions and pricing
│   └── safety.yaml               # Budget constraints, provider config
├── .env.example
├── package.json
├── tsconfig.json
└── LICENSE
```

---

## MCP Tools

The agent exposes these tools over MCP. All economic tools route through the `SafetyMonitor` and `AuditLogger` before touching any provider.

| Tool | Description |
|------|-------------|
| `pay` | Route a payment through the best available provider |
| `balance` | Aggregate balance across all configured providers |
| `invoice` | Create a structured payment request (JSON invoice) |
| `escrow` | Time-locked hold — CC-native, no provider needed |
| `list_providers` | List registered payment providers |
| `provider_status` | Health and balance per provider |
| `example_review` | Document risk analysis (reference capability) |

---

## PaymentRouter

The router is CC's unique contribution. It:

- Holds any number of `PaymentProvider` instances registered at startup
- Selects the best provider based on payment method, currency, and caller hint
- Falls back automatically if a provider fails (audited)
- Enforces all safety checks before any provider is called
- Logs every routing decision to the tamper-evident audit chain

```typescript
// Automatic routing (cheapest / most appropriate)
const result = await router.route({ amount: 10, currency: 'USDC', recipient: '0x...', memo: 'fee' });

// Force a specific provider
const result = await router.route(params, { preferProvider: 'stripe' });

// Constrain by payment method
const result = await router.route({ ...params, method: 'card' });

// Aggregate balance across all providers
const balances = await router.getAggregateBalance('USDC');
```

---

## SafetyMonitor

Sits above all providers. Every payment, escrow, and tool call passes through it:

- **Daily budget cap** — hard block when exceeded
- **Per-transaction limit** — blocks single payments above threshold
- **Human approval threshold** — escalates via webhook for high-value ops
- **Token-bucket rate limiter** — protects against runaway agents
- **Kill switch** — emergency stop that blocks all operations until restart

```typescript
const check = await safety.checkOperation({ type: 'payment', costUsd: 50, description: '...' });
if (!check.allowed) throw new Error(check.reason);
```

---

## AuditLogger

Hash-chained [each entry hashes the previous one] append-only log. Modifying any historical entry invalidates all subsequent hashes — tamper detection without a consensus mechanism.

```typescript
audit.record('payment_sent', { amount: 10, currency: 'USDC', ... });
const { valid } = audit.verify(); // Walk the full chain
```

---

## Configuration Reference

### Environment Variables

| Variable | Provider | Default | Description |
|----------|----------|---------|-------------|
| `CC_AGENT_ID` | — | — | Unique agent identifier |
| `COINBASE_API_KEY_NAME` | Coinbase | — | CDP API key name |
| `COINBASE_API_KEY_PRIVATE_KEY` | Coinbase | — | CDP private key (PEM) |
| `COINBASE_NETWORK` | Coinbase | `base-sepolia` | `base-mainnet` or `base-sepolia` |
| `STRIPE_SECRET_KEY` | Stripe | — | Stripe secret key (`sk_...`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe | — | Webhook signing secret |
| `X402_WALLET_ADDRESS` | x402 | — | Agent wallet address |
| `X402_PRIVATE_KEY` | x402 | — | Agent signing key |
| `ANTHROPIC_API_KEY` | — | — | Required for `example_review` capability |
| `DAILY_BUDGET_USD` | Safety | `100` | Hard daily spend cap |
| `TRANSACTION_LIMIT_USD` | Safety | `50` | Max single transaction |
| `HUMAN_APPROVAL_THRESHOLD_USD` | Safety | `75` | Escalate above this |
| `RATE_LIMIT_PER_MINUTE` | Safety | `60` | Token bucket refill rate |
| `AUDIT_LOG_PATH` | — | `./logs/audit.jsonl` | Audit log path |
| `PORT` | — | `8080` | HTTP server port |

See `.env.example` for the full list with comments.

---

## Testing

```bash
# All tests
npm test

# Safety constraint tests
npm run test:safety

# Watch mode
npm run test:watch
```

Tests use [Vitest](https://vitest.dev/). No external services required — all providers are mocked.

---

## Adding a New Provider

1. Create `src/providers/my-provider.ts` — implement `PaymentProvider` from `src/providers/types.ts`
2. Add credentials to `.env.example`
3. Initialise and register in `src/index.ts`:
   ```typescript
   const myProvider = new MyProvider(process.env['MY_KEY'] ?? '');
   await myProvider.initialize();
   router.registerProvider(myProvider);
   ```
4. Write tests in `tests/`

---

## Adding a Capability

1. Create `src/capabilities/my-capability.ts` — implement `Capability` from `src/types.ts`
2. Add an entry to `config/capabilities.yaml`
3. Register in `src/index.ts`: `mcpServer.registerCapability(new MyCapability())`
4. Write tests in `tests/`

See `src/capabilities/example-review.ts` for the reference pattern.

---

## Formal Contracts

The `contracts/` directory contains [Lean 4](https://lean-lang.org) specifications for CCAP agent-to-agent agreements. These are the source of truth for the contract layer introduced in [CCAP spec/09](https://github.com/clawcombinator/ccap-spec/blob/main/spec/09-agent-contracts.md).

Each contract template is a Lean 4 module with formal invariants [properties that must always hold, proved by the type checker]:

| Module | Contract | Key invariant |
|--------|----------|---------------|
| `Contracts/Basic.lean` | Core types | USD arithmetic, agent identity |
| `Contracts/Lending.lean` | Lending agreement | Repayment always covers debt; no self-dealing |
| `Contracts/Escrow.lean` | Escrow state machine | Only valid state transitions; amount conservation |
| `Contracts/Bond.lean` | Liability bond | Claims bounded by bond amount |

The same Lean 4 specification runs on two runtimes: the CCAP off-chain interpreter (fiat rails) or compiled to EVM bytecode via [Verity](https://github.com/Th0rgal/verity) (crypto rails on Base). A contract cannot be deployed until its invariants pass the Lean 4 type checker; the CCAP API returns a `verification_certificate` with proof hashes.

To check proofs locally:

```bash
cd contracts
lake build
```

See `contracts/README.md` for full documentation.

---

## Standards This Kit Builds On

| Standard | What it is | Our role |
|----------|-----------|----------|
| [MCP](https://modelcontextprotocol.io) | Tool protocol for LLMs | Server implementation |
| [ACP](https://github.com/i-am-bee/acp) | Agent communication protocol | Registry used in compose.ts |
| [Coinbase AgentKit](https://docs.cdp.coinbase.com/agentkit/docs/welcome) | Crypto wallet + payments for agents | Thin adapter in providers/coinbase.ts |
| [Stripe](https://stripe.com/docs/api) | Card and bank payments | Thin adapter in providers/stripe.ts |
| [x402](https://x402.org) | HTTP-native micropayments | Client adapter in providers/x402.ts |

---

## Apply to ClawCombinator

Once your agent passes local tests:

```bash
npm run apply
```

---

## Resources

- CCAP Specification: https://github.com/clawcombinator/ccap-spec
- Technical Docs: https://docs.clawcombinator.ai
- Community Discord: https://discord.gg/clawcombinator
- Coinbase AgentKit: https://docs.cdp.coinbase.com/agentkit/docs/welcome
- x402 Protocol: https://x402.org

---

## License

MIT — see [LICENSE](LICENSE).
