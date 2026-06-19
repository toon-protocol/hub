// Apex top-up (Base Sepolia) — fund the apex's settlement account from the treasury so
// it has gas (ETH) to open/settle payment channels on-chain. Both derive from the same
// seed at different BIP-44 account indices, so this is a treasury -> apex transfer.
//
// Runs on the CI runner after `terraform apply` (the apex address is deterministic from
// the seed — no need to touch the box). EVM Base Sepolia only; Solana/Mina deferred (WS3).
//
// Env:
//   TREASURY_MNEMONIC        (required) the seed
//   TREASURY_ACCOUNT_INDEX   funded master account index (default 0)
//   APEX_ACCOUNT_INDEX       apex settlement index (default 3; MUST differ from treasury)
//   BASE_SEPOLIA_RPC         RPC URL (default https://sepolia.base.org)
//   USDC_ADDRESS             token the apex settles in (optional)
//   MIN_ETH / TOPUP_ETH      gas floor / top-up in ETH (default 0.003 / 0.01)
//   MIN_USDC / TOPUP_USDC    USDC floor / top-up, human units (default 0 / 0 = skip)
//   TOPUP_DRY_RUN            'true' = report only

import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  formatUnits,
  parseUnits,
} from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

const ERC20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
]

const env = (k, d) => process.env[k] ?? d
const MNEMONIC = process.env.TREASURY_MNEMONIC
const TREASURY_INDEX = Number(env('TREASURY_ACCOUNT_INDEX', '0'))
const APEX_INDEX = Number(env('APEX_ACCOUNT_INDEX', '3'))
const RPC = env('BASE_SEPOLIA_RPC', 'https://sepolia.base.org')
const USDC = process.env.USDC_ADDRESS
const MIN_ETH = env('MIN_ETH', '0.003')
const TOPUP_ETH = env('TOPUP_ETH', '0.01')
const MIN_USDC = env('MIN_USDC', '0')
const TOPUP_USDC = env('TOPUP_USDC', '0')
const DRY = env('TOPUP_DRY_RUN', 'false') === 'true'

const log = (m) => console.log(`[apex-topup] ${m}`)

async function main() {
  if (!MNEMONIC) throw new Error('TREASURY_MNEMONIC is required')
  if (TREASURY_INDEX === APEX_INDEX) {
    throw new Error(`TREASURY_ACCOUNT_INDEX (${TREASURY_INDEX}) must differ from APEX_ACCOUNT_INDEX (${APEX_INDEX})`)
  }

  const treasury = mnemonicToAccount(MNEMONIC, { addressIndex: TREASURY_INDEX })
  const apex = mnemonicToAccount(MNEMONIC, { addressIndex: APEX_INDEX }).address
  log(`treasury[${TREASURY_INDEX}] ${treasury.address}  ->  apex[${APEX_INDEX}] ${apex}`)
  if (DRY) log('DRY RUN — no transactions will be sent')

  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) })
  const wallet = createWalletClient({ account: treasury, chain: baseSepolia, transport: http(RPC) })

  // --- ETH (gas for on-chain settlement) ---
  const ethBal = await pub.getBalance({ address: apex })
  log(`apex ETH: ${formatEther(ethBal)} (floor ${MIN_ETH})`)
  if (ethBal < parseEther(MIN_ETH)) {
    const value = parseEther(TOPUP_ETH)
    const tBal = await pub.getBalance({ address: treasury.address })
    if (tBal < value) log(`WARN treasury ETH ${formatEther(tBal)} < top-up ${TOPUP_ETH} — skipping`)
    else if (DRY) log(`would send ${TOPUP_ETH} ETH`)
    else {
      const hash = await wallet.sendTransaction({ to: apex, value })
      log(`sent ${TOPUP_ETH} ETH, tx ${hash}`)
      await pub.waitForTransactionReceipt({ hash })
    }
  } else log('ETH sufficient')

  // --- USDC (optional; the apex usually collects via channels rather than pre-holding) ---
  if (!USDC || Number(TOPUP_USDC) <= 0) { log('USDC top-up disabled (set USDC_ADDRESS + TOPUP_USDC to enable)'); return }
  const decimals = await pub.readContract({ address: USDC, abi: ERC20, functionName: 'decimals' }).catch(() => 6)
  const usdcBal = await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [apex] })
  log(`apex USDC: ${formatUnits(usdcBal, decimals)} (floor ${MIN_USDC})`)
  if (usdcBal < parseUnits(MIN_USDC, decimals)) {
    const amount = parseUnits(TOPUP_USDC, decimals)
    const tBal = await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [treasury.address] })
    if (tBal < amount) log(`WARN treasury USDC ${formatUnits(tBal, decimals)} < top-up ${TOPUP_USDC} — skipping`)
    else if (DRY) log(`would send ${TOPUP_USDC} USDC`)
    else {
      const hash = await wallet.writeContract({ address: USDC, abi: ERC20, functionName: 'transfer', args: [apex, amount] })
      log(`sent ${TOPUP_USDC} USDC, tx ${hash}`)
      await pub.waitForTransactionReceipt({ hash })
    }
  } else log('USDC sufficient')
}

main().then(() => log('done')).catch((e) => { console.error('[apex-topup] failed:', e.shortMessage ?? e.message ?? e); process.exit(1) })
