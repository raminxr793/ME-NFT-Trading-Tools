# ME NFT Trading Tools

Personal Solana NFT monitoring and trading tools for Magic Eden MMM collection offers, Shared Escrow workflows, and wallet-based research.

> This repository is a personal developer tool and proof of concept. It is not financial advice, a custodial service, or an invitation to trade. Blockchain transactions are irreversible. Use a separate low-balance bot wallet and begin with dry-run or small-value testing.

## What it does

- Watches configured Solana wallets for Magic Eden activity.
- Mirrors qualifying MMM collection-wide offers from a dedicated user-controlled wallet.
- Supports Magic Eden MMM Shared Escrow offer funding.
- Applies per-trade and daily SOL caps.
- Cancels a matching mirror when the corresponding source pool is confirmed closed on-chain.
- Cancels offers when their floor-price gap shrinks below the configured threshold.
- Sends Telegram alerts for startup, offers, cancellations, low balance, fills, and daily summaries.
- Creates CSV trade logs, P&L logs, and portfolio records.
- Supports up to four independent source-wallet / bot-wallet pairs.
- Includes a kill switch and manual pool cancellation CLI.

## Repository files

| File | Purpose |
|---|---|
| `me_nft_trader.js` | Direct on-chain MMM Shared Escrow bot and monitoring workflow |
| `me_nft_trader_api.js` | API-ready Magic Eden instruction adapter; dry-run by default until an approved API response is validated |
| `verify_mmm_collection_config.js` | Extracts exact allowlist/annotation configuration from a UI-created MMM transaction |
| `collection_allowlists.json.example` | Template for collection-specific MMM configuration |
| `.env.example` | Environment-variable template; contains no secrets |

## Installation

```bash
npm install
copy .env.example .env
copy collection_allowlists.json.example collection_allowlists.json
```

On macOS/Linux, use `cp` instead of `copy`.

Edit `.env` with your RPC endpoint, a dedicated bot wallet private key, source wallet address, trading caps, and optional Telegram credentials.

Never commit `.env`, private keys, Telegram tokens, API keys, runtime state, or CSV logs. `.gitignore` already excludes them.

## Collection configuration

MMM collection offers require the exact allowlist configuration used by a UI-created offer for that collection. Extract it from a confirmed Magic Eden transaction:

```bash
node verify_mmm_collection_config.js <UI_CREATED_COLLECTION_OFFER_TX> <collection_symbol>
```

Copy the output into `collection_allowlists.json`. This file is intentionally excluded from Git because it reflects the operator's chosen collections.

## Direct on-chain mode

Start the MMM monitor and direct on-chain execution tool:

```bash
node me_nft_trader.js
```

Create a kill-switch file to pause new event handling without closing existing pools:

```bash
copy NUL STOP.txt
```

Remove `STOP.txt` to resume. To cancel a recorded pool manually:

```bash
node me_nft_trader.js --cancel <POOL_ADDRESS>
node me_nft_trader.js --cancel <POOL_ADDRESS> --pair friend1
```

## Tested direct on-chain mode

`me_nft_trader.js` is included in this repository and has been tested against Solana mainnet with a dedicated user-controlled wallet. It monitors Magic Eden wallet activity, constructs and submits MMM `CreatePool` plus `SetSharedEscrow` transactions, records pools locally, and supports direct on-chain cancellation.

The direct on-chain mode is retained as a research and fallback implementation. It does not require a Magic Eden API key for its current read and transaction-building workflow. All use should begin with a low-balance test wallet and conservative limits because blockchain transactions are irreversible.

## API-ready mode

`me_nft_trader_api.js` is designed for Magic Eden authenticated instruction endpoints. It is intentionally safe by default:

```bash
# Requires ME_API_KEY in .env; does not broadcast a transaction
node me_nft_trader_api.js --health
node me_nft_trader_api.js --dry-run-create-pool <collection_symbol> <price_sol>
```

The adapter prints the approved API response in dry-run mode. Transaction execution should only be enabled after the authenticated response format has been verified against Magic Eden's approved API documentation and test response. This avoids guessing at any transaction serialization or account structure.

## Safety controls

- `MAX_SOL_PER_TRADE` limits one offer.
- `MAX_SOL_PER_DAY` limits daily exposure per bot wallet.
- `MIN_PERCENT_BELOW_FLOOR` requires an offer to remain below current floor.
- `FLOOR_GAP_CANCEL_PERCENT` cancels when the risk margin disappears.
- `LOW_BALANCE_THRESHOLD_SOL` sends a Telegram warning.
- `STOP.txt` or `STOP_me_<pair>.txt` pauses new activity processing.
- Separate state and logs are kept per configured wallet pair.

## API access request

This project is intended to use Magic Eden's supported Solana instruction-generation flow for MMM collection offers, Shared Escrow workflows, and cancellation. API credentials are expected to remain in a local `.env` file and are never committed to this repository.

## Development status

- Public read/monitoring logic and direct on-chain MMM research flow are implemented.
- The API adapter is intentionally dry-run first because it requires an approved API key and a verified response schema.
- Support for additional marketplace flows should be added only after their official transaction response has been captured and validated.

## License

MIT
