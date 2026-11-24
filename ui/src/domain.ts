// Domain: promo-ledger entities and pure operations (leaf layer).
export interface PromoRow {
  id: string
  service: string
  subject: string
  deal: string
  status: string
  account: string
  kind: string
  expiry: string
  url: string
  proof: string
  notes: string
  date: string
  domain: string
  confidence: number
}

export const STATUSES = ['new', 'pending', 'live', 'blocked'] as const
export type Status = (typeof STATUSES)[number]

const NEXT_STATUS: Record<Status, Status> = {
  new: 'pending',
  pending: 'live',
  live: 'blocked',
  blocked: 'new',
}

export const nextStatus = (status: string): string =>
  NEXT_STATUS[status as Status] ?? 'new'

export const statusLabel = (status: string): string =>
  status.charAt(0).toUpperCase() + status.slice(1)
