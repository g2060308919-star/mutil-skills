(async () => {
  'use strict'
  const summary = document.querySelector('#summary')
  const confirm = document.querySelector('#confirm')
  const status = document.querySelector('#status')
  let bearer = location.hash.slice(1)
  history.replaceState(null, '', location.pathname)

  function fail(message) {
    status.textContent = message
    confirm.disabled = true
  }

  let session
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(bearer)) throw new Error('invalid bearer')
    const sessionResponse = await fetch('/session', {
      cache: 'no-store',
      headers: { authorization: `Bearer ${bearer}` },
    })
    if (!sessionResponse.ok) throw new Error('session unavailable')
    session = await sessionResponse.json()
    if (!session || !['enrollment', 'approval'].includes(session.kind)
      || typeof session.sessionId !== 'string' || typeof session.challenge !== 'string'
      || typeof session.summary !== 'string' || typeof session.options !== 'object') {
      throw new Error('invalid session')
    }
    summary.textContent = session.summary
  } catch {
    fail('审批 session 无效。')
    return
  }

  confirm.addEventListener('click', async () => {
    confirm.disabled = true
    status.textContent = '正在等待 WebAuthn 用户验证…'
    try {
      const browser = globalThis.SimpleWebAuthnBrowser
      if (!browser) throw new Error('WebAuthn browser bundle unavailable')
      const response = session.kind === 'enrollment'
        ? await browser.startRegistration({ optionsJSON: session.options })
        : await browser.startAuthentication({ optionsJSON: session.options })
      const body = {
        sessionId: session.sessionId,
        challenge: session.challenge,
        ...(session.kind === 'approval' ? { credentialId: response.id } : {}),
        response,
      }
      const result = await fetch('/submit', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!result.ok) throw new Error(`approval rejected (${result.status})`)
      status.textContent = '用户在场验证已完成，可以关闭此页面。'
      bearer = ''
      session = undefined
    } catch {
      bearer = ''
      session = undefined
      fail('用户在场验证失败；此 challenge 已作废，请重新发起审批。')
    }
  }, { once: true })
})()
