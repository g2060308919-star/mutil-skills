export interface LeaseRequest {
  runId: string
  resourceKey: string
  resourceFingerprint: string
  exclusive: boolean
  ttlMs: number
}

export interface DataLease {
  leaseId: string
  runId: string
  resourceKey: string
  resourceFingerprint: string
  exclusive: boolean
  status: 'tentative' | 'active' | 'quarantined' | 'released'
  fencingToken: number
  acquiredAt: string
  expiresAt: string
  cleanupDigest?: string
  quarantineReason?: string
}
