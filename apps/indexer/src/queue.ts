import { Queue, Worker, QueueEvents } from 'bullmq'
import IORedis from 'ioredis'

export const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
})

export const QUEUES = {
  BLOCKS: 'blocks',
  LOGS: 'logs',
  VALIDATORS: 'validators',
} as const

export const blockQueue = new Queue(QUEUES.BLOCKS, { connection })
export const logQueue = new Queue(QUEUES.LOGS, { connection })
export const validatorQueue = new Queue(QUEUES.VALIDATORS, { connection })

export { Worker }
