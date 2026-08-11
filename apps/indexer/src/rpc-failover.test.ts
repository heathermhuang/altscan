import { describe, it, expect, vi } from 'vitest'
import { processWithFailover, redactRpcUrl, redactRpcSecrets, formatRedactedError } from './rpc-failover'

/**
 * Regression cover for the 2026-08-11 BNB indexing collapse.
 *
 * `BNB_RPC_URL` held three endpoints, one of which (bsc.publicnode.com) answers
 * recent blocks but 403s any archive request. The indexer only asks for old
 * blocks WHEN IT IS BEHIND, so the moment it drifted, every fetch routed to that
 * endpoint failed, one failure aborted the whole 40-block batch, throughput
 * collapsed, and it skipped ~5,100 blocks an hour — permanently.
 *
 * The invariant these tests pin: a block must survive any single endpoint being
 * broken, as long as one healthy endpoint remains — WITHOUT ever replaying a
 * partially-written block (see the side-effect tests below).
 */
describe('processWithFailover', () => {
  it('succeeds on the first provider without touching the others', async () => {
    const work = vi.fn().mockResolvedValue(undefined)
    await processWithFailover(100, ['a', 'b', 'c'], 0, work)
    expect(work).toHaveBeenCalledTimes(1)
    expect(work).toHaveBeenCalledWith(100, 'a', expect.any(Function))
  })

  it('falls over to the next provider when the first fails', async () => {
    const work = vi.fn()
      .mockRejectedValueOnce(new Error('Archive requests require a personal token'))
      .mockResolvedValueOnce(undefined)
    await processWithFailover(100, ['bad', 'good'], 0, work)
    expect(work).toHaveBeenCalledTimes(2)
    expect(work).toHaveBeenNthCalledWith(1, 100, 'bad', expect.any(Function))
    expect(work).toHaveBeenNthCalledWith(2, 100, 'good', expect.any(Function))
  })

  it('starts at the given index and wraps around', async () => {
    const work = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
    await processWithFailover(100, ['a', 'b', 'c'], 2, work)
    expect(work).toHaveBeenNthCalledWith(1, 100, 'c', expect.any(Function))
    expect(work).toHaveBeenNthCalledWith(2, 100, 'a', expect.any(Function))
  })

  it('tries every provider exactly once before giving up', async () => {
    const work = vi.fn().mockRejectedValue(new Error('all down'))
    await expect(processWithFailover(100, ['a', 'b', 'c'], 1, work)).rejects.toThrow('all down')
    expect(work).toHaveBeenCalledTimes(3)
    expect(work.mock.calls.map(c => c[1])).toEqual(['b', 'c', 'a'])
  })

  it('propagates the LAST error when every provider fails', async () => {
    const work = vi.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('last'))
    await expect(processWithFailover(100, ['a', 'b'], 0, work)).rejects.toThrow('last')
  })

  it('handles a single-provider list (no failover available)', async () => {
    const work = vi.fn().mockRejectedValue(new Error('only one'))
    await expect(processWithFailover(100, ['a'], 0, work)).rejects.toThrow('only one')
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('normalizes an out-of-range start index', async () => {
    const work = vi.fn().mockResolvedValue(undefined)
    await processWithFailover(100, ['a', 'b'], 7, work)
    expect(work).toHaveBeenCalledWith(100, 'b', expect.any(Function))
  })

  it('throws a clear error when the provider list is empty', async () => {
    const work = vi.fn()
    await expect(processWithFailover(100, [], 0, work)).rejects.toThrow(/no RPC providers/i)
    expect(work).not.toHaveBeenCalled()
  })

  it('reports each failover attempt so a sick endpoint is visible in logs', async () => {
    const onFailover = vi.fn()
    const work = vi.fn()
      .mockRejectedValueOnce(new Error('403 archive'))
      .mockResolvedValueOnce(undefined)
    await processWithFailover(100, ['bad', 'good'], 0, work, onFailover)
    expect(onFailover).toHaveBeenCalledTimes(1)
    expect(onFailover).toHaveBeenCalledWith(100, 'bad', expect.any(Error))
  })

  /**
   * codex P1 on PR #91. `processBlock` is NOT a pure fetch — it commits blocks,
   * transactions and dex_trades to Postgres incrementally and only enqueues
   * transfers at the end. `dex_trades` carries `id serial PRIMARY KEY` and NO
   * unique constraint (packages/db/schema.ts), so `onConflictDoNothing()` cannot
   * deduplicate a replayed insert. Retrying a block that already wrote would
   * duplicate rows — trading a safe batch abort for silent corruption.
   *
   * Failover is therefore only legal while the attempt is known to have produced
   * no side effects. `processBlock` signals the boundary the instant before its
   * first INSERT.
   */
  describe('side-effect safety', () => {
    it('does NOT fail over once the attempt has begun writing', async () => {
      const work = vi.fn(async (_b: number, _p: string, onSideEffect: () => void) => {
        onSideEffect()
        throw new Error('db insert blew up midway')
      })
      await expect(processWithFailover(100, ['a', 'b', 'c'], 0, work))
        .rejects.toThrow('db insert blew up midway')
      expect(work).toHaveBeenCalledTimes(1)
    })

    it('still fails over when the attempt failed before any write', async () => {
      const work = vi.fn()
        .mockImplementationOnce(async () => { throw new Error('rpc 403') })
        .mockImplementationOnce(async () => undefined)
      await processWithFailover(100, ['a', 'b'], 0, work)
      expect(work).toHaveBeenCalledTimes(2)
    })

    it('stops failing over when a LATER attempt writes before failing', async () => {
      const work = vi.fn()
        .mockImplementationOnce(async () => { throw new Error('rpc 403') })
        .mockImplementationOnce(async (_b: number, _p: string, onSideEffect: () => void) => {
          onSideEffect()
          throw new Error('partial write on second provider')
        })
      await expect(processWithFailover(100, ['a', 'b', 'c'], 0, work))
        .rejects.toThrow('partial write on second provider')
      expect(work).toHaveBeenCalledTimes(2)
    })

    it('does not report a failover for an attempt that already wrote', async () => {
      const onFailover = vi.fn()
      const work = vi.fn(async (_b: number, _p: string, onSideEffect: () => void) => {
        onSideEffect()
        throw new Error('nope')
      })
      await expect(processWithFailover(100, ['a', 'b'], 0, work, onFailover)).rejects.toThrow('nope')
      expect(onFailover).not.toHaveBeenCalled()
    })

    it('a successful write is not treated as a failure', async () => {
      const work = vi.fn(async (_b: number, _p: string, onSideEffect: () => void) => {
        onSideEffect()
      })
      await expect(processWithFailover(100, ['a', 'b'], 0, work)).resolves.toBeUndefined()
      expect(work).toHaveBeenCalledTimes(1)
    })
  })
})

/**
 * codex P1 on PR #91. index.ts already redacts RPC URLs at startup
 * (`u.replace(/\/\/.*@/, '//***@')`); the failover logger must not bypass that
 * and publish embedded provider tokens to production logs. render.yaml notes the
 * BNB endpoint has been a keyed Chainstack URL before, so this is live risk, not
 * theoretical.
 */
describe('redactRpcUrl', () => {
  it('masks basic-auth credentials', () => {
    expect(redactRpcUrl('https://user:s3cret@rpc.example.com/path')).toBe('https://***@rpc.example.com/***')
  })

  // codex P1 round 2: the first implementation returned immediately after
  // masking userinfo, so a URL carrying BOTH basic-auth and a path/query token
  // leaked the latter. Every rule must apply in one pass.
  it('applies every rule at once — userinfo AND path AND query', () => {
    expect(redactRpcUrl('https://user:pass@rpc.example.com/v1/path-token?apikey=query-token'))
      .toBe('https://***@rpc.example.com/***')
  })

  it('preserves a non-default port', () => {
    expect(redactRpcUrl('https://rpc.example.com:8545/')).toBe('https://rpc.example.com:8545/')
  })

  it('masks a token embedded as userinfo', () => {
    expect(redactRpcUrl('https://abc123token@bsc.chainstack.com')).toBe('https://***@bsc.chainstack.com')
  })

  it('strips an API key carried in the path', () => {
    expect(redactRpcUrl('https://bsc.example.com/v1/9f8e7d6c5b4a')).toBe('https://bsc.example.com/***')
  })

  it('strips an API key carried in the query string', () => {
    expect(redactRpcUrl('https://bsc.example.com/rpc?apikey=secret')).toBe('https://bsc.example.com/***')
  })

  it('leaves a credential-free public endpoint readable', () => {
    expect(redactRpcUrl('https://bsc-dataseed1.binance.org/')).toBe('https://bsc-dataseed1.binance.org/')
  })

  it('does not throw on an unparseable URL', () => {
    expect(redactRpcUrl('not a url')).toBe('<unparseable-rpc-url>')
  })
})

/**
 * codex P1 round 2. Redacting the endpoint LABEL is not enough: ethers 6.16
 * embeds the complete `requestUrl` — userinfo, path and query included — in the
 * text of HTTP failure errors. Production logs show exactly this shape:
 *   `server response 500 ... info={ "requestUrl": "https://..." }`
 * So the error message itself has to be scrubbed before it is logged.
 */
describe('redactRpcSecrets', () => {
  const urls = [
    'https://user:pass@rpc.example.com/v1/token',
    'https://bsc-dataseed1.binance.org/',
  ]

  it('replaces a configured credential-bearing URL inside an error message', () => {
    const msg = 'server response 500 (requestUrl="https://user:pass@rpc.example.com/v1/token", code=SERVER_ERROR)'
    const out = redactRpcSecrets(msg, urls)
    expect(out).not.toContain('user:pass')
    expect(out).not.toContain('/v1/token')
    expect(out).toContain('https://***@rpc.example.com/***')
  })

  it('leaves a message with no configured URL untouched', () => {
    expect(redactRpcSecrets('Block 123 not found', urls)).toBe('Block 123 not found')
  })

  it('keeps credential-free public endpoints readable', () => {
    const msg = 'timeout on https://bsc-dataseed1.binance.org/'
    expect(redactRpcSecrets(msg, urls)).toBe(msg)
  })

  it('masks userinfo of an URL that was never configured', () => {
    const out = redactRpcSecrets('failed https://leaked:key@other.example.com/x', urls)
    expect(out).not.toContain('leaked:key')
  })

  it('replaces every occurrence, not just the first', () => {
    const msg = 'a https://user:pass@rpc.example.com/v1/token b https://user:pass@rpc.example.com/v1/token'
    const out = redactRpcSecrets(msg, urls)
    expect(out).not.toContain('user:pass')
  })

  it('is safe when the url list is empty', () => {
    expect(redactRpcSecrets('plain message', [])).toBe('plain message')
  })

  it('does not let a regex-special character in a URL break replacement', () => {
    const tricky = ['https://rpc.example.com/a+b?x=1']
    const out = redactRpcSecrets('hit https://rpc.example.com/a+b?x=1 now', tricky)
    expect(out).toContain('https://rpc.example.com/***')
  })

  // codex P1 round 3: replacing in configuration order lets a SHORTER
  // credential-bearing URL that prefixes a longer one destroy the longer exact
  // match, leaving its suffix exposed.
  it('redacts fully when one configured URL prefixes another', () => {
    const overlapping = [
      'https://rpc.example.com/v1/token',
      'https://rpc.example.com/v1/token?apikey=SECOND',
    ]
    const out = redactRpcSecrets('failed https://rpc.example.com/v1/token?apikey=SECOND', overlapping)
    expect(out).not.toContain('SECOND')
    expect(out).not.toContain('apikey')
  })

  it('redacts fully regardless of which order the overlapping URLs are configured', () => {
    const overlapping = [
      'https://rpc.example.com/v1/token?apikey=SECOND',
      'https://rpc.example.com/v1/token',
    ]
    const out = redactRpcSecrets('failed https://rpc.example.com/v1/token?apikey=SECOND', overlapping)
    expect(out).not.toContain('SECOND')
  })
})

/**
 * codex P1 round 3. Redacting two log sites was not enough — ethers-derived
 * errors also reach the startup getBlockNumber retry, the poll-loop catch, the
 * fatal handler and the global unhandledRejection/uncaughtException handlers.
 * Handing console.error the raw Error prints its `info` property too, which is
 * where ethers parks requestUrl. Every sink formats through this instead.
 */
describe('formatRedactedError', () => {
  const urls = ['https://user:pass@rpc.example.com/v1/token']

  it('redacts credentials out of an Error message', () => {
    const err = new Error('server response 500 requestUrl="https://user:pass@rpc.example.com/v1/token"')
    const out = formatRedactedError(err, urls)
    expect(out).not.toContain('user:pass')
    expect(out).not.toContain('/v1/token')
  })

  it('preserves the stack trace for debuggability', () => {
    const err = new Error('boom')
    const out = formatRedactedError(err, urls)
    expect(out).toContain('boom')
    // A real stack, not just the message — at least one "  at <frame>" line.
    expect(out).toMatch(/\n\s+at /)
  })

  it('does not leak the credential carried in an ethers-style info property', () => {
    const err = Object.assign(new Error('server response 500'), {
      info: { requestUrl: 'https://user:pass@rpc.example.com/v1/token' },
    })
    const out = formatRedactedError(err, urls)
    expect(out).not.toContain('user:pass')
  })

  it('handles a non-Error throw', () => {
    expect(formatRedactedError('plain string failure', urls)).toBe('plain string failure')
  })

  it('handles null without throwing', () => {
    expect(formatRedactedError(null, urls)).toBe('null')
  })
})
