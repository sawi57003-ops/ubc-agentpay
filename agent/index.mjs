// AgentPay agent — plans API calls, pays per call in USDC via the BudgetVault,
// and answers the user with receipts. Base Sepolia (testnet).
//
// Decision loop (documented for the UBC track requirements):
//   1. Parse the question into needed data (price / weather / news).
//   2. Fetch the API catalog (free) to learn prices + the payee up front.
//   3. Check the budget on-chain: remaining daily budget, per-call max,
//      approval threshold, and whether the payee is allowlisted.
//   4. For each call: if the price is above the approval threshold, queue a
//      vault requestPayment and STOP that call (owner must approve first).
//      Otherwise pay via vault.pay, then call the API with X-Payment: <tx>.
//   5. Answer with the data + a receipt for every payment.
//   Safety: never retry a failed payment, never pay a non-allowlisted payee,
//   never exceed the daily cap (the vault enforces it on-chain anyway).
import http from "node:http";
import fs from "node:fs";
import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";
const SERVER_URL = process.env.SERVER_URL || "http://localhost:8787";
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "";
const PORT = Number(process.env.PORT || 8788);

const KEY_PATH = new URL("./agent.key.json", import.meta.url).pathname;
let agentKey;
if (fs.existsSync(KEY_PATH)) {
  agentKey = JSON.parse(fs.readFileSync(KEY_PATH, "utf8")).privateKey;
} else {
  agentKey = ethers.Wallet.createRandom().privateKey;
  fs.writeFileSync(KEY_PATH, JSON.stringify({ privateKey: agentKey }, null, 2), { mode: 0o600 });
}
const provider = new ethers.JsonRpcProvider(RPC_URL);
const agentAddress = new ethers.Wallet(agentKey).address;
const agent = new ethers.NonceManager(new ethers.Wallet(agentKey, provider));

const VAULT_ABI = [
  "function pay(address to, uint256 amount) external",
  "function requestPayment(address to, uint256 amount) external returns (uint256)",
  "function approvePayment(uint256 id) external",
  "function executePayment(uint256 id) external",
  "function dailyCap() view returns (uint256)",
  "function perCallMax() view returns (uint256)",
  "function approvalThreshold() view returns (uint256)",
  "function payeeAllowed(address) view returns (bool)",
  "function remainingDaily() view returns (uint256)",
  "function dailySpent(uint256) view returns (uint256)",
  "function today() view returns (uint256)",
  "function pendingCount() view returns (uint256)",
  "function pendingPayments(uint256) view returns (address,uint256,bool,bool)",
];

function plan(question) {
  const q = question.toLowerCase();
  const calls = [];
  if (/(price|eth|btc|sol|token|bitcoin|ethereum|solana)/.test(q)) {
    const sym = /btc|bitcoin/.test(q) ? "BTC" : /sol|solana/.test(q) ? "SOL" : "ETH";
    calls.push({ api: "price", params: { symbol: sym } });
  }
  if (/weather/.test(q)) {
    const city = /singapore/.test(q) ? "Singapore" : /austin/.test(q) ? "Austin" : /london/.test(q) ? "London" : "Jakarta";
    calls.push({ api: "weather", params: { city } });
  }
  if (/news|headline/.test(q)) {
    const topic = /\bai\b/.test(q) ? "ai" : "crypto";
    calls.push({ api: "news", params: { topic } });
  }
  if (/research|deep dive|brief/.test(q)) {
    const topic = /\bai\b/.test(q) ? "ai" : "crypto";
    calls.push({ api: "research", params: { topic } });
  }
  return calls;
}

async function ask(question) {
  const calls = plan(question);
  const receipts = [];
  const results = [];
  const needsApproval = [];
  if (calls.length === 0) {
    return {
      answer: "I can check token prices, weather, and crypto/AI news — each costs a few cents in USDC. Try: 'What is the ETH price and the weather in Jakarta?'",
      receipts, results, needsApproval,
    };
  }
  if (!VAULT_ADDRESS) {
    return { answer: "Vault not deployed yet (set VAULT_ADDRESS).", receipts, results, needsApproval };
  }
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, agent);
  const catalogRes = await fetch(`${SERVER_URL}/api/catalog`);
  const catalog = await catalogRes.json();
  const [dailyCap, perCallMax, threshold, remaining] = await Promise.all([
    vault.dailyCap(), vault.perCallMax(), vault.approvalThreshold(), vault.remainingDaily(),
  ]);
  const budget = {
    dailyCap: Number(dailyCap) / 1e6,
    perCallMax: Number(perCallMax) / 1e6,
    approvalThreshold: Number(threshold) / 1e6,
    remainingDaily: remaining === BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") ? "unlimited" : Number(remaining) / 1e6,
  };

  for (const call of calls) {
    const info = catalog.apis[call.api];
    const price = info.priceUSDC * 1e6;
    const payee = catalog.payee;
    if (!(await vault.payeeAllowed(payee))) {
      results.push({ api: call.api, error: "payee not allowlisted — refusing to pay" });
      continue;
    }
    if (price > Number(perCallMax) && Number(perCallMax) > 0) {
      results.push({ api: call.api, error: `price $${info.priceUSDC} exceeds per-call max $${budget.perCallMax}` });
      continue;
    }
    if (price > Number(threshold)) {
      // Above the approval threshold: first look for an already-approved
      // pending payment for the same payee+amount and execute it; otherwise
      // queue a new request (owner must approve first).
      const count = Number(await vault.pendingCount());
      let executedTx = null;
      let queuedId = null;
      for (let i = 0; i < count; i++) {
        const p = await vault.pendingPayments(i);
        if (p[0].toLowerCase() !== payee.toLowerCase() || Number(p[1]) !== price) continue;
        if (p[2] && !p[3]) {
          const tx = await vault.executePayment(i);
          const rc = await tx.wait();
          executedTx = rc.hash;
          break;
        }
        if (!p[2] && !p[3]) queuedId = i;
      }
      if (executedTx) {
        receipts.push({ api: call.api, amountUSDC: info.priceUSDC, tx: executedTx });
        const query = new URLSearchParams(call.params).toString();
        const res = await fetch(`${SERVER_URL}/api/${call.api}?${query}`, {
          headers: { "X-Payment": executedTx },
        });
        const data = await res.json();
        results.push({ api: call.api, ...data });
        continue;
      }
      if (queuedId !== null) {
        results.push({ api: call.api, status: "already queued for owner approval", pendingId: queuedId });
        continue;
      }
      const tx = await vault.requestPayment(payee, price);
      const rc = await tx.wait();
      const id = Number(await vault.pendingCount()) - 1;
      needsApproval.push({ api: call.api, id, priceUSDC: info.priceUSDC, requestTx: rc.hash });
      results.push({ api: call.api, status: "queued for owner approval", pendingId: id });
      continue;
    }
    // Direct pay within limits.
    const tx = await vault.pay(payee, price);
    const rc = await tx.wait();
    receipts.push({ api: call.api, amountUSDC: info.priceUSDC, tx: rc.hash });
    const query = new URLSearchParams(call.params).toString();
    const res = await fetch(`${SERVER_URL}/api/${call.api}?${query}`, {
      headers: { "X-Payment": rc.hash },
    });
    const data = await res.json();
    results.push({ api: call.api, ...data });
  }

  const parts = results.map((r) => {
    if (r.api === "price" && r.priceUSD) return `ETH price: $${r.priceUSD}`;
    if (r.api === "price" && r.symbol) return `${r.symbol}: $${r.priceUSD}`;
    if (r.api === "weather") return `Weather in ${r.city}: ${r.tempC}°C, ${r.condition}`;
    if (r.api === "news") return `Headlines (${r.topic}): ${r.headlines.join(" | ")}`;
    if (r.api === "research") return `Research brief (${r.topic}): ${r.brief}`;
    if (r.status) return `${r.api}: ${r.status} (pending #${r.pendingId})`;
    return `${r.api}: ${r.error || "no data"}`;
  });
  return {
    answer: parts.join("\n"),
    budget,
    receipts,
    results,
    needsApproval,
    agent: agentAddress,
  };
}

// CLI: node index.mjs "question..."
if (process.argv[2]) {
  const out = await ask(process.argv.slice(2).join(" "));
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

// HTTP: POST /ask { question } — used by the web dashboard.
const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  res.setHeader("access-control-allow-origin", "*");
  if (req.method === "POST" && req.url === "/ask") {
    let body = "";
    for await (const c of req) body += c;
    try {
      const { question } = JSON.parse(body);
      const out = await ask(question || "");
      res.end(JSON.stringify(out));
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true, agent: agentAddress, vault: VAULT_ADDRESS || null }));
    return;
  }
  if (req.url === "/budget" && VAULT_ADDRESS) {
    try {
      const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);
      const [dailyCap, perCallMax, threshold, remaining, spent, day, pending] = await Promise.all([
        vault.dailyCap(), vault.perCallMax(), vault.approvalThreshold(),
        vault.remainingDaily(), vault.dailySpent(await vault.today()), vault.today(), vault.pendingCount(),
      ]);
      res.end(JSON.stringify({
        dailyCap: Number(dailyCap) / 1e6, perCallMax: Number(perCallMax) / 1e6,
        approvalThreshold: Number(threshold) / 1e6,
        remainingDaily: remaining === BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") ? "unlimited" : Number(remaining) / 1e6,
        spentToday: Number(spent) / 1e6, day: Number(day), pendingCount: Number(pending),
        agent: agentAddress, vault: VAULT_ADDRESS,
      }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (req.method === "POST" && req.url === "/approve") {
    // Demo shortcut: the agent process holds the owner key (OWNER_KEY env) so
    // the dashboard can approve. In production the owner signs from their own
    // wallet — the vault itself only accepts approvePayment from `owner`.
    const ownerKey = process.env.OWNER_KEY;
    if (!ownerKey || !VAULT_ADDRESS) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "owner key or vault not configured" }));
      return;
    }
    let body = "";
    for await (const c of req) body += c;
    try {
      const { id } = JSON.parse(body);
      const owner = new ethers.Wallet(ownerKey, provider);
      const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, owner);
      const tx = await vault.approvePayment(id);
      const rc = await tx.wait();
      res.end(JSON.stringify({ ok: true, tx: rc.hash }));
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  console.log(`AgentPay agent on :${PORT} — agent ${agentAddress} — vault ${VAULT_ADDRESS || "(not set)"}`);
});
