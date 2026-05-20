import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockConnection, mockGetRecentPrioritizationFees } = vi.hoisted(() => {
  const mockGetRecentPrioritizationFees = vi.fn()
  const mockConnection = vi.fn(function Connection(url, commitment) {
    this.url = url
    this.commitment = commitment
    this.getRecentPrioritizationFees = mockGetRecentPrioritizationFees
  })

  return { mockConnection, mockGetRecentPrioritizationFees }
})

vi.mock('@solana/web3.js', () => ({
  Connection: mockConnection,
}))

vi.mock('../../logger.js', () => ({
  log: vi.fn(),
}))

import { getSolanaGasFee } from '../solana-rpc.js'

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.RPC_URL
  delete process.env.HELIUS_RPC_URL
})

describe('getSolanaGasFee', () => {
  it.each([
    [
      'low',
      [1000, 2000, 3000],
      { avg: 2000, median: 2000, level: 'low', unit: 'micro-lamports' },
    ],
    [
      'medium',
      [10000, 20000, 30000],
      { avg: 20000, median: 20000, level: 'medium', unit: 'micro-lamports' },
    ],
    [
      'high',
      [100000, 200000, 300000],
      { avg: 200000, median: 200000, level: 'high', unit: 'micro-lamports' },
    ],
    [
      'extreme',
      [500000, 600000, 700000],
      { avg: 600000, median: 600000, level: 'extreme', unit: 'micro-lamports' },
    ],
  ])('returns %s level fee data', async (level, fees, expected) => {
    mockGetRecentPrioritizationFees.mockResolvedValue(
      fees.map(prioritizationFee => ({ prioritizationFee })),
    )

    const result = await getSolanaGasFee()

    expect(result).toEqual(expected)
    expect(mockConnection.mock.calls[0]).toEqual([
      'https://api.mainnet-beta.solana.com',
      'confirmed',
    ])
    expect(level).toBe(expected.level)
  })

  it('returns low fee data when RPC returns no fees', async () => {
    mockGetRecentPrioritizationFees.mockResolvedValue([])

    const result = await getSolanaGasFee()

    expect(result).toEqual({ avg: 0, median: 0, level: 'low' })
  })

  it('returns unknown level when RPC throws', async () => {
    mockGetRecentPrioritizationFees.mockRejectedValue(new Error('RPC failed'))

    const result = await getSolanaGasFee()

    expect(result).toEqual({
      error: 'RPC failed',
      avg: 0,
      median: 0,
      level: 'unknown',
    })
  })

  it('prefers HELIUS_RPC_URL over RPC_URL when configured', async () => {
    process.env.HELIUS_RPC_URL = 'https://helius.example'
    process.env.RPC_URL = 'https://rpc.example'
    mockGetRecentPrioritizationFees.mockResolvedValue([])

    await getSolanaGasFee()

    expect(mockConnection.mock.calls[0]).toEqual([
      'https://helius.example',
      'confirmed',
    ])
  })
})
