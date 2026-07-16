import { describe, expect, test } from 'vitest'
import { PatternPrivacyScanner } from '../src/index.js'

describe('PatternPrivacyScanner 联系方式边界', () => {
  const scanner = new PatternPrivacyScanner('1.1.0')

  test('识别独立的中国大陆手机号', () => {
    const findings = scanner.scan({
      bytes: Buffer.from('{"phone":"13812345678"}', 'utf8'),
      scope: 'artifact',
    })

    expect(findings.map((finding) => finding.detectorId)).toContain('contact-phone-v1')
  })

  test.each(['138 1234 5678', '138-1234-5678', '+86 138 1234 5678'])(
    '识别常见分隔格式的中国大陆手机号：%s',
    (phone) => {
      const findings = scanner.scan({
        bytes: Buffer.from(JSON.stringify({ phone }), 'utf8'),
        scope: 'artifact',
      })

      expect(findings.map((finding) => finding.detectorId)).toContain('contact-phone-v1')
    },
  )

  test('不把十六进制摘要内部的随机数字片段识别为手机号', () => {
    const findings = scanner.scan({
      bytes: Buffer.from('{"signedDigest":"sha256:abc13812345678def"}', 'utf8'),
      scope: 'artifact',
    })

    expect(findings.map((finding) => finding.detectorId)).not.toContain('contact-phone-v1')
  })
})
