/**
 * ME NFT Trading Tools — Magic Eden (Solana) Full-Featured Bot
 * =============================================================
 * Mirrors a friend wallet's MMM collection-wide bids and item offers on
 * Magic Eden using Shared Escrow pools. Matches all features of the
 * OpenSea nft_auto_trader.js counterpart: multi-wallet pairs, fill
 * detection, P&L tracking, portfolio log, low balance alerts, daily
 * summary, floor-gap auto-cancel, kill switch, and manual --cancel CLI.
 *
 * GitHub: https://github.com/YOUR_USERNAME/me-nft-trading-tools
 * Project: ME NFT Trading Tools
 *
 * SETUP:
 *   npm init -y
 *   npm install @coralcube-oss/mmm @coral-xyz/anchor@0.29.0 @solana/web3.js bs58 dotenv
 *   cp .env.example .env    # fill in your secrets
 *   node me_nft_trader.js
 *
 * SECRETS (.env):
 *   SOLANA_RPC_URL=
 *   PAIR_1_NAME=friend1
 *   PAIR_1_FRIEND_WALLET=<friend Solana pubkey>
 *   PAIR_1_BOT_PRIVATE_KEY=<bot base58 private key>
 *   PAIR_2_NAME=friend2
 *   PAIR_2_FRIEND_WALLET=
 *   PAIR_2_BOT_PRIVATE_KEY=
 *   PAIR_3_NAME=friend3
 *   PAIR_3_FRIEND_WALLET=
 *   PAIR_3_BOT_PRIVATE_KEY=
 *   PAIR_4_NAME=friend4
 *   PAIR_4_FRIEND_WALLET=
 *   PAIR_4_BOT_PRIVATE_KEY=
 *   SHARED_ESCROW_ACCOUNT=<your ME Shared Escrow pubkey>
 *   ME_REFERRAL_PUBKEY=8d7dmXFxP9YKubdfo3JeFYUYfC1C65HHtw9tAGsg934z
 *   ME_BUYSIDE_CREATOR_ROYALTY_BP=10000
 *   ME_API_KEY=         (optional; improves rate limits if approved)
 *   TELEGRAM_BOT_TOKEN=
 *   TELEGRAM_CHAT_ID=
 *
 * COLLECTION CONFIG (collection_allowlists.json):
 *   Extract exact kind/value/annotation for each collection using:
 *     node verify_mmm_collection_config.js <UI-offer-tx> <symbol>
 *   Then add to collection_allowlists.json:
 *   {
 *     "mad_lads": { "kind": 1, "value": "5Xvh...", "cosignerAnnotation": [...32 bytes] },
 *     "printer":  { "kind": 6, "value": "E2cj...", "cosignerAnnotation": [...32 bytes] }
 *   }
 */

require("dotenv").config();
const fs   = require("fs");
const crypto = require("crypto");
const bs58pkg = require("bs58");
const bs58 = bs58pkg.default || bs58pkg;
const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey, TransactionInstruction, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const mmmSdk = require("@coralcube-oss/mmm");

// ============================================================
// GLOBAL CONFIG (non-secret; secrets stay in .env)
// ============================================================
const SOLANA_RPC_URL  = process.env.SOLANA_RPC_URL;
const MMM_PROGRAM_ID  = mmmSdk.MMMProgramID || new PublicKey("mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc");

// ME pool construction metadata — set in .env, extracted via
// verify_mmm_collection_config.js from a UI-created collection offer.
const ME_REFERRAL_PUBKEY = new PublicKey(
  process.env.ME_REFERRAL_PUBKEY || "12xjdsBhrwGBLRQ4pgEt7wbgnxYzci8gCfdwKZaLMpCV"
);
const ME_BUYSIDE_CREATOR_ROYALTY_BP = Number(process.env.ME_BUYSIDE_CREATOR_ROYALTY_BP || 10000);
if (!Number.isInteger(ME_BUYSIDE_CREATOR_ROYALTY_BP) || ME_BUYSIDE_CREATOR_ROYALTY_BP < 0 || ME_BUYSIDE_CREATOR_ROYALTY_BP > 10_000) {
  throw new Error("ME_BUYSIDE_CREATOR_ROYALTY_BP must be 0–10000");
}

// Shared Escrow: one pool of funds backs multiple simultaneous offers.
// Create it once via Magic Eden's own UI, then put the pubkey here.
const SHARED_ESCROW_ACCOUNT = process.env.SHARED_ESCROW_ACCOUNT
  ? new PublicKey(process.env.SHARED_ESCROW_ACCOUNT)
  : null;

// Up to 4 independent (friend, bot) pairs — each gets its own state file,
// trade log, P&L log, portfolio log, and daily spending cap.
const WALLET_PAIRS = [
  { name: process.env.PAIR_1_NAME || "friend1", friendWallet: process.env.PAIR_1_FRIEND_WALLET, botPrivateKeyBase58: process.env.PAIR_1_BOT_PRIVATE_KEY },
  { name: process.env.PAIR_2_NAME || "friend2", friendWallet: process.env.PAIR_2_FRIEND_WALLET, botPrivateKeyBase58: process.env.PAIR_2_BOT_PRIVATE_KEY },
  { name: process.env.PAIR_3_NAME || "friend3", friendWallet: process.env.PAIR_3_FRIEND_WALLET, botPrivateKeyBase58: process.env.PAIR_3_BOT_PRIVATE_KEY },
  { name: process.env.PAIR_4_NAME || "friend4", friendWallet: process.env.PAIR_4_FRIEND_WALLET, botPrivateKeyBase58: process.env.PAIR_4_BOT_PRIVATE_KEY },
].filter((p) => p.friendWallet && p.botPrivateKeyBase58);

// Trading limits — these apply per pair.
const MAX_SOL_PER_TRADE           = Number(process.env.MAX_SOL_PER_TRADE           || 0.1);
const MAX_SOL_PER_DAY             = Number(process.env.MAX_SOL_PER_DAY             || 0.5);
const MIN_PERCENT_BELOW_FLOOR     = Number(process.env.MIN_PERCENT_BELOW_FLOOR     || 1);
const FLOOR_GAP_CANCEL_PERCENT    = Number(process.env.FLOOR_GAP_CANCEL_PERCENT    || 1);
const LOW_BALANCE_THRESHOLD_SOL   = Number(process.env.LOW_BALANCE_THRESHOLD_SOL   || 0.05);
const ME_FEE_RATE                 = Number(process.env.ME_FEE_RATE                 || 0.02); // 2% ME fee estimate

// Timing
const POLL_INTERVAL_MS           = Number(process.env.POLL_INTERVAL_MS           || 15_000);
const CHECK_INTERVAL_MS          = Number(process.env.CHECK_INTERVAL_MS          || 60_000);
const BALANCE_CHECK_INTERVAL_MS  = Number(process.env.BALANCE_CHECK_INTERVAL_MS  || 15 * 60_000);
const DAILY_SUMMARY_INTERVAL_MS  = Number(process.env.DAILY_SUMMARY_INTERVAL_MS  || 24 * 60 * 60_000);
const FLOOR_PRICE_CACHE_TTL_MS   = Number(process.env.FLOOR_PRICE_CACHE_TTL_MS   || 120_000);
const COLLECTION_INFO_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

// Transaction tuning
const COMPUTE_UNIT_LIMIT                = Number(process.env.COMPUTE_UNIT_LIMIT                || 200_000);
const PRIORITY_FEE_MICROLAMPORTS_PER_CU = Number(process.env.PRIORITY_FEE_MICROLAMPORTS_PER_CU || 100_000);

// Magic Eden read API
const ME_READ_BASE = "https://api-mainnet.magiceden.dev/v2";

// If AUTO_FUND_SHARED_ESCROW=true the bot will attempt a plain SOL transfer
// into the shared escrow when it runs short. Leave false until confirmed.
const AUTO_FUND_SHARED_ESCROW = process.env.AUTO_FUND_SHARED_ESCROW === "true";

// ============================================================
// COLLECTION ALLOWLIST OVERRIDES
// collection_allowlists.json: exact kind/value/annotation per collection,
// extracted from a UI-created offer via verify_mmm_collection_config.js.
// ============================================================
const COLLECTION_ALLOWLISTS_FILE = process.env.COLLECTION_ALLOWLISTS_FILE || "collection_allowlists.json";
const collectionAllowlistOverrides = new Map();
function loadCollectionAllowlistOverrides() {
  if (!fs.existsSync(COLLECTION_ALLOWLISTS_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(COLLECTION_ALLOWLISTS_FILE, "utf8"));
    for (const [symbol, entry] of Object.entries(raw)) {
      if (!entry || !Number.isInteger(entry.kind) || entry.kind < 0 || entry.kind > 255)
        throw new Error(`${symbol}: kind must be an integer 0–255`);
      const value = new PublicKey(entry.value);
      const annotation = entry.cosignerAnnotation
        ? Buffer.from(entry.cosignerAnnotation)
        : value.toBuffer();
      if (annotation.length !== 32)
        throw new Error(`${symbol}.cosignerAnnotation must be exactly 32 bytes`);
      collectionAllowlistOverrides.set(symbol, { kind: entry.kind, value, annotation });
    }
    console.log(`[debug] Loaded ${collectionAllowlistOverrides.size} collection config(s) from ${COLLECTION_ALLOWLISTS_FILE}`);
  } catch (err) {
    console.error(`[!] Failed to parse ${COLLECTION_ALLOWLISTS_FILE}: ${err.message}`);
  }
}
loadCollectionAllowlistOverrides();

// ============================================================
// GLOBAL CACHES
// ============================================================
const floorPriceCache    = new Map(); // symbol → { value, expiresAt }
const collectionInfoCache = new Map(); // symbol → { value, expiresAt }

// ============================================================
// ME READ API
// ============================================================
async function meGetRead(path, retries = 1) {
  const headers = { accept: "application/json" };
  if (process.env.ME_API_KEY) headers["x-api-key"] = process.env.ME_API_KEY;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(`${ME_READ_BASE}${path}`, { headers });
    if (resp.status === 429) {
      const after = Number(resp.headers.get("retry-after") || 0);
      const wait = (after > 0 ? after * 1000 : 1000 * Math.pow(2, attempt)) + Math.random() * 300;
      console.warn(`[me-api] 429 on ${path} — waiting ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!resp.ok) throw new Error(`ME read API ${resp.status} on ${path}`);
    return resp.json();
  }
  throw new Error(`ME read API rate-limited on ${path}`);
}

async function getFloorPriceSol(symbol) {
  const cached = floorPriceCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const stats = await meGetRead(`/collections/${symbol}/stats`);
    const value = typeof stats.floorPrice === "number" ? stats.floorPrice / LAMPORTS_PER_SOL : null;
    floorPriceCache.set(symbol, { value, expiresAt: Date.now() + FLOOR_PRICE_CACHE_TTL_MS });
    return value;
  } catch {
    return cached?.value ?? null;
  }
}

// ============================================================
// HELPERS
// ============================================================
function toLamports(sol) {
  return new anchor.BN(Math.round(sol * LAMPORTS_PER_SOL));
}

function anchorDiscriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function toPublicKey(key) {
  return key instanceof PublicKey ? key : new PublicKey(key?.pubkey || key);
}

async function sendAndConfirmPolling(tx, keypair, connection, extraSigners = []) {
  tx.instructions.unshift(
    anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    anchor.web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICROLAMPORTS_PER_CU })
  );
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = keypair.publicKey;
  tx.sign(keypair, ...extraSigners);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized")
      return signature;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Transaction not confirmed after 60s (sig: ${signature})`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function encodeCreatePoolArgs({
  spotPrice, curveType, curveDelta, reinvestFulfillBuy, reinvestFulfillSell,
  expiry, lpFeeBp, referral, cosignerAnnotation, buysideCreatorRoyaltyBp,
  uuid, paymentMint, allowlists,
}) {
  const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v.toString ? v.toString() : v)); return b; };
  const i64le = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v.toString ? v.toString() : v)); return b; };
  const u16le = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const pk    = (v) => (v instanceof PublicKey ? v : new PublicKey(v)).toBuffer();
  const full  = new Array(6).fill(null).map((_, i) => allowlists?.[i] || { kind: 0, value: PublicKey.default });
  return Buffer.concat([
    anchorDiscriminator("create_pool"),
    u64le(spotPrice),
    Buffer.from([curveType]),
    u64le(curveDelta),
    Buffer.from([reinvestFulfillBuy ? 1 : 0]),
    Buffer.from([reinvestFulfillSell ? 1 : 0]),
    i64le(expiry),
    u16le(lpFeeBp),
    pk(referral),
    Buffer.from(cosignerAnnotation),
    u16le(buysideCreatorRoyaltyBp),
    pk(uuid),
    pk(paymentMint),
    ...full.flatMap((e) => [Buffer.from([e.kind]), pk(e.value)]),
  ]);
}

function getPoolPDA(program, owner, uuid) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mmm_pool"), owner.toBuffer(), uuid.toBuffer()],
    program.programId
  );
  return pda;
}

function getBuysideSolEscrowPDA(program, poolPda) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mmm_buyside_sol_escrow_account"), poolPda.toBuffer()],
    program.programId
  );
  return pda;
}

function buildAmountArgs(program, typeName, amountBN) {
  const typeDef = (program.idl.types || []).find((t) => t.name === typeName);
  const fields = typeDef?.type?.fields;
  const fieldName = Array.isArray(fields) && fields.length === 1 ? fields[0].name : "paymentAmount";
  return { [fieldName]: amountBN };
}

async function getMmmPoolInstructionFromTx(connection, signature, programId) {
  try {
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) return null;
    const msg = tx.transaction.message;
    const loaded = tx.meta?.loadedAddresses || { writable: [], readonly: [] };
    const keys = [
      ...(msg.staticAccountKeys || msg.accountKeys || []),
      ...(loaded.writable || []),
      ...(loaded.readonly || []),
    ].map(toPublicKey);
    const disc = new Map([
      [anchorDiscriminator("create_pool").toString("hex"),    "createPool"],
      [anchorDiscriminator("update_pool").toString("hex"),    "updatePool"],
      [anchorDiscriminator("sol_close_pool").toString("hex"), "solClosePool"],
      [anchorDiscriminator("sol_withdraw_buy").toString("hex"),"solWithdrawBuy"],
    ]);
    const ixs = [
      ...(msg.compiledInstructions || msg.instructions || []),
      ...(tx.meta?.innerInstructions || []).flatMap((g) => g.instructions || []),
    ];
    for (const ix of ixs) {
      if (!keys[ix.programIdIndex]?.equals(programId)) continue;
      const name = disc.get(Buffer.from(ix.data).subarray(0, 8).toString("hex"));
      if (!name) continue;
      const idxs = Array.from(ix.accountKeyIndexes || ix.accounts || []);
      const pool = idxs.length >= 3 ? keys[idxs[2]] : null;
      if (pool) return { instructionName: name, poolPda: pool.toBase58() };
    }
    return null;
  } catch { return null; }
}

async function ensureSharedEscrowFunded(connection, botKeypair, acct, requiredSol, tag) {
  const need  = Math.ceil(requiredSol * LAMPORTS_PER_SOL);
  const have  = await connection.getBalance(acct);
  if (have >= need) return { funded: true };
  const shortfall = need - have;
  if (!AUTO_FUND_SHARED_ESCROW)
    return { funded: false, message: `Shared escrow has ${(have / LAMPORTS_PER_SOL).toFixed(6)} SOL, needs ${(need / LAMPORTS_PER_SOL).toFixed(6)} SOL` };
  console.log(`${tag} [!] Topping up shared escrow by ${(shortfall / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  const tx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.transfer({ fromPubkey: botKeypair.publicKey, toPubkey: acct, lamports: shortfall })
  );
  try {
    const sig = await sendAndConfirmPolling(tx, botKeypair, connection);
    return { funded: true, sig, amountSol: shortfall / LAMPORTS_PER_SOL };
  } catch (err) {
    return { funded: false, message: `Transfer failed: ${err.message}` };
  }
}

// ============================================================
// MmmEscrowBuilder — builds and signs MMM pool transactions
// ============================================================
class MmmEscrowBuilder {
  constructor({ connection, program, keypair, tag, sharedEscrowAccount }) {
    this.connection         = connection;
    this.program            = program;
    this.keypair            = keypair;
    this.botAddress         = keypair.publicKey;
    this.tag                = tag;
    this.sharedEscrowAccount = sharedEscrowAccount || null;
  }

  findInstruction(name) {
    return this.program.idl.instructions.find((i) => i.name.toLowerCase() === name.toLowerCase());
  }

  async withdrawBuySide(poolPda, amountSol, cosignerKeypair) {
    const escrow = getBuysideSolEscrowPDA(this.program, poolPda);
    const args   = buildAmountArgs(this.program, "SolWithdrawBuyArgs", toLamports(amountSol));
    const tx = await this.program.methods.solWithdrawBuy(args)
      .accounts({ owner: this.botAddress, cosigner: cosignerKeypair.publicKey, pool: poolPda, buysideSolEscrowAccount: escrow, systemProgram: anchor.web3.SystemProgram.programId })
      .transaction();
    return sendAndConfirmPolling(tx, this.keypair, this.connection, [cosignerKeypair]);
  }

  async createOffer({ isCollectionWide, collectionSymbol, mintAddress, priceSol, onBeforeSend = null }) {
    const uuid    = Keypair.generate();
    const cosign  = Keypair.generate();
    const poolPda = getPoolPDA(this.program, this.botAddress, uuid.publicKey);

    if (onBeforeSend) await onBeforeSend({ poolPda: poolPda.toBase58(), cosignerSecretKey: bs58.encode(cosign.secretKey) });

    const config = isCollectionWide ? collectionAllowlistOverrides.get(collectionSymbol) : null;
    if (isCollectionWide && !config)
      throw new Error(`No collection config for "${collectionSymbol}" — run verify_mmm_collection_config.js first`);

    const allowlists   = [isCollectionWide
      ? { kind: config.kind, value: config.value }
      : { kind: 1, value: new PublicKey(mintAddress) }];
    const annotation   = isCollectionWide ? config.annotation : config?.annotation || Buffer.alloc(32);

    if (!this.findInstruction("createPool"))
      throw new Error("createPool not found in IDL");

    const data = encodeCreatePoolArgs({
      spotPrice: toLamports(priceSol), curveType: 1, curveDelta: 0,
      reinvestFulfillBuy: false, reinvestFulfillSell: false,
      expiry: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      lpFeeBp: 0, buysideCreatorRoyaltyBp: ME_BUYSIDE_CREATOR_ROYALTY_BP,
      paymentMint: PublicKey.default, referral: ME_REFERRAL_PUBKEY,
      cosignerAnnotation: annotation, uuid: uuid.publicKey, allowlists,
    });
    const kind  = data[167];
    const value = new PublicKey(data.subarray(168, 200)).toBase58();
    console.log(`${this.tag} [debug] createPool kind=${kind} value=${value} annotation=${annotation.toString("hex")}`);

    const createIx = new TransactionInstruction({
      programId: this.program.programId,
      keys: [
        { pubkey: this.botAddress,                       isSigner: true,  isWritable: true  },
        { pubkey: cosign.publicKey,                      isSigner: true,  isWritable: false },
        { pubkey: poolPda,                               isSigner: false, isWritable: true  },
        { pubkey: anchor.web3.SystemProgram.programId,   isSigner: false, isWritable: false },
      ],
      data,
    });

    let secondIx, sharedEscrowLinked = false;
    if (this.sharedEscrowAccount) {
      const disc = anchorDiscriminator("set_shared_escrow");
      const buf  = Buffer.alloc(8); buf.writeBigUInt64LE(1n, 0);
      secondIx = new TransactionInstruction({
        programId: this.program.programId,
        keys: [
          { pubkey: this.botAddress,          isSigner: true,  isWritable: true  },
          { pubkey: cosign.publicKey,         isSigner: true,  isWritable: false },
          { pubkey: poolPda,                  isSigner: false, isWritable: true  },
          { pubkey: this.sharedEscrowAccount, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc, buf]),
      });
      sharedEscrowLinked = true;
    } else {
      const escrow = getBuysideSolEscrowPDA(this.program, poolPda);
      const args   = buildAmountArgs(this.program, "SolDepositBuyArgs", toLamports(priceSol));
      secondIx = await this.program.methods.solDepositBuy(args)
        .accounts({ owner: this.botAddress, cosigner: cosign.publicKey, pool: poolPda, buysideSolEscrowAccount: escrow, systemProgram: anchor.web3.SystemProgram.programId })
        .instruction();
    }

    const tx  = new anchor.web3.Transaction().add(createIx).add(secondIx);
    const sig = await sendAndConfirmPolling(tx, this.keypair, this.connection, [cosign]);
    return { sig, poolPda: poolPda.toBase58(), sharedEscrowLinked, cosignerSecretKey: bs58.encode(cosign.secretKey) };
  }

  async cancelOffer(poolAddress, cosignerKeypair, amountToWithdrawSol = null) {
    const pool  = new PublicKey(poolAddress);
    const escrow = getBuysideSolEscrowPDA(this.program, pool);

    const attemptClose = async () => {
      const tx = await this.program.methods.solClosePool()
        .accounts({ owner: this.botAddress, cosigner: cosignerKeypair.publicKey, pool, buysideSolEscrowAccount: escrow, systemProgram: anchor.web3.SystemProgram.programId })
        .transaction();
      return sendAndConfirmPolling(tx, this.keypair, this.connection, [cosignerKeypair]);
    };

    try {
      return await attemptClose();
    } catch (err) {
      if (/AccountNotInitialized|0xbc4/i.test(err.message)) {
        if ((await this.connection.getAccountInfo(pool, "confirmed")) === null) {
          console.log(`[debug] Pool ${pool.toBase58()} already gone on-chain — cleaned from state`);
          return null;
        }
      }
      if (!/NotEmptyEscrowAccount|0x177a/i.test(err.message)) throw err;
      const bal = await this.connection.getBalance(escrow);
      if (bal <= 0) throw new Error(`solClosePool: NotEmptyEscrowAccount but balance is 0: ${err.message}`);
      const amt = Math.min(amountToWithdrawSol ?? bal / LAMPORTS_PER_SOL, bal / LAMPORTS_PER_SOL);
      console.log(`[debug] Withdrawing ${amt.toFixed(6)} SOL from escrow before closing`);
      const withdrawSig = await this.withdrawBuySide(pool, amt, cosignerKeypair);
      try {
        return await attemptClose();
      } catch (err2) {
        if (/AccountNotInitialized|0xbc4/i.test(err2.message)) {
          if ((await this.connection.getAccountInfo(pool)) === null) return withdrawSig;
        }
        throw new Error(`solClosePool still failed after withdraw: ${err2.message}`);
      }
    }
  }
}

// ============================================================
// BOT INSTANCE — one per wallet pair
// ============================================================
const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const PORTFOLIO_HEADER = [
  "Day","D","M","YEAR","hh","mm","Exchange","Entry Price","Collection","Network","Pair",
  "Strategy","Position (SOL)","QTY","Entry Type","Entry Tx Hash","Collection URI",
  "ME Fee Est.","Outcome","Exit Price","Exit Tx Hash","Status",
];

function createBotInstance({ name, friendWallet, botPrivateKeyBase58 }, connection, program) {
  const STATE_FILE     = `state_me_${name}.json`;
  const LOG_FILE       = `trade_log_me_${name}.csv`;
  const PNL_LOG_FILE   = `pnl_log_me_${name}.csv`;
  const PORT_LOG_FILE  = `portfolio_me_${name}.csv`;
  const tag = `[me:${name}]`;

  const keypair    = Keypair.fromSecretKey(bs58.decode(botPrivateKeyBase58));
  const botAddress = keypair.publicKey;
  const builder    = new MmmEscrowBuilder({ connection, program, keypair, tag, sharedEscrowAccount: SHARED_ESCROW_ACCOUNT });

  // ---- STATE ----
  function loadState() {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      s.mirroredPools    = s.mirroredPools    || {};
      s.positions        = s.positions        || {};
      s.seenEventIds     = s.seenEventIds     || [];
      s.seenBotEventIds  = s.seenBotEventIds  || [];
      s.spendDate        = s.spendDate        || null;
      s.spentToday       = s.spentToday       || 0;
      s.dailyStats       = s.dailyStats       || null;
      s.lowBalanceAlerted = s.lowBalanceAlerted || false;
      s.portfolioRows    = s.portfolioRows    || [];
      return s;
    }
    return { mirroredPools:{}, positions:{}, seenEventIds:[], seenBotEventIds:[], spendDate:null, spentToday:0, dailyStats:null, lowBalanceAlerted:false, portfolioRows:[] };
  }

  function saveState(s) { writeFileWithRetry(STATE_FILE, JSON.stringify(s, null, 2)); }
  function todayStr()   { return new Date().toISOString().slice(0, 10); }

  function writeFileWithRetry(path, content, { append = false, attempts = 5 } = {}) {
    for (let i = 1; i <= attempts; i++) {
      try {
        append ? fs.appendFileSync(path, content) : fs.writeFileSync(path, content);
        return true;
      } catch (err) {
        if (!["EBUSY","EPERM","EACCES"].includes(err.code) || i === attempts) {
          console.error(`${tag} [!] write ${path}: ${err.message}`);
          return false;
        }
        sleepSync(100 * i);
      }
    }
    return false;
  }

  function ensureLog(file, header) {
    if (!fs.existsSync(file)) writeFileWithRetry(file, header + "\n");
  }

  function logTrade({ action, collection, item, price, status, note }) {
    ensureLog(LOG_FILE, "timestamp,action,collection,item,price,status,note");
    const row = [new Date().toISOString(), action, collection, item, price, status, note]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",");
    writeFileWithRetry(LOG_FILE, row + "\n", { append: true });
  }

  function logPnl({ collection, item, costBasis, salePrice, feeEst, netProfit }) {
    ensureLog(PNL_LOG_FILE, "timestamp,collection,item,costBasis,salePrice,meeFeeEst,netProfit");
    const row = [new Date().toISOString(), collection, item, costBasis, salePrice, feeEst, netProfit]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",");
    writeFileWithRetry(PNL_LOG_FILE, row + "\n", { append: true });
  }

  function rewritePortfolio(rows) {
    const lines = [PORTFOLIO_HEADER.join(",")];
    for (const r of rows) {
      lines.push([
        r.dayName, r.d, r.m, r.y, r.hh, r.mm, "magic-eden", r.entryPrice, r.collection,
        "solana", "SOL", r.strategy, r.entryPrice, 1, r.entryType, r.entryTxHash,
        `https://magiceden.io/marketplace/${r.collection}`,
        r.meFee ?? "", r.outcome ?? "OPEN", r.exitPrice ?? "", r.exitTxHash ?? "", r.status,
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","));
    }
    writeFileWithRetry(PORT_LOG_FILE, lines.join("\n") + "\n");
  }

  function dateParts(unixSec) {
    const d = new Date(unixSec * 1000);
    return {
      dayName: WEEKDAYS[d.getDay()], d: d.getDate(), m: d.getMonth() + 1, y: d.getFullYear(),
      hh: String(d.getHours()).padStart(2,"0"), mm: String(d.getMinutes()).padStart(2,"0"),
    };
  }

  function bumpDailyStat(field, amount = 1) {
    const state = loadState(); const today = todayStr();
    if (!state.dailyStats || state.dailyStats.date !== today)
      state.dailyStats = { date: today, offersPlaced:0, cancelsDetected:0, spent:0, realizedPnl:0, itemsFilled:0 };
    state.dailyStats[field] = (state.dailyStats[field] || 0) + amount;
    saveState(state);
  }

  function killSwitchActive() {
    return fs.existsSync(`STOP_me_${name}.txt`) || fs.existsSync("STOP.txt");
  }

  // ---- TELEGRAM ----
  async function tg(text) {
    if (!process.env.TELEGRAM_BOT_TOKEN) return;
    try {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: `${tag} ${text}` }),
      });
    } catch { }
  }

  // ---- OFFER HANDLER ----
  async function handleBidEvent(e) {
    const mintAddress     = e.tokenMint || e.mint || e.mintAddress || null;
    const collectionSymbol = e.collectionSymbol || e.collection || null;
    const priceSol        = e.price != null ? Number(e.price) : null;
    const isCollectionWide = !mintAddress;

    if (priceSol === null || !Number.isFinite(priceSol)) {
      logTrade({ action:"offer", collection: collectionSymbol||"?", item: mintAddress||"collection-wide", price:"?", status:"SKIPPED", note:"missing price" });
      return;
    }
    if (collectionSymbol) {
      const floor = await getFloorPriceSol(collectionSymbol);
      if (floor === null) {
        logTrade({ action:"offer", collection: collectionSymbol, item: mintAddress||"collection-wide", price: priceSol, status:"SKIPPED", note:"could not fetch floor" });
        return;
      }
      if (priceSol > floor * (1 - MIN_PERCENT_BELOW_FLOOR / 100)) {
        logTrade({ action:"offer", collection: collectionSymbol, item: mintAddress||"collection-wide", price: priceSol, status:"SKIPPED", note:`not ${MIN_PERCENT_BELOW_FLOOR}% below floor` });
        return;
      }
    }
    if (priceSol > MAX_SOL_PER_TRADE) {
      logTrade({ action:"offer", collection: collectionSymbol, item: mintAddress, price: priceSol, status:"SKIPPED", note:"exceeds per-trade cap" });
      return;
    }
    const state = loadState(); const today = todayStr();
    const spentToday = state.spendDate === today ? state.spentToday : 0;
    if (spentToday + priceSol > MAX_SOL_PER_DAY) {
      logTrade({ action:"offer", collection: collectionSymbol, item: mintAddress, price: priceSol, status:"SKIPPED", note:"exceeds daily cap" });
      return;
    }

    if (isCollectionWide) {
      if (!collectionAllowlistOverrides.get(collectionSymbol)) {
        const note = `no collection config in ${COLLECTION_ALLOWLISTS_FILE}`;
        console.error(`${tag} ❌ ${note} for ${collectionSymbol}`);
        logTrade({ action:"offer", collection: collectionSymbol, item:"collection-wide", price: priceSol, status:"SKIPPED", note });
        return;
      }
    }

    const RENT_BUFFER = 0.01;
    const need = Math.ceil((RENT_BUFFER + (SHARED_ESCROW_ACCOUNT ? 0 : priceSol)) * LAMPORTS_PER_SOL);
    const have = await connection.getBalance(botAddress);
    if (have < need) {
      const note = `wallet has ${(have/LAMPORTS_PER_SOL).toFixed(6)} SOL, needs ${(need/LAMPORTS_PER_SOL).toFixed(6)}`;
      console.error(`${tag} ❌ ${note}`);
      await tg(`❌ Low balance — ${note}`);
      logTrade({ action:"offer", collection: collectionSymbol, item: mintAddress||"collection-wide", price: priceSol, status:"SKIPPED", note });
      return;
    }

    if (SHARED_ESCROW_ACCOUNT) {
      const res = await ensureSharedEscrowFunded(connection, keypair, SHARED_ESCROW_ACCOUNT, priceSol, tag);
      if (!res.funded) {
        console.error(`${tag} ❌ ${res.message}`);
        await tg(`❌ ${res.message}`);
        logTrade({ action:"offer", collection: collectionSymbol, item: mintAddress||"collection-wide", price: priceSol, status:"SKIPPED", note: res.message });
        return;
      }
    }

    // Link to friend pool for on-chain cancel detection
    let friendPoolPda = null; let friendPoolSeenOpen = false;
    const friendAction = await getMmmPoolInstructionFromTx(connection, e.signature, MMM_PROGRAM_ID);
    if (friendAction) {
      const candidateInfo = await connection.getAccountInfo(new PublicKey(friendAction.poolPda), "confirmed");
      if (candidateInfo?.owner.equals(MMM_PROGRAM_ID)) {
        friendPoolPda = friendAction.poolPda;
        friendPoolSeenOpen = true;
        console.log(`${tag} [debug] linked to live friend pool ${friendPoolPda}`);
      }
    }

    let attemptSaved = false;
    try {
      const result = await builder.createOffer({
        isCollectionWide, collectionSymbol, mintAddress, priceSol,
        onBeforeSend: async ({ poolPda, cosignerSecretKey }) => {
          attemptSaved = true;
          const s = loadState();
          s.mirroredPools[`pool:${poolPda}`] = { poolPda, price: priceSol, collection: collectionSymbol, mintAddress, cosignerSecretKey, fundingStatus:"attempted", friendPoolPda, friendPoolSeenOpen };
          saveState(s);
        },
      });
      const label = isCollectionWide ? `(collection-wide) ${collectionSymbol}` : `${mintAddress} (${collectionSymbol})`;
      const msg = `✅ Placed offer: ${priceSol} SOL on ${label} — pool: ${result.poolPda} — tx: ${result.sig}`;
      console.log(`${tag} ${msg}`); await tg(msg);
      logTrade({ action:"offer", collection: collectionSymbol, item: mintAddress||"collection-wide", price: priceSol, status:"SUCCESS", note: result.sig });
      bumpDailyStat("offersPlaced"); bumpDailyStat("spent", priceSol);

      const ns = loadState();
      ns.spendDate = today;
      ns.spentToday = (ns.spendDate === today ? ns.spentToday : 0) + priceSol;
      ns.mirroredPools[`pool:${result.poolPda}`] = { poolPda: result.poolPda, price: priceSol, collection: collectionSymbol, mintAddress, cosignerSecretKey: result.cosignerSecretKey, sharedEscrowLinked: result.sharedEscrowLinked, fundingStatus:"complete", friendPoolPda, friendPoolSeenOpen };
      saveState(ns);
    } catch (err) {
      const note = err.message + (attemptSaved ? " — UNKNOWN outcome, check tx on-chain" : "");
      console.error(`${tag} ❌ Failed: ${note}`);
      await tg(`❌ Failed to place offer: ${note}`);
      logTrade({ action:"offer", collection: collectionSymbol, item: mintAddress||"collection-wide", price: priceSol, status:"ERROR", note });
    }
  }

  // ---- CANCEL HELPERS ----
  async function closeMirroredPool(entryKey, entry, { successMsg, errorPrefix = "Failed to cancel", notifyOnError = false } = {}) {
    try {
      if (!entry.cosignerSecretKey) throw new Error("no cosignerSecretKey in state");
      const cosignerKeypair = Keypair.fromSecretKey(bs58.decode(entry.cosignerSecretKey));
      const sig = await builder.cancelOffer(entry.poolPda, cosignerKeypair, entry.price ?? null);
      const msg = sig
        ? (successMsg ? successMsg(sig) : `✅ Cancelled pool ${entryKey} — tx: ${sig}`)
        : `✅ Removed already-closed pool ${entryKey} from state`;
      console.log(`${tag} ${msg}`); await tg(msg);
      logTrade({ action:"cancel", collection: entry.collection, item: entry.mintAddress||"collection-wide", price: entry.price, status:"SUCCESS", note: sig||"already closed" });
      const fresh = loadState(); delete fresh.mirroredPools[entryKey]; saveState(fresh);
      return { success: true, sig };
    } catch (err) {
      console.error(`${tag} [!] ${errorPrefix} ${entryKey}: ${err.message}`);
      logTrade({ action:"cancel", collection: entry.collection, item: entry.mintAddress||"collection-wide", price: entry.price, status:"ERROR", note: err.message });
      if (notifyOnError) await tg(`❌ ${errorPrefix} ${entryKey}: ${err.message}`);
      return { success: false, error: err };
    }
  }

  async function handlePoolUpdateEvent(e) {
    try {
      const action = await getMmmPoolInstructionFromTx(connection, e.signature, MMM_PROGRAM_ID);
      if (!action) return;
      if (!["solClosePool","solWithdrawBuy"].includes(action.instructionName)) return;
      if ((await connection.getAccountInfo(new PublicKey(action.poolPda), "confirmed")) !== null) return;
      const state = loadState();
      for (const [key, entry] of Object.entries(state.mirroredPools).filter(([, e]) => e.friendPoolPda === action.poolPda)) {
        await closeMirroredPool(key, entry, { successMsg: (sig) => `✅ Friend's pool closed — mirrored cancel tx: ${sig}`, notifyOnError: true });
      }
    } catch (err) { console.error(`${tag} [!] handlePoolUpdateEvent: ${err.message}`); }
  }

  async function handleCancelEvent(e) {
    try {
      const mintAddress     = e.tokenMint || e.mint || e.mintAddress || null;
      const collectionSymbol = e.collectionSymbol || e.collection || null;
      const cancelledPrice   = e.price != null ? Number(e.price) : null;
      if (!mintAddress && !collectionSymbol) return;
      const state = loadState();
      const matches = Object.entries(state.mirroredPools).filter(([, m]) => {
        if (mintAddress ? m.mintAddress !== mintAddress : m.mintAddress || m.collection !== collectionSymbol) return false;
        if (cancelledPrice !== null && m.price !== cancelledPrice) return false;
        return true;
      });
      for (const [key, entry] of matches)
        await closeMirroredPool(key, entry, { successMsg: (sig) => `✅ Mirrored friend cancel — tx: ${sig}`, notifyOnError: true });
    } catch (err) { console.error(`${tag} [!] handleCancelEvent: ${err.message}`); }
  }

  // ---- PERIODIC CHECKS ----
  async function checkFloorGapAndCancel() {
    const state = loadState();
    for (const [key, m] of Object.entries(state.mirroredPools)) {
      if (!m.collection) continue;
      const floor = await getFloorPriceSol(m.collection);
      if (!floor || floor <= 0) continue;
      const gap = ((floor - m.price) / floor) * 100;
      if (gap < FLOOR_GAP_CANCEL_PERCENT)
        await closeMirroredPool(key, m, { successMsg: (sig) => `✅ Floor gap ${gap.toFixed(2)}% — cancelled — tx: ${sig}` });
    }
  }

  async function checkFriendPoolsStillExist() {
    const state = loadState();
    for (const [key, m] of Object.entries(state.mirroredPools)) {
      if (!m.friendPoolPda || m.friendPoolSeenOpen !== true) continue;
      try {
        if ((await connection.getAccountInfo(new PublicKey(m.friendPoolPda), "confirmed")) === null)
          await closeMirroredPool(key, m, { successMsg: (sig) => `✅ Friend pool gone — closed mirror tx: ${sig}`, notifyOnError: true });
      } catch (err) { console.error(`${tag} [!] checkFriendPoolsStillExist ${key}: ${err.message}`); }
    }
  }

  async function checkBotWalletForFills() {
    // Detect buyNow fills on bot wallet by scanning its activity
    try {
      const resp = await fetch(`${ME_READ_BASE}/wallets/${botAddress.toBase58()}/activities?offset=0&limit=30`, {
        headers: { accept: "application/json", ...(process.env.ME_API_KEY ? { "x-api-key": process.env.ME_API_KEY } : {}) },
      });
      if (!resp.ok) return;
      const events = await resp.json();
      if (!Array.isArray(events)) return;

      const state   = loadState();
      const seenBot = new Set(state.seenBotEventIds || []);
      let changed   = false;

      for (const e of events) {
        const ekey = e.signature || `${e.blockTime}-${e.type}`;
        if (seenBot.has(ekey)) continue;
        seenBot.add(ekey); changed = true;

        if (e.type !== "buyNow" && e.type !== "buy") continue;
        const tokenMint    = e.tokenMint || e.mint;
        const collection   = e.collectionSymbol || e.collection;
        const priceSol     = e.price != null ? Number(e.price) : null;
        const buyerIsBot   = (e.buyer || "").toLowerCase() === botAddress.toBase58().toLowerCase();
        const sellerIsBot  = (e.seller || "").toLowerCase() === botAddress.toBase58().toLowerCase();
        if (!tokenMint || priceSol === null) continue;

        if (buyerIsBot) {
          // NFT acquired — record position
          const posKey = `${tokenMint}`;
          const freshState = loadState();
          freshState.positions[posKey] = { collection, tokenMint, costBasis: priceSol, acquiredAt: Date.now() };
          const dp = dateParts(e.blockTime || Math.floor(Date.now() / 1000));
          freshState.portfolioRows = freshState.portfolioRows || [];
          freshState.portfolioRows.push({ posKey, ...dp, entryPrice: priceSol, collection, strategy: "Floor offer flip", entryType: "MMM pool fill", entryTxHash: e.signature || "", status: "OPEN" });
          saveState(freshState);
          rewritePortfolio(freshState.portfolioRows);
          const msg = `📥 Filled: ${tokenMint} (${collection}) at ${priceSol} SOL`;
          console.log(`${tag} ${msg}`); await tg(msg);
          bumpDailyStat("itemsFilled");
        }

        if (sellerIsBot) {
          // NFT sold — compute P&L
          const posKey = `${tokenMint}`;
          const freshState = loadState();
          const pos = freshState.positions[posKey];
          if (pos) {
            const feeEst   = priceSol * ME_FEE_RATE;
            const netProfit = priceSol - feeEst - pos.costBasis;
            logPnl({ collection, item: tokenMint, costBasis: pos.costBasis, salePrice: priceSol, feeEst: feeEst.toFixed(6), netProfit: netProfit.toFixed(6) });
            const row = [...(freshState.portfolioRows || [])].reverse().find((r) => r.posKey === posKey && r.status === "OPEN");
            if (row) { row.exitPrice = priceSol; row.exitTxHash = e.signature || ""; row.meFee = feeEst.toFixed(6); row.outcome = netProfit >= 0 ? `PROFIT ${netProfit.toFixed(6)}` : `LOSS ${netProfit.toFixed(6)}`; row.status = "CLOSED"; }
            delete freshState.positions[posKey];
            saveState(freshState);
            rewritePortfolio(freshState.portfolioRows);
            const emoji = netProfit >= 0 ? "💰" : "🔻";
            const msg = `${emoji} Sold ${tokenMint} (${collection}) at ${priceSol} SOL — bought at ${pos.costBasis}, net: ${netProfit.toFixed(6)}`;
            console.log(`${tag} ${msg}`); await tg(msg);
            bumpDailyStat("realizedPnl", netProfit);
          }
        }
      }

      if (changed) {
        const freshState = loadState();
        freshState.seenBotEventIds = Array.from(seenBot);
        saveState(freshState);
      }
    } catch (err) { console.error(`${tag} [!] checkBotWalletForFills: ${err.message}`); }
  }

  async function checkLowBalance() {
    try {
      const bal = await connection.getBalance(botAddress);
      const state = loadState();
      if (bal / LAMPORTS_PER_SOL < LOW_BALANCE_THRESHOLD_SOL) {
        if (!state.lowBalanceAlerted) {
          const msg = `⚠️ Low balance: ${(bal/LAMPORTS_PER_SOL).toFixed(6)} SOL (below ${LOW_BALANCE_THRESHOLD_SOL})`;
          console.warn(`${tag} ${msg}`); await tg(msg);
          state.lowBalanceAlerted = true; saveState(state);
        }
      } else if (state.lowBalanceAlerted) {
        state.lowBalanceAlerted = false; saveState(state);
      }
    } catch (err) { console.error(`${tag} [!] checkLowBalance: ${err.message}`); }
  }

  async function sendDailySummary() {
    const state = loadState();
    const s = state.dailyStats || { offersPlaced:0, cancelsDetected:0, spent:0, realizedPnl:0, itemsFilled:0 };
    const msg =
      `📊 Daily summary\n` +
      `Offers placed: ${s.offersPlaced||0}\n` +
      `Cancellations: ${s.cancelsDetected||0}\n` +
      `NFTs filled: ${s.itemsFilled||0}\n` +
      `Spent today: ${(s.spent||0).toFixed(4)} SOL (cap: ${MAX_SOL_PER_DAY})\n` +
      `Realized P&L (est., before gas): ${(s.realizedPnl||0).toFixed(6)} SOL`;
    console.log(`${tag} ${msg}`); await tg(msg);
  }

  // ---- MAIN LOOP ----
  async function start() {
    console.log(`${tag} Starting. Bot wallet: ${botAddress.toBase58()}. Watching: ${friendWallet}`);
    await tg(`✅ Started. Bot: ${botAddress.toBase58()}`);

    const safe = (fn, label) => async () => { try { await fn(); } catch (err) { console.error(`${tag} [!] ${label}: ${err.message}`); } };

    setInterval(safe(checkFloorGapAndCancel,      "floor-gap-cancel"),  CHECK_INTERVAL_MS);
    setInterval(safe(checkFriendPoolsStillExist,   "friend-pool-check"), CHECK_INTERVAL_MS);
    setInterval(safe(checkBotWalletForFills,       "fill-check"),        CHECK_INTERVAL_MS);
    setInterval(safe(checkLowBalance,              "low-balance"),        BALANCE_CHECK_INTERVAL_MS);
    setInterval(safe(sendDailySummary,             "daily-summary"),      DAILY_SUMMARY_INTERVAL_MS);
    checkLowBalance();

    let state = loadState();
    const seen = new Set(state.seenEventIds || []);
    let firstRun = (state.seenEventIds || []).length === 0;

    while (true) {
      try {
        if (killSwitchActive()) { await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS)); continue; }

        const events = await (async () => {
          try {
            const resp = await fetch(`${ME_READ_BASE}/wallets/${friendWallet}/activities?offset=0&limit=30`, {
              headers: { accept:"application/json", ...(process.env.ME_API_KEY ? { "x-api-key": process.env.ME_API_KEY } : {}) },
            });
            if (!resp.ok) throw new Error(`activities ${resp.status}`);
            return await resp.json();
          } catch (err) { console.error(`${tag} [!] fetch activities: ${err.message}`); return []; }
        })();

        if (!Array.isArray(events)) { await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS)); continue; }

        if (firstRun) {
          for (const e of events) seen.add(e.signature || `${e.blockTime}-${e.type}`);
          firstRun = false;
          const fresh = loadState(); fresh.seenEventIds = Array.from(seen); saveState(fresh);
          console.log(`${tag} Loaded ${seen.size} existing activities as baseline.`);
        } else {
          for (const e of events) {
            const key = e.signature || `${e.blockTime}-${e.type}`;
            if (seen.has(key)) continue;
            seen.add(key);
            console.log(`${tag} [event] type="${e.type}" source="${e.source||""}"`);
            if (e.type === "bid") await handleBidEvent(e);
            if (e.type === "poolUpdate" && e.source === "mmm") await handlePoolUpdateEvent(e);
            const isCancel = ["cancelBid","cancel_bid","cancel","bidCancel","cancelOffer","offerCancel"].includes(e.type);
            if (isCancel) await handleCancelEvent(e);
          }
          const fresh = loadState(); fresh.seenEventIds = Array.from(seen); saveState(fresh);
        }
      } catch (err) { console.error(`${tag} [!] poll cycle: ${err.message}`); }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  async function cancelPoolByAddress(poolAddress) {
    const state = loadState();
    const entryKey = Object.keys(state.mirroredPools).find((k) => state.mirroredPools[k].poolPda === poolAddress);
    const entry = entryKey ? state.mirroredPools[entryKey] : null;
    if (!entry) { console.error(`${tag} No record of pool ${poolAddress} in ${STATE_FILE}`); return { found:false, success:false }; }
    const result = await closeMirroredPool(entryKey, entry, { successMsg: (sig) => `✅ Manual cancel pool ${poolAddress} — tx: ${sig}`, errorPrefix: "Manual cancel failed" });
    return { found:true, success: result.success };
  }

  return { start, cancelPoolByAddress };
}

// ============================================================
// PROCESS GUARDS
// ============================================================
process.on("unhandledRejection", (err) => console.error("[!] Unhandled rejection:", err?.message || err));
process.on("uncaughtException",  (err) => console.error("[!] Uncaught exception:",  err?.message || err));

// ============================================================
// ENTRY POINT
// ============================================================
async function main() {
  if (!SOLANA_RPC_URL) { console.error("SOLANA_RPC_URL not set in .env"); return; }
  if (WALLET_PAIRS.length === 0) { console.error("No wallet pairs configured in .env"); return; }

  const connection   = new Connection(SOLANA_RPC_URL, "confirmed");
  const dummyKeypair = Keypair.fromSecretKey(bs58.decode(WALLET_PAIRS[0].botPrivateKeyBase58));
  const provider     = new anchor.AnchorProvider(connection, new anchor.Wallet(dummyKeypair), { commitment:"confirmed" });
  const program      = new anchor.Program(mmmSdk.IDL, MMM_PROGRAM_ID, provider);

  try {
    const u = new URL(SOLANA_RPC_URL);
    console.log(`[debug] RPC: ${u.hostname}`);
  } catch { }

  // --cancel <pool> [--pair <name>]
  const cancelIdx = process.argv.indexOf("--cancel");
  if (cancelIdx !== -1) {
    const poolAddress = process.argv[cancelIdx + 1];
    if (!poolAddress) { console.error("Usage: node me_nft_trader.js --cancel <poolAddress> [--pair <name>]"); return; }
    const pairName = process.argv[process.argv.indexOf("--pair") + 1] || null;
    const pairs = pairName ? WALLET_PAIRS.filter((p) => p.name === pairName) : WALLET_PAIRS;
    if (!pairs.length) { console.error(`No pair named "${pairName}"`); return; }
    for (const pair of pairs) {
      const bot = createBotInstance(pair, connection, program);
      const res = await bot.cancelPoolByAddress(poolAddress);
      if (res.found && res.success) return;
    }
    console.error(`Could not cancel ${poolAddress}`);
    return;
  }

  console.log(`Starting ${WALLET_PAIRS.length} ME bot instance(s)...`);
  for (const pair of WALLET_PAIRS) {
    const bot = createBotInstance(pair, connection, program);
    bot.start().catch((err) => console.error(`[${pair.name}] Fatal:`, err));
  }
}

main();
