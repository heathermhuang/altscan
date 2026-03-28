import { getDb, schema } from '@bnbscan/db'
import { chainConfig } from './chain'

export const db = getDb(chainConfig.dbEnvVar)
export { schema }
