/**
 * ME NFT Trading Tools — Magic Eden API Execution Adapter
 * =========================================================
 * API-ready companion to me_nft_trader.js.
 *
 * Status: transaction-response parsing is intentionally DRY-RUN by default.
 * It requires a Magic Eden API key and one recorded response from the approved
 * instruction endpoints before live execution is enabled. This avoids claiming
 * an unverified response schema is ready to move real funds.
 *
 * This file demonstrates the supported flow:
 *   1. Authenticate with ME_API_KEY.
 *   2. Request a marketplace-generated transaction/instruction payload.
 *   3. Inspect it in DRY_RUN mode.
 *   4. Once its response shape is verified, deserialize, sign only with the
 *      user's local wallet, submit through their own RPC, and confirm it.
 *
 * Secrets are read exclusively from .env and must never be committed.
 *
 * Usage:
 *   node me_nft_trader_api.js --health
 *   node me_nft_trader_api.js --dry-run-create-pool <collectionSymbol> <priceSol>
 *
 * Required .env values:
 *   SOLANA_RPC_URL=
 *   ME_API_KEY=
 *   PAIR_1_BOT_PRIVATE_KEY=
 *
 * Optional:
 *   API_MODE=dry-run            # default; use live only after API response validation
 *   ME_API_BASE=https://api-mainnet.magiceden.dev/v2
 */

require("dotenv").config();
const bs58pkg = require("bs58");
const bs58 = bs58pkg.default || bs58pkg;
const { Connection, Keypair, VersionedTransaction, Transaction } = require("@solana/web3.js");

const API_BASE = process.env.ME_API_BASE || "https://api-mainnet.magiceden.dev/v2";
const RPC_URL = process.env.SOLANA_RPC_URL;
const API_KEY = process.env.ME_API_KEY;
const API_MODE = (process.env.API_MODE || "dry-run").toLowerCase();
const BOT_PRIVATE_KEY = process.env.PAIR_1_BOT_PRIVATE_KEY;

function requireConfig(name, value) {
  if (!value) throw new Error(`${name} is missing from .env`);
  return value;
}

function authHeaders() {
  return {
    accept: "application/json",
    "content-type": "application/json",
    // Magic Eden may require Bearer authorization for instruction endpoints.
    // If its approval email specifies x-api-key instead, change only this line.
    authorization: `Bearer ${API_KEY}`,
  };
}

async function requestInstruction(path, { method = "GET", query = {}, body } = {}) {
  requireConfig("ME_API_KEY", API_KEY);
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { rawText: text }; }
  if (!response.ok) {
    throw new Error(`Magic Eden API ${response.status} on ${path}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function findSerializedTransaction(payload) {
  // Deliberately supports only common candidates. Print the API response in
  // dry-run if none matches; do not guess at a live transaction format.
  const candidates = [
    payload.transaction,
    payload.tx,
    payload.serializedTransaction,
    payload.encodedTransaction,
    payload.data?.transaction,
    payload.data?.tx,
    payload.v0?.tx,
  ];
  return candidates.find((value) => typeof value === "string" && value.length > 20) || null;
}

async function signAndSendSerializedTransaction(encoded, keypair, connection) {
  const bytes = Buffer.from(encoded, "base64");
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    versioned.sign([keypair]);
    return await connection.sendRawTransaction(versioned.serialize(), { skipPreflight: false });
  } catch (versionedError) {
    try {
      const legacy = Transaction.from(bytes);
      legacy.partialSign(keypair);
      return await connection.sendRawTransaction(legacy.serialize(), { skipPreflight: false });
    } catch (legacyError) {
      throw new Error(`Could not decode response as versioned or legacy transaction. Versioned: ${versionedError.message}; legacy: ${legacyError.message}`);
    }
  }
}

async function confirm(connection, signature) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) throw new Error(`On-chain failure: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Transaction not confirmed within 60 seconds: ${signature}`);
}

async function main() {
  requireConfig("SOLANA_RPC_URL", RPC_URL);
  requireConfig("PAIR_1_BOT_PRIVATE_KEY", BOT_PRIVATE_KEY);
  const connection = new Connection(RPC_URL, "confirmed");
  const keypair = Keypair.fromSecretKey(bs58.decode(BOT_PRIVATE_KEY));

  const [, , command, collectionSymbol, priceSol] = process.argv;
  if (command === "--health") {
    console.log(JSON.stringify({
      project: "ME NFT Trading Tools",
      apiBase: API_BASE,
      apiMode: API_MODE,
      wallet: keypair.publicKey.toBase58(),
      apiKeyConfigured: Boolean(API_KEY),
      rpcConnected: Boolean(await connection.getLatestBlockhash("confirmed")),
    }, null, 2));
    return;
  }

  if (command !== "--dry-run-create-pool" || !collectionSymbol || !priceSol) {
    console.log("Usage: node me_nft_trader_api.js --health");
    console.log("   or: node me_nft_trader_api.js --dry-run-create-pool <collectionSymbol> <priceSol>");
    return;
  }

  // The exact request parameters must be validated against the approved API
  // documentation/response. Dry-run never signs or broadcasts anything.
  const payload = await requestInstruction("/instructions/mmm/create-pool", {
    query: {
      owner: keypair.publicKey.toBase58(),
      collectionSymbol,
      spotPrice: priceSol,
    },
  });

  console.log("=== Magic Eden API response (redact before sharing publicly) ===");
  console.log(JSON.stringify(payload, null, 2));

  const encoded = findSerializedTransaction(payload);
  if (!encoded) {
    console.log("No known serialized-transaction field was found. Keep API_MODE=dry-run and map the approved response shape before enabling execution.");
    return;
  }

  if (API_MODE !== "live") {
    console.log("API_MODE is dry-run. Transaction was NOT signed or sent.");
    return;
  }

  const signature = await signAndSendSerializedTransaction(encoded, keypair, connection);
  await confirm(connection, signature);
  console.log(`Confirmed: ${signature}`);
}

main().catch((error) => {
  console.error("API adapter failed:", error.message);
  process.exitCode = 1;
});
