import type { APIRoute } from 'astro'
import { json } from '../../lib/http'

export const prerender = false

export const GET: APIRoute = ({ locals }) => json(locals.member)
