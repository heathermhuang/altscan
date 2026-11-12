# Changelog

All notable changes to **Altscan** — the open-source, multi-chain block explorer platform powering BNBScan and EthScan — are documented here. Read it at [altscan.io/changelog](https://altscan.io/changelog). The newest entries wait in [`changelog.d/`](changelog.d/) until a release moves them into this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses a four-part `MAJOR.MINOR.PATCH.BUILD` version scheme.

## [Unreleased]

### Added
- **A public changelog at [altscan.io/changelog](https://altscan.io/changelog).** Every release and change, read straight from this file, linked from altscan.io and the explorers' footers (#300).
- **MCP pilot at `https://altscan.io/mcp`**: a keyless, read-only, stateless MCP server with two tools, `get_transaction` and `get_token`, for both chains. It is rate-limited per client, has a kill switch (`MCP_ENABLED`), bounds what it returns, and logs no hashes or addresses. A server card at `/.well-known/mcp/server-card.json` is listed in altscan.io's AI catalog (#254).
- `/api/v1/tokens/:contract` returns `lookalike`: the well-known token a contract's name or symbol imitates, with that token's real contract, or null. It is evidence, not a safety verdict (#254).
- altscan.io is discoverable to AI agents: `/` answers `Accept: text/markdown`, sends Link headers for its machine-readable resources, and publishes an RFC 9727 API catalog and an ARD `ai-catalog.json`, both nesting the explorers' own. Its robots.txt now carries the Content-Signal and training-crawler rules its llms.txt already described. The explorers publish `/.well-known/ai-catalog.json` too (#248).
- altscan.io publishes an Agent Skill (`/.well-known/agent-skills/altscan-api/SKILL.md`, indexed and listed in its AI catalog) telling agents which explorer serves which chain and how to call the shared API (#251).
- All three sites publish `/auth.md`: the explorers document how an agent gets an API key (wallet-signed `POST /api/v1/keys`) and sends it (`X-API-Key`); altscan.io says nothing there needs a credential and points to the explorers'. The explorers serve the altscan.io MCP server's card at `/.well-known/mcp/server-card.json`, and altscan.io's homepage registers WebMCP tools that open a transaction, address, block or search on either explorer (#258).
- **OAuth 2.1 on all three sites**, off until `OAUTH_SECRET` is set. Each site is its own authorization server (RFC 8414 and RFC 9728 metadata, dynamic client registration, authorization code with S256 PKCE), and the only identity is an EVM address proven by a wallet signature, as with API keys. The explorers also take an existing API key as a `client_credentials` secret. On the explorers a bearer token works wherever an API key does, counted per address; on altscan.io it moves `/mcp` from a per-IP to a per-address limit, and `/mcp` keeps working without one. Tokens last an hour and work only where they were issued. The auth.md documents describe both flows (#259).
- **`DELETE /api/v1/keys/:id?owner=0x…` revokes an API key**: any active key of that address can revoke any of its keys, itself included. The key is deleted, so it frees its place under the 10-key limit. There was no way to retire a leaked key (#285).
- **OpenAPI 3.1 spec at `/openapi.json`** on both explorers, generated from the same catalog as the API docs so the two cannot drift apart (#256).
- `/api/v1/addresses/:address` says what it covers and returns balances. `historyComplete` and `indexedFrom` show when retention has cut its lists short, so an empty list is not read as no activity, and `nativeBalance` and `trackedTokenBalances` are read live from the chain (#263).
- altscan.io's MCP server is listed in the official MCP registry as `io.altscan/explorers` (#261).
- altscan.io records each `/mcp` tool call in Cloudflare Analytics Engine for three months, for the pilot's usage report: tool, chain, outcome, timing, upstream status, and a truncated SHA-256 of the client IP. That hash is pseudonymous, not anonymous. Queried hashes and addresses are not recorded (#257).

### Changed
- **The query API now checks requests up front and accepts only the filter combinations it can answer quickly.** Each request may use one of address, from, to or tokenAddress, with an optional block range; DEX trades can be filtered by block range only; block numbers must be whole numbers; anything else, including a field an entity never applied, gets a clear error instead of being ignored (#324).

### Fixed
- **A flood of tx-page requests no longer knocks EthScan offline.** When the explorer's node provider rate-limits it, the explorer now moves to the next provider at once instead of retrying for several seconds, so requests stop piling up until the service runs out of memory (#343).
- **Fewer DEX trades go missing after an indexer restart, and a block full of new tokens or pairs can no longer flood the indexer's node.** The indexer now remembers recent trading pairs across restarts (BNB was dropping a few hundred swaps in the first minutes after each deploy), reads new token and pair details a few at a time with a timeout, and caps how many it reads per block (#341).
- **The transaction page's cache for pruned transaction bodies is now bounded by size, not just by age.** A body over 64 KB is shown but not cached, and each two-hour window admits a fixed number of bytes, so the cache can no longer fill the Redis that the provider spend limit depends on (#331).
- **A burst of requests for an uncached list page now runs its query once.** On `/txs`, `/blocks`, `/dex`, `/whales` and `/gas`, concurrent requests for a page whose cache entry had been evicted each ran the same expensive query; they now share one, and at most eight such queries run at a time per instance (#329).
- **Address pages now say when the GoPlus security check could not run.** A failed or partial GoPlus answer is no longer cached for five minutes or shown as a clean address; only real verdicts are remembered, for ten minutes (#328).
- **The NFTs tab on a busy address loads without reading the address's whole history.** It now reads two new NFT-only indexes and shows the newest ERC-721/BEP-721 transfers found among the address's newest 1,000 NFT transfers on each side (#326).
- **Searching the token list no longer strains the database.** The search on the Tokens page now finds tokens by exact name, symbol or address, or by part of the name or symbol among the 20,000 most-held tokens, the same reach as the main search; part of a less-held token's name, or part of an address, no longer matches, and % and _ are treated as ordinary characters (#325).
- **Exporting a busy address's transactions to CSV no longer strains the database.** The download now reads them the same bounded way the address page does, newest first (#323).
- **One bad block no longer stops token transfers from being saved.** If the database refused one block's transfers, every later block used to wait behind it; the others are now saved, and a block that keeps failing is set aside and reported (#321).
- **Catching up after a long outage no longer stalls token transfers.** When the indexer skips ahead, it first makes sure the database has room for the blocks it skips to, so their token transfers can always be saved (#320).
- **One RPC node reporting the wrong chain height can no longer make the indexer skip real blocks.** Before it skips ahead after falling far behind, the indexer now checks the new height against a second node; it also no longer risks losing token transfers it had already read when it skips (#319).
- **DEX trades are no longer lost after a busy moment at the RPC node.** If a node rate-limited the first lookup of a trading pair, the indexer took the pair for something else and skipped all its later trades; it now looks the pair up again on its next trade (#318).
- **Internal transactions missed during a slow moment are filled in.** When the node that supplies internal transactions fails to answer for a new block, the indexer now tries that block again a few blocks later instead of leaving it empty for good (#317).
- **A slow trace node no longer holds up indexing.** When the node that supplies internal transactions stops answering, new blocks are still indexed on time; only their internal transactions are left out (#316).
- **One bad answer from an RPC node can no longer stall token transfers.** A malformed log from a single node could stop token transfers being saved for every later block; the indexer now rejects that answer and fetches the block from another node (#314).
- **Internal transactions no longer vanish from a whole block.** One transaction with a very deeply nested call tree used to stop every internal transaction in its block from being saved; now only that one deep call is left out (#311).
- **No more failed background requests on list pages.** Address and token links no longer preload pages that sit behind the browser check, so the token, whale and DEX lists stop logging errors for first-time visitors (#308).
- The transaction, block and DEX lists, the address page's tabs, and `/api/v1/blocks`, `/transactions` and `/tokens` reach back at most the newest 10,000 records, as the token page's transfer list already did. A deep `?page=` made Postgres walk and discard every row before it, and each page number was its own cache entry. The pages serve their last page instead; the API answers 400 for such a page, and for an `Infinity` page or limit, which used to cause a 500. Fractional values are floored (#278).
- The developer page's webhook samples match what is delivered. The verification sample keyed its HMAC with the raw secret, but delivery keys it with the secret's sha256, so code copied from it never verified a real delivery; it also threw on a malformed signature instead of returning false. The payload sample showed one transaction per POST; delivery sends one POST per block with a `data` array. The API docs now list `signature` and `timestamp` for `POST /api/v1/keys`, and say that webhook delivery is best-effort (at most once, before the block is final) and that only `tx` events are sent (#272).
- A chain reorganization now rolls back internal transactions along with every other block-derived row. Orphaned traces used to survive the rollback, and one could keep its stale value when the same transaction was re-included at the same height (#271).
- **`/api/v1/transactions/:hash` reads transactions older than the index from the chain**, as the transaction page already did, instead of answering 404. The response says `source: "index" | "chain"`; a chain answer keeps fields the node did not report null and marks `pending` when there is no receipt. A failed node lookup returns a retryable 503, not 404. Chain lookups are capped per process, deduplicated per hash and deadlined, so random hashes cannot pile up RPC work. Uppercase hashes no longer miss the index (#253).
- The API rate limiter's in-memory fallback, used while Redis is unavailable, now enforces its 10,000-entry cap. It swept expired entries past the cap but kept inserting, so a flood of distinct client addresses grew it without bound and made every request scan the whole map (#252).
- The explorers' agent discovery documents follow their specs. robots.txt's `Content-Signal` sat after the training-crawler group, so it governed only those bots; it is now in the `User-agent: *` group. The agent-skills index used a `$schema` and field names conformant clients reject, and SKILL.md lacked its required frontmatter (#248).
- The API docs, the explorers' agent skill and the Markdown `/api-docs` described `/api/v1/addresses/:address` as a balance/nonce summary. It returns the address's 20 latest indexed transactions and token transfers, and a contract check that reports `isContractKnown: false` when it could not be determined (#251).
- The explorer keeps its page cache in memory instead of writing every on-demand page to disk. Crawlers requesting thousands of distinct transaction pages an hour filled the hosted instances' temporary storage until Render evicted them (#247).
- The explorer's memory no longer grows without bound as crawlers request new transaction and block pages. Next.js keeps a revalidation entry for every distinct on-demand page and never removes one; the explorer now trims that map to its 10,000 newest entries each minute. A page whose entry was trimmed is served stale once and re-rendered (#295).
- The explorer's abuse-source IP denylist matches IPv6 ranges too, and blocks eight leased IPv6 proxy pools whose ~4,000 rotating addresses flooded uncached transaction pages and crashed the hosted ETH explorer (#250).
- A webhook is deactivated after five consecutive failed deliveries, as documented; the count never got past one before. The indexer also caps how many per-block notification runs can wait on slow endpoints at once (#243).
- Environment examples now match local explorer development and Docker self-hosting, document optional retention, disk, analytics and referral settings, and remove the unused root example (#239).
- **The indexer no longer deletes recent history on one RPC endpoint's say-so.** When no stored block hash matched an endpoint's chain within the reorg depth, it rolled back to that depth as if a common ancestor had been found, so a single endpoint serving a different chain could delete canonical blocks. That endpoint now fails over like any other bad read; the indexer rolls back to the depth limit only when two endpoints independently agree (or only one is configured), and otherwise waits and retries (#273).
- The address page's analytics sum successful transactions only and say what they cover ("Sent (last 1,000 indexed transactions)"), not "Total Sent". A failed read shows "—", not `0.0000`. The transaction count is the index's or unknown: the RPC nonce counts only outgoing transactions, so it is shown labelled as such. A malformed address gets `noindex` metadata before any RPC or database call. The CSV export sends `X-History-Complete`, `X-Indexed-From` and `X-History-Truncated`. The NFT tab drops spam, items owned by another wallet, and non-https images (#284).
- The transaction page names the spender of an `approve` from its calldata; it used to name the token contract. Allowance wording ("revoked", "unlimited") is used only when the token's Approval event shows it is ERC-20, since ERC-721 shares the call. A transaction's input that the index cut at 500 characters is fetched in full from the node, or marked as cut. Internal calls are listed in execution order, capped at 100 with a note. A transfer decoded from calldata appears only when the logs could not be read, and is labelled unverified. Unknown token decimals stay unknown instead of becoming 18. USD figures say they are at the current price. The node fallback refuses an answer for a different hash or block, and prices a fee by the receipt's effective gas price (#287).
- The token page's risk checks say "Not checked" when there is no verified ABI or the node did not answer, instead of passing. Unreadable decimals or supply show as unknown, a failed transfers query says so instead of "No transfers yet", and the provider holdings list says when it stops at 20 tokens. Lookalike detection also judges a symbol as the pages print it (`US€DT` prints as USDT), and flags lookalikes in transfer and holdings rows. The stablecoin referral copy appears only on the chain's configured stablecoin contracts, not on any token whose name contains "USDT" (#289).
- `/api/health` reports `degraded` when it cannot read the chain head, and the status page no longer shows an unknown or stale head as operational. A failed DEX query says the data is unavailable instead of "No DEX trades found". Native whale transfers exclude reverted transactions. A block page says when fewer of its transactions are indexed than it holds. `/gas` reads its base fee from the newest block that has one. The validators page's 24-hour window is resolved by timestamp. `/staking` describes the deposit contract's balance as approximately, not exactly, the total deposited. List pagination shows "400+" at the depth limit and keeps working when the row-count estimate is behind the table (#286).
- The network switcher keeps only pages that exist on both chains; an address, token, transaction or block link goes to the other chain's home instead of a different object there. The API docs and Markdown pages give the real list limits, token-list ordering and webhook example, and say which endpoints take an API key. Native price sources must name the chain's own coin (#285).
- The indexer refuses a block response for a different height than it asked for, and a receipt whose status is missing or unrecognised, before writing anything. Malformed traces are decoded before the first write and no longer leave a block half-written. It stores a transaction's effective gas price from its receipt. A `MAX_LAG_BLOCKS` below 201 no longer rewinds the cursor in a loop. Reorg checks track endpoint health separately from tip reads. A validator whose commission could not be read is stored as unknown, not 10% (#288).
- Webhook registration refuses event lists without `tx`, the only event delivered, and says which requested types it ignored. Deliveries carry `chainId` (#288).
- The transaction page's sponsored "Retrying this transaction?" box appears only on failed transactions. It also appeared on pending ones and on any that used 95% or more of its gas limit, which every plain transfer does (21,000 of 21,000) (#296).
- The transaction page lists at most 50 event logs for transactions older than the index or read from the node, as it already did for indexed ones, and at most 25 of the token transfers it decodes from the whole receipt, saying when there are more. A transaction with 5,003 logs rendered a 16 MB page that took 8 seconds and was too large to cache, and a dozen at once made the hosted ETH explorer fail its health check (#297).
- altscan.io shows a chain as offline only after two failed polls in a row. One failed poll, such as a hosting instance being replaced, used to read as an outage (#240).
- OAuth sign-in works on the explorers for clients whose redirect URI uses `127.0.0.1`, which covers most native MCP clients. They used to get "The redirect_uri is not one this app registered" (#260).
- `GET /api/v1/addresses/:address` and the address page's Transactions and Token Transfers tabs no longer time out on the busiest addresses, including exchange hot wallets and bots that only send to themselves (#262, #264).
- `POST /api/v1/query` no longer times out on its `from`, `to` and `tokenAddress` filters or on oldest-first reads (#265).
- `/search` no longer reads every token for a term with few matches, which took 11–12 seconds or timed out. Its contains match now covers the 20,000 most-held tokens; a rarer token is still found by its exact symbol or name, most-held first, or by prefix in the header search (#268, #270).
- Creating the next `token_transfers` partition gives up on a busy lock and retries on the next run. Its lock request used to queue every reader of the table, so transaction pages timed out behind it (#269).

### Security
- **One MCP client can no longer use up the explorers' capacity for all of altscan.io.** Calls through altscan.io's /mcp now carry an anonymous per-client id, and each client gets its own share of the explorers' limit; /mcp also limits every caller per address (an IPv6 /64), whether or not it signs in (#340).
- **One visitor can no longer spend the explorer's shared data-provider allowance.** Address-page tabs that fetch from the data provider now count each client's actual provider calls (cached answers are free) against an hourly budget; past it, that client sees the explorer's own index instead, and everyone else keeps the live data (#339).
- **One client can no longer multiply its API budget by holding several keys, or flood the key lookup with made-up keys.** Every API request from one address (an IPv6 /64) now shares a per-minute ceiling checked before any key is looked up, and minting a key is limited to 5 per hour per address and never charges the key sent with the request (#338).
- **Per-IP rate limits now treat an IPv6 client's whole /64 as one address.** A single subscriber usually holds 2^64 IPv6 addresses and could rotate through them to get a fresh limit on every request; IPv4-mapped and differently spelled addresses now count as the same client too (#337).
- **Webhook registrations are now capped across all owners, not only per wallet.** Each explorer holds at most 100 active webhooks, and at most 5 aimed at the same URL host; existing registrations stay. A block delivers at most 16 webhooks, taking turns across blocks when more are due, so a burst of registrations can no longer stall notifications for everyone else (#336).
- **The lookalike check now catches copies spelled with a different dash or with invisible reserved characters.** A token named `BSC-USD` but written with a Unicode hyphen or minus sign, or `USDT` padded with characters that display as nothing, is now flagged as a lookalike. `/dex` badges a swap leg whose token passes for a well-known one by its symbol or its name (#333).
- **Token names and symbols can no longer use Unicode direction controls to display as different text.** A symbol stored as `TDSU` wrapped in a right-to-left override used to display as `USDT`. Explorer pages and the search box now strip those controls and isolate the text, the token page shows a "Direction controls" warning, and the token API returns a `directionalControls` flag (#332).
- **A token contract can no longer flood a token page with an oversized name.** Names and symbols read live from the chain are limited before they are decoded and capped at 255 and 50 characters, as stored tokens already are; a rate-limited read is no longer remembered as "no symbol" for a day (#327).
- **The explorers' block on known abusive networks can no longer be dodged with a forged header.** It now trusts the visitor address Cloudflare reports only when the request really came through Cloudflare, the same rule the API rate limits already use (#322).
- **Markdown pages for agents can't replace a page for everyone.** When an agent asks for markdown at a transaction, block or info page URL, the answer is no longer cacheable by shared caches, so a cached copy can never be shown to browser visitors in place of the page (#313).
- **OAuth sign-in errors are shown, not redirected.** A malformed authorization request now gets an error page on the explorer or altscan.io instead of a redirect to the app that asked, so these sites can't be used to send visitors somewhere else (#312).
- Dependencies patched for the advisories published on 2026-10-24: Next.js 15.5.28 (remote code execution in image optimization, which the explorers do not enable, and a Server Actions denial of service), zod 4 for the settings schema (memory exhaustion on oversized collections), and undici, fast-uri and vitest (#293).
- altscan.io's `/mcp` caps each IP at 120 calls a minute across every OAuth address it uses, beside the 60-a-minute limit per address. An address costs only a wallet signature, so one IP could open hundreds of per-address buckets and drain the single bucket the explorers give all of altscan.io (#280).
- `POST /api/v1/keys` checks for existing keys, enforces the 10-key cap and inserts under one per-address lock. Parallel requests used to read the same state, so an address with no keys could get several on its wallet signature alone, and the cap could be overrun (#277).
- The admin console's house-creative upload enforces its 200-image quota atomically. Concurrent uploads all listed the same bucket count, so they could overshoot it; a new image's audit row is now written first, as a conditional insert that is its quota reservation, and released if storing the image fails (#279).
- Webhook signing keys can be encrypted at rest. A webhook's HMAC key is stored in the database, so a read of that table was enough to forge its signatures. With `WEBHOOK_SECRET_KEY` set on the indexer, it encrypts each key (AES-256-GCM, bound to the webhook) within a minute of its creation and clears the plaintext. Signatures do not change. Unset, keys stay in plaintext as before (#275, #292).
- `POST /api/v1/keys` rejects a signature timestamp that is not an integer or is more than 5 minutes from the server clock in either direction. A non-numeric timestamp made the age check compare against `NaN` and pass, and a future one passed until its date arrived, so either signature never expired (#272).
- The self-hosting guide says to run the explorer behind a proxy that sets the client-IP headers. Published directly, a client can choose the address the rate limits and denylist see (#272).
- The self-host Docker stack publishes Postgres on `127.0.0.1` only, and both Render blueprints keep their databases on the private network (#242).
- Every entry of a comma-separated `rpc.webRpcUrl` override must pass the https and public-host rule, not only the first (#242).
- The admin console proxies only known settings keys to an explorer's admin API (#242).
- `/api/v1/query` refuses an `offset` above 10,000, and the public `/api/health` no longer includes raw database error text (#242).
- The indexer records a DEX swap only from a listed factory's own pairs (PancakeSwap V2 on BNB; Uniswap V2 and SushiSwap on Ethereum), checked against the factory's registry. Any contract that emitted a V2-shaped Swap event was stored as a PancakeSwap or Uniswap trade, at amounts of its choosing. Ethereum SushiSwap trades are now labelled SushiSwap (#290).
- The indexer's invalid-index sweep and catalog lookups stay inside its own schema. An unqualified `DROP INDEX` could remove a valid index of the same name when another schema held an invalid one (#288).
- `/api/ads/binance-eligibility` trusts only Cloudflare's country header, and only from a Cloudflare peer. The other country headers it read were client-controlled (#285).
- `/md` echoes a requested path or id only when it is plain path characters. A percent-encoded backtick or newline could add headings, links or instructions to a page agents read (#285).
- Render builds install with `--frozen-lockfile`. The disk-size sync refuses to lower `DB_DISK_GB` by more than 10%, or to a capacity below the measured disk usage, since a wrong low reading would bring retention's destructive path forward. The BSC node setup script verifies its downloads by checksum, binds RPC to localhost, drops the debug and txpool APIs, and asks before wiping data. The admin console checks request origins (#283).
- OAuth authorization codes are bound to the issuer that created them, so two issuers sharing a code store cannot redeem each other's codes. More OS protocol-handler schemes are refused as redirect URIs, including for client ids registered before this change, and HMAC signatures accept one spelling only (#281).
- A keyed RPC URL no longer reaches API callers or logs. `POST /api/v1/contracts/:address/call` could echo the failing request's URL to anonymous callers; node failures now return a fixed error, and the explorer redacts URLs before logging. The live RPC connection also refuses redirects, so an endpoint cannot send the explorer to a host that was never approved (#282).
- `follow-redirects` is at 1.16.1: on a redirect, credential headers could reach another origin (#276).

## [0.4.0.0] - 2026-10-12

The explorer redesign ("Ledger Tape") across every route, a long truth-and-correctness pass on what its pages say, and an open-source release that a fork can run as its own: analytics and referral ads are now opt-in, and the docs were checked line by line against the code (#150, #163–#237).

### Added
- **Lookalike-token labels.** Tokens whose name or symbol imitates a real one (homoglyphs from any Unicode script, a name equal to a known symbol, embedded URLs) carry a badge on `/token`, the token page, and search results, and never headline a page (#196, #206, #215, #221, #229, #233).
- **Token-metadata healer.** Tokens stored as `Unknown` / `???` after a rate-limited first fetch are retried in the background until they resolve (#190, #199, #203).
- Indexes for exact-match token search and whale-size transfers (#224).

### Changed
- **Analytics and referral ads are opt-in.** The Google Analytics ID and the Binance referral code were hardcoded per chain, so a fork reported its visitors to the hosted sites' analytics and ran ads carrying their referral code. Both now come from `GA_MEASUREMENT_ID` and `BINANCE_REF_CODE`; unset, no analytics script loads and no referral placement renders or reserves space. The hosted explorers set both on Render (#236).
- **Explorer redesign ("Ledger Tape").** Every route moved onto one design system. A live block tape (width = transactions, fill = gas used) runs through the homepage, `/blocks`, `/txs`, block, transaction, address, token, `/gas`, `/validators`, `/dex` and `/charts`. Transaction pages lead with a decoded one-line summary, and address pages lead with their holdings and draw their transactions as a ledger. Dark mode follows the system setting (#182, #184–#189, #192, #211–#215, #227, #230).
- **Search accepts the site's own formats** — `#1,234`, comma-grouped numbers, `0X` prefixes, and bare hex. Exact matches always appear, real tokens rank above lookalikes, a single match redirects straight to its page, and the header search suggests as you type (#204, #218, #219, #225).
- **altscan.io rebuilt around live block tapes.** Two tapes replay the blocks BNBScan and EthScan are indexing (width = block time, fill = gas used). One real block is taken apart, and both explorer panels carry their own mini tape. The page closes with a tape of the codebase itself, measured at build time (width = lines of TypeScript, fill = share that is tests). `/api/chains.json` now serves each explorer's recent blocks behind a 12-second edge cache (#172, #174, #176–#178).
- Ad space is reserved on the server, so an ad no longer pushes the page down when it loads (#187, #193).
- altscan.io and the admin console moved from Astro 5 to Astro 7 (#180), and CI now typechecks the admin console (#183).

### Fixed
- **Contract verification works again.** It used Sourcify's removed v1 API and BNB's chain id on both chains; it now uses Sourcify v2 and the configured chain, and records the compiler version Sourcify reports rather than the one the request claimed (#202, #208).
- **Pages state only what is true.** `/gas` separates base fee from gas price and derives its tiers from real percentiles; BNB's block time is the measured 0.45 s; `/dex`, `/validators`, `/staking`, About and `/charts` no longer show estimates or placeholders as facts; address and token pages agree on holdings and holder counts (#181, #189, #194, #220, #228, #229).
- **Consistent number formats** — grouped counts, one compact format, dust shown as `<0.000001`, and one native-price source on every page (#222, #232).
- **Public API rate limits key on the visitor**, not on the Cloudflare edge that forwarded the request; the counter and its expiry are set atomically, webhook reads and deletes are limited, and `/verify` has its own budget (#195, #200, #201).
- Token pages render in milliseconds instead of ~7 s, and their holder and transfer lists no longer scan whole tables or shift the page (#150, #207, #209, #210).
- List-page caches never serve data older than their TTL; ETH `/blocks` could show blocks 27 minutes old (#223).
- `/whales` finds the period's largest transfers through the whale-size index and ranks them by USD value (#222, #226). BNB `/charts` plots whole hours (#231).
- Phone layouts: address and token tables stack instead of scrolling sideways (#231).
- Accessibility: keyboard navigation in the More menu, 3:1 popover borders, and the block tape, gas bar and status dots survive forced-colours mode (#197, #205).
- ETH can catch up on drpc's free plan: JSON-RPC batch size is capped per chain (#169).
- The indexer's boot-time schema check retries on more connection-loss shapes instead of crash-looping (#164–#166).
- AhrefsBot is blocked in `robots.txt` and throttled on heavy paths (#167).
- The homepage search placeholder fits on phones instead of breaking off mid-word, and every `/api/admin/*` route and `/api/health` checks the admin token in constant time (#237).
- **Self-hosting:** the Docker stack now passes `DB_DISK_GB` and `COMPACT_RETENTION_DAYS` to the indexer, so the disk alarm and action thresholds it already set can fire, and block history can be bounded from `.env`. The README and self-hosting guide were checked against the code and corrected, and the screenshots retaken (#234).

### Security
- **Upgraded drizzle-orm to 0.45.2** (drizzle-kit to 0.31.10), clearing the "SQL injection via improperly escaped SQL identifiers" advisory. Nothing here calls `sql.identifier()`, so it was not reachable. Since 0.44, drizzle wraps every database error in one that carries the SQL, not the reason. The deadlock retries, the indexer's boot-time database retry, and every log line and response that reports a database error now read the underlying Postgres error.
- Cleared the dependency security backlog (#179), plus routine dependency updates (#216, #217). `sharp` 0.35.4 (CVE-2026-96889) left the tree with wrangler 4.149 (#235).

## [0.3.0.0] - 2026-09-18

Three months of hardening since the open-source release: a full-history data layer, an admin console, internal transactions, and a long run of indexer-reliability and explorer-correctness fixes (#40–#155).

### Security
- **Patched a critical Next.js image-optimizer RCE** — upgraded to Next.js 15.5.25 and switched off the unused `/_next/image` endpoint on both explorers (#154).
- **Dependabot, CodeQL, a CLA check, and CODEOWNERS.** CI now pins its actions to commit SHAs, runs with a read-only token, and tests on Node 22, the version production runs (#155).
- Remediated the findings of a full-site security audit across the explorer, status page, admin console, and indexer (#64).
- The public API emits a single valid CORS origin (#111), and the repo no longer publishes the production database ID (#134).

### Added
- **Admin console** (`apps/admin`) behind Cloudflare Access with D1-backed roles, plus a runtime settings backbone for footer links and house ads (#59, #60, #63, #84).
- **Full-history data layer** — transaction bodies are refetched on demand after retention prunes them (#66), and older address history is backfilled lazily through a provider adapter under a hard Moralis compute-unit budget (#70, #74, #76, #77, #85, #135, #137).
- **Internal transactions** — traced, partitioned, replay-safe, and gated on indexer lag (#132).
- **Reorg handling** — a tail check with bounded rollback (#67).
- **Index completeness reporting** — skipped block ranges are recorded and reported by `/api/health` (#94, #95), and a block that keeps failing is quarantined instead of abandoning the blocks around it (#97).
- **Web-tier RPC failover** — a comma-separated endpoint list, tried in order (#140, #153).
- **Transaction pages** show the EIP-1559 fee breakdown, NFT transfers, and honest confirmation counts (#131).
- **Search and AI discoverability** — sitemap overhaul, `llms.txt`, a citations-yes/training-no bot policy, breadcrumbs, and structured data on altscan.io (#51–#54).
- **Self-hosting** — a verified Docker path, plus CLA and dual-licensing docs (#83).
- **Disk safety** — `DB_DISK_GB` synced from the real provisioned disk, true utilisation reporting, and separate alarm and action thresholds (#103, #108, #109).

### Changed
- Provider code moved into `@altscan/providers`, and `providers`, `explorer-core`, and `chain-config` now ship compiled `dist/` builds (#74, #79, #89).
- The indexer has one typed config module and a boot log that shows the resolved config (#119).
- Retention yields to a lagging indexer, skips deletes a partition drop is about to reclaim, and skips the in-place body prune when the compact prune covers it (#101, #104, #143).
- `pnpm lint` is real (ESLint, gated in CI), and CI builds the explorer the way production does (#120, #124).
- Removed dead weight: `packages/ui`, `apps/eth-indexer`, the legacy VPS deploy path, the hand-maintained `schema.sql`, orphaned BullMQ modules, and unused columns (#40, #87, #106, #118, #125, #126).

### Fixed
- **Whale Tracker** repaired on both chains (#110, #115, #116).
- **DEX swaps are recorded again** — a length guard had rejected every real V2 swap (#145).
- **Caching** — list pages are cached as intended; a BigInt had silently voided every cache write (#117, #121, #122).
- Missing tx, block, and token pages return real 404s or `noindex` (#50, #55, #56).
- Explorer correctness: checksummed addresses, chain-correct labels, and fee precision (#128); RPC data no longer discarded on tx and block pages (#129); RPC failures no longer rendered as "not found" (#142); small transfers no longer shown as 0.0000 (#113); a truncated transfer list says so (#147); token lookups explain failures and cache reverts (#138, #139, #141, #146); the homepage market cap no longer blanks (#45, #46).
- Public API: the advertised routes match the real ones (#112), and the address filter no longer scans the whole table (#148).
- Accessibility: data tables have proper headers and scroll on phones (#114).
- Indexer reliability: token-transfer writer flushing and backpressure (#41–#44, #47); RPC failover, timeouts, and isolating one bad endpoint (#91–#93, #99); stalls from maintenance I/O (#65); replay-safe blocks and DEX trades (#96, #149); the validator syncer (#80); backfill loops and stalls (#107, #133, #136); ETH backfill reading the wrong database pool (#82); deploy packaging (#78, #86).
- The patched `postgres` driver no longer leaves holes in the next result after a mid-result error (#144), and a full Redis no longer freezes the Moralis spend ceiling (#151).

## [0.2.0.0] - 2026-06-09

The platform was unified, rebranded to **Altscan**, and open-sourced. This release also covers the new altscan.io umbrella site and a wave of Moralis-reliability and indexer-throughput work.

### Added
- **Open-sourced under AGPL-3.0** at [github.com/heathermhuang/altscan](https://github.com/heathermhuang/altscan), with a full README, `CONTRIBUTING.md`, `SECURITY.md`, and a Contributor Covenant `CODE_OF_CONDUCT.md`.
- **altscan.io umbrella site** (`apps/altscan-site`) — an Astro 5 landing site on Cloudflare Workers that presents every explorer, a self-host guide, and a live `/api/chains.json` edge endpoint proxying each explorer's `/api/health` (2 s timeout, 60 s cache, static fallback). Custom domains `altscan.io` (apex + `www` → 301) and `status.altscan.io`.
- **Built for AI agents.** The explorers publish AI crawler rules in `robots.txt`, Link headers and an API catalog, Markdown versions of their pages (`/tx/{hash}` and `/block/{n}` included), agent skills, and WebMCP tools.
- **Status monitoring.** An independent status page tracks each explorer's uptime with a 30-day history, and `/status` on the explorers shows indexer lag and a catch-up estimate.
- **"Powered by Altscan" footer** on both explorers, alongside Status (`status.altscan.io`) and GitHub links.
- **Per-feature Moralis budgets** — independent Redis rate-limit buckets for address history, token holders, and wallet assets (`moralis:rl:v7:{history,holders,assets}`), so one feature can no longer starve the others fleet-wide.
- **Token market + holders** on ERC-20 token pages — holder counts/lists via Moralis, and a market card (price/liquidity) via the keyless DexScreener and CoinGecko APIs.
- **Lazy-loaded token holders** — a new internal endpoint `/api/internal/token/[address]/holders` moves holder fetches off server render, so SSR spends zero Moralis compute units.
- **Async, crash-safe token-transfers writer** (`ASYNC_TT_WRITER`) with a watermark in `indexer_cursor`, plus `block_number` range partitioning for instant DROP-partition retention (~6× ETH throughput).
- **`@altscan/explorer-core` `redis-client` + `kv-cache`** — a shared lazy Redis singleton and a Redis-backed string cache with bounded in-memory fallback, reused by rate limiting and the Moralis cache.
- **Continuous integration** — a GitHub Actions workflow runs the Vitest suite on every push and pull request.
- **Transaction pages** gained USD prices, confirmations, a gas bar, decoded event logs, and token transfer amounts.
- **Tokens outside the index** are read from the chain on demand, and misleading holder figures are hidden for them.
- **Search and sharing** — canonical URLs, per-page metadata, JSON-LD, an About/FAQ page, and social preview images.
- Homepage stats show market cap and 24-hour transactions, and address pages show live balances, paginated history, First Seen, and NFTs.
- `/.well-known/security.txt` on both explorers, and native Binance referral placements.

### Changed
- **Unified rebrand to Altscan** — the workspace and packages moved to the `@altscan/*` scope, and one codebase (`apps/explorer`, `apps/indexer`) now serves every chain via the `CHAIN` environment variable.
- **Domains moved to Cloudflare** with SSL Full (strict) and a WAF Managed Challenge on `/address/`, `/token/`, and `/api/internal/*` — deflects scraping bots while real browsers pass automatically.
- **Rate limiter is now fleet-wide and Redis-backed** — hourly/daily caps use Redis `INCR`/`PEXPIRE`, so `numInstances: 2` no longer multiplies intended spend and caps survive deploys.
- **`MORALIS_DISABLED` documented in `render.yaml`** as the emergency kill switch.
- **The indexer dropped its job queue** for a direct polling loop, so Redis is no longer a single point of failure for indexing.
- **Indexer throughput** — parallel block processing, a worker pool, batched writes per block, and round-robin across RPC endpoints.
- **Explorer pages use incremental static regeneration** instead of rendering per request, which was causing out-of-memory crashes.
- **A shared design system** — chain-themed colours, 44px touch targets, visible keyboard focus, and a custom 404 page across both explorers.

### Fixed
- **Moralis re-enabled on BNBScan without the OOM** — address pages for wallets idle longer than the 7-day retention window were dead-ending ("Transaction history is not available in the local index") because the Moralis fallback had been globally disabled to stop an OOM crash-loop driven by an in-process response-cache `Map` growing on the heap. The response cache and its rate-limiter counters now live in Redis (off-heap, shared across instances), with a bounded in-memory fallback for environments without Redis. Re-enables Transactions, Token Transfers, Holdings, and NFTs for unindexed/pruned addresses.
- **Corrected stale references** — fixed old `bnbscan` repository links (about page, `security.txt`) and out-of-date README sections (test paths, Postgres sizing, and the no-longer-accurate "rate limiting is not Redis-backed" note).
- **Out-of-memory crash loops ended.** Full-table scans, N+1 queries and unbounded caches were removed, and the web services gained load shedding and a memory watchdog.
- **Disk exhaustion** — data retention on both chains, raw logs no longer stored on BNB, and retention that heals itself under disk pressure.
- Two audits across both explorers: 30 UX issues, and 40 code issues including input validation, BigInt crashes, DEX decimals, and memory leaks.
- Ethereum pages read as Ethereum: ERC-20 labels, the ETH logo, and the right theme and currency.
- The validator syncer reads the correct StakeHub contract, and the Whale Tracker shows native BNB and ETH transfers as well as tokens.
- Mobile layouts no longer overflow sideways.
- Aggressive crawlers get a 429 on heavy paths, and bots no longer trigger metered provider calls on address and token pages.
- Token pages no longer hang, and stale `Unknown (???)` metadata heals for the largest tokens.

### Security
- **Upgraded to Next.js 15 and React 19**, clearing three high-severity CVEs.
- A security audit fixed 10 vulnerabilities.
- Creating an API key requires a wallet signature, `/api/health` keeps its internals behind an admin secret, and the CSP no longer allows `unsafe-eval`.

## [0.1.1.0] - 2026-03-23

A hardening pass straight after launch. Managing webhooks now requires proving you own them, the remaining API routes share the same authentication, and replaying a block can no longer duplicate its data.

### Security
- **Webhook management authentication**: `GET /webhooks` and `DELETE /webhooks/:id` now require `X-API-Key` whose `ownerAddress` matches the requested owner — prevents enumeration and unauthorized deletion by anyone who knows an address
- **`requireApiKeyOwner()` helper**: API middleware enforces ownership proof on sensitive management endpoints
- **Remaining API routes hardened**: `keys`, `contracts/call`, and `webhooks POST` now use `authRequest()` middleware instead of raw `checkIpRateLimit`

### Fixed
- **Schema idempotency**: Added `unique(tx_hash, log_index)` constraints to `logs` and `token_transfers` tables — `ON CONFLICT DO NOTHING` now functions correctly on indexer replays and crash recovery
- **NFT image lazy loading**: Added `loading="lazy"` to NFT grid images in address page to prevent layout shift

### Added
- **Unified explorer auth**: Chain-specific API key handling now lives in the shared explorer app.

## [0.1.0.0] - 2026-03-23

The first release. BNBScan and EthScan go live on one shared codebase, with blocks, transactions, addresses, tokens, DEX trades and a whale tracker, plus a developer API with keys, rate limits and signed webhooks.

### Added
- **BNBScan** (bnbscan.com): Full BNB Chain explorer — blocks, transactions, addresses, tokens, DEX trades, whale tracker, charts
- **EthScan** (ethscan.io): Full Ethereum explorer with identical feature set, parallel indexer
- **Developer Platform**: API key management (`bnbs_` prefix, SHA-256 hashed), rate limiting (100 req/min per key), webhook delivery with HMAC-SHA256 signatures
- **Webhook system**: Register webhooks for address activity; delivery engine wired to block processor; auto-deactivates after 5 consecutive failures
- **API key enforcement**: `authRequest()` middleware validates `X-API-Key` header, applies per-key rate limits, falls back to IP-based limiting
- **Enrichment libraries**: GoPlus security analysis, Moralis balance/NFT data, Space ID name service, ENS resolution, RPC fallback for DB misses
- **Network switcher**: Switch between BNBScan and EthScan from the header
- **Contract verification**: Sourcify integration for contract source verification
- **CSV export**: Transaction history export for any address
- **Homepage timestamps**: Latest Block and Total Transactions now show time since last activity
- **SSRF protection**: Webhook URL validation blocks all private IP ranges (localhost, 10.x, 192.168.x, 172.16-31.x, 169.254.x, etc.) and non-http protocols
- **Vitest test suite**: 23 tests covering IP spoofing prevention and SSRF protection

### Security
- **X-Forwarded-For IP spoofing fix**: Rate limiter now takes the LAST entry from X-Forwarded-For (Render appends the real client IP last; first entries are attacker-controlled)
- **Consolidated rate limiter**: Shared `@altscan/explorer-core` package eliminates divergent per-app implementations
- **Webhook secret hashing**: Raw secret returned to caller once; SHA-256 hash stored in DB — DB compromise cannot be used to forge webhook signatures
- **API key hashing**: `bnbs_`/`eths_` keys stored as SHA-256 hashes; prefix stored for display

### Fixed
- **RPC provider stability**: `JsonRpcProvider` now stored in `globalThis` to survive Next.js hot reloads; null-cleared on `error` event for automatic reconnection
- **DB connection pool**: Reduced web app pool from max:10 to max:5 so total connections (web=5 + indexer=10 = 15) stay within Render Standard's 25-connection limit

### Infrastructure
- Turborepo monorepo: `apps/explorer`, `apps/indexer`, `apps/status`, `packages/db`, `packages/explorer-core`, `packages/ui`
- Unified indexer: one chain-configurable worker for BNB Chain and Ethereum
- Render hosting: web service + 2 indexer workers + PostgreSQL + Redis

[Unreleased]: https://github.com/heathermhuang/altscan/compare/v0.4.0.0...HEAD
[0.4.0.0]: https://github.com/heathermhuang/altscan/compare/v0.3.0.0...v0.4.0.0
[0.3.0.0]: https://github.com/heathermhuang/altscan/compare/v0.2.0.0...v0.3.0.0
[0.2.0.0]: https://github.com/heathermhuang/altscan/compare/v0.1.1.0...v0.2.0.0
[0.1.1.0]: https://github.com/heathermhuang/altscan/compare/v0.1.0.0...v0.1.1.0
[0.1.0.0]: https://github.com/heathermhuang/altscan/releases/tag/v0.1.0.0
