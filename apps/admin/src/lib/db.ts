import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from './schema'

export function getDb(env: Env) {
  return drizzle(env.DB, { schema })
}

export async function getExplorer(env: Env, id: string) {
  const rows = await getDb(env)
    .select()
    .from(schema.explorers)
    .where(eq(schema.explorers.id, id))
    .limit(1)
  return rows[0] ?? null
}
