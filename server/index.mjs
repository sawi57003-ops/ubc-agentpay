// AgentPay server — paid APIs behind x402 (Base Sepolia, USDC).
// The data here is mock (deterministic, no external API keys): the point of the
// demo is the payment flow, not the data source. Swap in real providers later.
//
// x402 flow (simplified "exact" scheme):
//   1. Client calls GET /api/<name> with no X-Payment header.
//   2. Server answers HTTP 402 with the payment terms (amount, asset, payee).
//   3. Client pays USDC to the payee (via the BudgetVault) and retries with
//      X-Payment: <txHash>.
//   4. Server verifies the tx on-chain (Transfer of `amount` USDC to payee,
//      tx hash never reused) and serves the data.
import http from "node:http";
import { ethers } from "ethers";
import fs from "node:fs";

const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";
const PORT = Number(process.env.PORT || 8787);
const USDC = process.env.USDC || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "base-sepolia";

// Server payee key: testnet only, generated at first run, never committed.
const KEY_PATH = new URL("./payee.key.json", import.meta.url).pathname;
let payeeKey;
if (fs.existsSync(KEY_PATH)) {
  payeeKey = JSON.parse(fs.readFileSync(KEY_PATH, "utf8")).privateKey;
} else {
  payeeKey = ethers.Wallet.createRandom().privateKey;
  fs.writeFileSync(KEY_PATH, JSON.stringify({ privateKey: payeeKey }, null, 2), { mode: 0o600 });
}
const payee = new ethers.Wallet(payeeKey).address;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];
const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);
const usedTx = new Set();

// Mock data (deterministic). Prices are illustrative, not live quotes.
const PRICES = { ETH: 3120.5, BTC: 97400, SOL: 168.25, USDC: 1.0 };
const WEATHER = {
  Jakarta: { tempC: 31, condition: "Partly cloudy", humidity: 72 },
  Singapore: { tempC: 29, condition: "Thunderstorms", humidity: 84 },
  Austin: { tempC: 24, condition: "Sunny", humidity: 41 },
  London: { tempC: 11, condition: "Rain", humidity: 88 },
};
const NEWS = {
  crypto: [
    "Base Sepolia testnet sees record x402 micropayments in hackathon week",
    "Circle ships new testnet USDC faucet limits",
    "Agent wallets: the case for on-chain spending guardrails",
  ],
  ai: [
    "Agentic commerce: agents now pay per API call",
    "New study: budget caps cut agent overspend by 94%",
  ],
};

const APIS = {
  price: { price: 10_000, desc: "Token price (ETH, BTC, SOL, USDC)", params: ["symbol"] },
  weather: { price: 10_000, desc: "Current weather for a city", params: ["city"] },
  news: { price: 20_000, desc: "Latest headlines by topic", params: ["topic"] },
  research: { price: 750_000, desc: "Deep research brief on a topic (above the approval threshold)", params: ["topic"] },
};

function catalog() {
  return {
    network: NETWORK,
    asset: USDC,
    payee,
    apis: Object.fromEntries(
      Object.entries(APIS).map(([name, a]) => [
        name,
        { priceUSDC: a.price / 1e6, params: a.params, desc: a.desc, url: `/api/${name}` },
      ])
    ),
  };
}

function paymentRequired(name) {
  const api = APIS[name];
  return {
    x402Version: 1,
    error: "Payment Required",
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: String(api.price),
        asset: USDC,
        payee,
        maxTimeoutSeconds: 600,
        description: api.desc,
      },
    ],
  };
}

async function verifyPayment(txHash, amount) {
  if (!txHash || usedTx.has(txHash)) return { ok: false, reason: usedTx.has(txHash) ? "tx already used" : "no tx" };
  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch {
    return { ok: false, reason: "receipt lookup failed" };
  }
  if (!receipt || receipt.status !== 1) return { ok: false, reason: "tx not confirmed" };
  // Find a USDC Transfer to the payee for exactly `amount` in this receipt.
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDC.toLowerCase()) continue;
    try {
      const parsed = usdc.interface.parseLog(log);
      if (
        parsed.name === "Transfer" &&
        parsed.args.to.toLowerCase() === payee.toLowerCase() &&
        parsed.args.value === BigInt(amount)
      ) {
        usedTx.add(txHash);
        return { ok: true, from: parsed.args.from };
      }
    } catch {
      // not a Transfer log, ignore
    }
  }
  return { ok: false, reason: "no matching USDC transfer to payee" };
}

function dataFor(name, q) {
  if (name === "price") {
    const symbol = (q.get("symbol") || "ETH").toUpperCase();
    if (!(symbol in PRICES)) return { error: `unknown symbol ${symbol}` };
    return { symbol, priceUSD: PRICES[symbol], source: "AgentPay mock feed" };
  }
  if (name === "weather") {
    const city = q.get("city") || "Jakarta";
    if (!(city in WEATHER)) return { error: `unknown city ${city}` };
    return { city, ...WEATHER[city], source: "AgentPay mock feed" };
  }
  if (name === "news") {
    const topic = (q.get("topic") || "crypto").toLowerCase();
    if (!(topic in NEWS)) return { error: `unknown topic ${topic}` };
    return { topic, headlines: NEWS[topic], source: "AgentPay mock feed" };
  }
  if (name === "research") {
    const topic = (q.get("topic") || "crypto").toLowerCase();
    return {
      topic,
      brief: `Deep research brief on ${topic}: market structure, key drivers, risks, and what to watch next. (Mock content — the point is the $0.75 payment, which is above the 0.5 USDC approval threshold, so the agent must request owner approval first.)`,
      sections: ["Market structure", "Key drivers", "Risks", "What to watch"],
      source: "AgentPay mock feed",
    };
  }
  return { error: "unknown api" };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader("content-type", "application/json");
  res.setHeader("access-control-allow-origin", "*");
  if (url.pathname === "/health") {
    res.end(JSON.stringify({ ok: true, payee, network: NETWORK }));
    return;
  }
  if (url.pathname === "/api/catalog") {
    res.end(JSON.stringify(catalog()));
    return;
  }
  const m = url.pathname.match(/^\/api\/(price|weather|news|research)$/);
  if (!m) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  const name = m[1];
  const api = APIS[name];
  const txHash = req.headers["x-payment"];
  if (!txHash) {
    res.statusCode = 402;
    res.end(JSON.stringify(paymentRequired(name)));
    return;
  }
  const v = await verifyPayment(txHash, api.price);
  if (!v.ok) {
    res.statusCode = 402;
    res.end(JSON.stringify({ ...paymentRequired(name), reason: v.reason }));
    return;
  }
  res.end(JSON.stringify({ ...dataFor(name, url.searchParams), paidTx: txHash, paidBy: v.from }));
});

server.listen(PORT, () => {
  console.log(`AgentPay server on :${PORT} — payee ${payee} — network ${NETWORK}`);
});
