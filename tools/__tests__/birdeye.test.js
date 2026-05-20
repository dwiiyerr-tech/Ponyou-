import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isBirdeyeEnabled,
  discoverBirdeyeTokens,
  getBirdeyeMarketData,
  enrichTokensWithBirdeye,
} from '../birdeye.js'

vi.mock('../../logger.js', () => ({
  log: vi.fn(),
}))

beforeEach(() => {
  delete process.env.BIRDEYE_API_KEY
  globalThis.fetch = vi.fn()
})

function mockBirdeyeJson(data) {
  globalThis.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn(async () => data),
  })
}

describe('isBirdeyeEnabled', () => {
  it('returns false without a real API key', () => {
    expect(isBirdeyeEnabled({})).toBe(false)
    expect(isBirdeyeEnabled({ BIRDEYE_API_KEY: 'dummy-birdeye-key' })).toBe(false)
    expect(isBirdeyeEnabled({ BIRDEYE_API_KEY: 'test-birdeye-key' })).toBe(true)
  })
})

describe('discoverBirdeyeTokens', () => {
  it('returns disabled result when Birdeye is not configured', async () => {
    const result = await discoverBirdeyeTokens({ timeframe: '5m', limit: 2 })

    expect(result).toEqual({ disabled: true, tokens: [] })
    expect(globalThis.fetch.mock.calls.length).toBe(0)
  })

  it('fetches and normalizes tokens when Birdeye is configured', async () => {
    process.env.BIRDEYE_API_KEY = 'test-birdeye-key'
    mockBirdeyeJson({
      data: {
        tokens: [
          {
            address: 'Mint111111111111111111111111111111111111111',
            symbol: 'DOGE',
            name: 'Dog Token',
            price: 0.012,
            market_cap: 123000,
            liquidity: 45000,
            volume_24h_usd: 90000,
            trade_24h_count: 42,
            buy_1h: 30,
            sell_1h: 10,
            price_change_1h_percent: 12,
            dex: 'raydium',
          },
          {
            address: 'Mint222222222222222222222222222222222222222',
            symbol: 'CAT',
            name: 'Cat Token',
            priceUsd: 0.02,
            liquidityUsd: 50000,
            v24hUSD: 100000,
            trade24h: 200,
          },
        ],
      },
    })

    const result = await discoverBirdeyeTokens({ timeframe: '5m', limit: 1 })
    const [url, options] = globalThis.fetch.mock.calls[0]

    expect(result.source).toBe('birdeye')
    expect(result.tokens.length).toBe(1)
    expect(result.tokens[0]).toEqual({
      mint: 'Mint111111111111111111111111111111111111111',
      symbol: 'DOGE',
      name: 'Dog Token',
      narrative: 'DOGS',
      narrative_tags: [
        {
          narrative: 'DOGS',
          matched_keyword: 'dog',
          confidence: 0.9,
        },
      ],
      price: 0.012,
      mcap: 123000,
      liquidity: 45000,
      volume: 90000,
      swaps: 42,
      timeframe: '5m',
      hot_level: 1,
      launchpad: 'raydium',
      creator: null,
      buys: 30,
      sells: 10,
      buy_vol: 67500,
      sell_vol: 22500,
      price_change_5m: 0,
      price_change_1h: 12,
      price_change_24h: 0,
      created_at: null,
      pair_address: null,
      dex: 'raydium',
      initial_mcap: null,
      burn_ratio: null,
      renounced: null,
      is_honeypot: null,
      global_fees_sol: 0,
      birdeye: {
        source: 'birdeye',
        liquidity: 45000,
        volume_24h_usd: 90000,
        trade_24h_count: 42,
      },
    })
    expect(url.toString()).toBe('https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=20&min_liquidity=100&ui_amount_mode=scaled')
    expect(options.headers).toEqual({
      Accept: 'application/json',
      'X-API-KEY': 'test-birdeye-key',
      'x-chain': 'solana',
    })
  })
})

describe('getBirdeyeMarketData', () => {
  it('returns null when Birdeye is disabled or mint is missing', async () => {
    expect(await getBirdeyeMarketData({ mint: 'Mint111' })).toBe(null)

    process.env.BIRDEYE_API_KEY = 'test-birdeye-key'
    expect(await getBirdeyeMarketData({})).toBe(null)
    expect(globalThis.fetch.mock.calls.length).toBe(0)
  })

  it('fetches market data for a mint', async () => {
    process.env.BIRDEYE_API_KEY = 'test-birdeye-key'
    mockBirdeyeJson({
      data: {
        liquidity: 80000,
        volume_24h_usd: 160000,
        trade_24h_count: 64,
      },
    })

    const result = await getBirdeyeMarketData({ mint: 'Mint111' })
    const [url] = globalThis.fetch.mock.calls[0]

    expect(result).toEqual({
      source: 'birdeye',
      liquidity: 80000,
      volume_24h_usd: 160000,
      trade_24h_count: 64,
    })
    expect(url.toString()).toBe('https://public-api.birdeye.so/defi/v3/token/market-data?address=Mint111&ui_amount_mode=scaled')
  })
})

describe('enrichTokensWithBirdeye', () => {
  it('returns original tokens when Birdeye is disabled', async () => {
    const tokens = [{ mint: 'Mint111', liquidity: 1, volume: 2, swaps: 3 }]

    const result = await enrichTokensWithBirdeye(tokens)

    expect(result).toBe(tokens)
    expect(globalThis.fetch.mock.calls.length).toBe(0)
  })

  it('adds Birdeye market data when available', async () => {
    process.env.BIRDEYE_API_KEY = 'test-birdeye-key'
    mockBirdeyeJson({
      data: {
        liquidity: 80000,
        volume_24h_usd: 160000,
        trade_24h_count: 64,
      },
    })

    const result = await enrichTokensWithBirdeye([
      {
        mint: 'Mint111',
        source: 'dexscreener',
        liquidity: 10,
        volume: 20,
        swaps: 30,
      },
    ])

    expect(result).toEqual([
      {
        mint: 'Mint111',
        source: 'dexscreener',
        liquidity: 80000,
        volume: 160000,
        swaps: 64,
        birdeye: {
          source: 'birdeye',
          liquidity: 80000,
          volume_24h_usd: 160000,
          trade_24h_count: 64,
        },
        data_sources: ['dexscreener', 'birdeye'],
      },
    ])
  })
})
