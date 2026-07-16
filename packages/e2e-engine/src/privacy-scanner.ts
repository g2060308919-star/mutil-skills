import {
  digestText,
  type DataClassification,
  type PrivacyScanFinding,
} from '@mutil-skills/e2e-contracts'

export interface PrivacyScanner {
  readonly version: string
  scan(input: { bytes: Uint8Array; scope: string }): PrivacyScanFinding[]
}

interface Detector {
  id: string
  classification: DataClassification
  severity: PrivacyScanFinding['severity']
  pattern: RegExp
  accept?: (match: string) => boolean
}

const DETECTORS: Detector[] = [
  {
    id: 'credential-bearer-token-v1', classification: 'credential', severity: 'critical',
    pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}\b/giu,
  },
  {
    id: 'government-id-cn-v1', classification: 'government-id', severity: 'high',
    pattern: /\b\d{17}[0-9X]\b/giu,
  },
  {
    id: 'financial-card-luhn-v1', classification: 'financial', severity: 'high',
    pattern: /\b(?:\d[ -]?){13,19}\b/gu,
    accept: luhnValid,
  },
  {
    id: 'health-record-marker-v1', classification: 'health', severity: 'high',
    pattern: /\b(?:medical-record|patient-id)\s*[:=]\s*[A-Za-z0-9._-]{3,}\b/giu,
  },
  {
    id: 'contact-email-v1', classification: 'contact', severity: 'medium',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  },
  {
    id: 'contact-phone-v1', classification: 'contact', severity: 'medium',
    pattern: /(?<![A-Za-z0-9])(?:\+?86[- ]?)?1[3-9]\d[- ]?\d{4}[- ]?\d{4}(?![A-Za-z0-9])/gu,
  },
]

export const PRIVACY_CANARIES: ReadonlyArray<{
  id: string
  classification: DataClassification
  sample: string
}> = [
  { id: 'canary-credential-v1', classification: 'credential', sample: 'Bearer canary-secret-token' },
  { id: 'canary-government-id-v1', classification: 'government-id', sample: '11010519491231002X' },
  { id: 'canary-financial-v1', classification: 'financial', sample: '4111 1111 1111 1111' },
  { id: 'canary-health-v1', classification: 'health', sample: 'medical-record: CANARY-42' },
  { id: 'canary-contact-v1', classification: 'contact', sample: 'canary@example.test' },
]

export class PatternPrivacyScanner implements PrivacyScanner {
  readonly version: string

  constructor(version: string) {
    this.version = version
  }

  scan(input: { bytes: Uint8Array; scope: string }): PrivacyScanFinding[] {
    const text = Buffer.from(input.bytes).toString('utf8')
    const findings: PrivacyScanFinding[] = []
    for (const detector of DETECTORS) {
      detector.pattern.lastIndex = 0
      for (const match of text.matchAll(detector.pattern)) {
        const value = match[0]
        if (detector.accept && !detector.accept(value)) continue
        findings.push({
          classification: detector.classification,
          severity: detector.severity,
          detectorId: detector.id,
          location: `${input.scope}:char-${match.index ?? 0}`,
          matchDigest: digestText('privacy-scan-match/v1', value),
        })
      }
    }
    return findings
  }
}

function luhnValid(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}
