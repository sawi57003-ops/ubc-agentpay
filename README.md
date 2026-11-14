# AgentPay

**An AI agent that pays per API call in USDC (x402) with on-chain budget guardrails.**

UBC 2026 — track: **Agentic Payments and AI**. Chain: **Base Sepolia** (testnet).
No prizes expected from Austin (remote team) — built as a working portfolio piece.

## The problem

AI agents are starting to act on their own: calling APIs, buying data, paying for
compute. But an agent with a wallet and no limits is a liability — one bad loop,
one prompt injection, and it drains the treasury. Existing agent wallets give the
agent the keys and hope for the best.

AgentPay gives the agent a wallet it **cannot** drain:

- The agent never holds the funds. USDC sits in an on-chain `BudgetVault`.
- Every payment is checked on-chain against four guardrails: a **daily cap**,
  a **per-call maximum**, a **payee allowlist**, and a **human-approval
  threshold** for large payments.
- Payments above the threshold go through a request → approve → execute flow;
  the owner approves from the dashboard, and the daily cap is re-checked at
  execution time (spending may have moved since approval).

## How it works

```
User asks a question
  -> Agent plans which paid APIs it needs (decision loop, see below)
  -> For each API call, the API answers HTTP 402 with an x402 payment request
  -> Agent pays from the BudgetVault (on-chain checks run first)
     - amount <= approval threshold: direct pay
     - amount >  threshold: request -> owner approves -> execute
  -> API verifies the USDC payment and serves the data
  -> Agent answers, and the dashboard shows every payment + remaining budget
```

### The agent's decision loop

1. **Parse** the user request into needed data (price, weather, news…).
2. **Plan** the cheapest set of API calls that answers it (each API lists its
   x402 price up front, so the agent can compare before paying).
3. **Check** the budget locally: remaining daily budget, per-call max, allowlist.
4. **Pay** per call through the vault (or queue an approval request if the call
   is above the threshold) and **never** retry a failed payment.
5. **Answer** with the data + a receipt (tx hash, amount, remaining budget).

### Safety limits (defaults on Base Sepolia)

| Limit | Default | Enforced |
|---|---|---|
| Daily cap | 10 USDC | on-chain, resets at UTC midnight |
| Per-call max | 1 USDC | on-chain |
| Approval threshold | 0.5 USDC | on-chain, request → approve → execute |
| Payee allowlist | paid APIs only | on-chain, owner-managed |
| Agent key | separate agent address | owner can rotate/revoke; funds stay in the vault |

## Repo layout

| Item | Hasil |
|---|---|
| `contracts/` | Foundry project: `BudgetVault.sol` + 11 tests |
| `server/` | Paid APIs behind x402 (price, weather, news) |
| `agent/` | The agent: planner + x402 payer + budget checks |
| `web/` | Dashboard: chat, budget, approval queue, tx history |

## Contracts

| Item | Hasil |
|---|---|
| BudgetVault (Base Sepolia) | TBD after deploy |
| USDC (Base Sepolia) | `0x036CbD53842c5426634e79217e7B053fC0e5bD9fa0` (Circle testnet USDC) |

## Run it

```bash
# contracts
cd contracts && forge test

# server + agent + web (Node 20+)
cd server && npm install && npm start
cd agent && npm install && npm start
cd web && npx serve .
```

## What to build next

- Per-service monthly budgets and a spend forecast.
- CCTP so the same vault can pay on any chain.
- A signed-policy mode: the owner pre-signs a policy (caps + allowlist) and the
  agent enforces it off-chain too, so a compromised agent key cannot even
  request an out-of-policy payment.
