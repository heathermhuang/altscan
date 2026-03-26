import axios from 'axios'
import { getDb, schema } from '@bnbscan/db'

const rawSourcifyUrl = process.env.SOURCIFY_API ?? 'https://sourcify.dev/server'
// Enforce HTTPS in production to prevent MITM attacks on verification data
const SOURCIFY_API = process.env.NODE_ENV === 'production' && !rawSourcifyUrl.startsWith('https://')
  ? 'https://sourcify.dev/server'
  : rawSourcifyUrl
const BSC_CHAIN_ID = 56

export interface VerifyRequest {
  address: string
  compilerVersion?: string
  license?: string
}

export async function verifyContract(req: VerifyRequest): Promise<{ success: boolean; abi?: object[] }> {
  const db = getDb()

  const sourcifyResult = await checkSourcify(req.address)
  if (!sourcifyResult) {
    return { success: false }
  }

  await db.insert(schema.contracts).values({
    address: req.address.toLowerCase(),
    bytecode: '',
    abi: sourcifyResult.abi,
    sourceCode: sourcifyResult.sourceCode,
    compilerVersion: req.compilerVersion ?? null,
    verifiedAt: new Date(),
    verifySource: 'sourcify',
    license: req.license ?? null,
  }).onConflictDoUpdate({
    target: [schema.contracts.address],
    set: {
      abi: sourcifyResult.abi,
      sourceCode: sourcifyResult.sourceCode,
      verifiedAt: new Date(),
      verifySource: 'sourcify',
    }
  })

  return { success: true, abi: sourcifyResult.abi }
}

async function checkSourcify(address: string): Promise<{ abi: object[]; sourceCode: string } | null> {
  try {
    const res = await axios.get(
      `${SOURCIFY_API}/files/any/${BSC_CHAIN_ID}/${address}`
    )
    const files: Array<{ name: string; content: string }> = res.data?.files ?? []
    const metaFile = files.find(f => f.name.includes('metadata'))
    if (!metaFile) return null
    const meta = JSON.parse(metaFile.content)
    return {
      abi: meta.output?.abi ?? [],
      sourceCode: files.find(f => f.name.endsWith('.sol'))?.content ?? '',
    }
  } catch {
    return null
  }
}
