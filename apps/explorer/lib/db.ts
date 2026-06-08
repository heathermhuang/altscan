import { getDb, schema } from '@altscan/db'
import { chainConfig } from './chain'

export const db = getDb(chainConfig.dbEnvVar)
export { schema }
