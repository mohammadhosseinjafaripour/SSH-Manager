import { describe, expect, it } from 'vitest'
import { describeNetworkError } from '../shared/network'

/**
 * The Settings panel used to print Chromium net errors verbatim, so a laptop
 * with no Wi-Fi showed "Could not check for updates:
 * net::ERR_CONNECTION_TIMED_OUT". These tests pin the translation, including
 * that we never lose information for genuinely unexpected failures.
 */

describe('describeNetworkError', () => {
  it('names a dropped connection instead of echoing the Chromium code', () => {
    const result = describeNetworkError('net::ERR_CONNECTION_TIMED_OUT')
    expect(result.text).toBe(
      'The connection timed out. A firewall, VPN, or proxy may be blocking GitHub.'
    )
    expect(result.text).not.toContain('net::')
    expect(result.offline).toBe(true)
  })

  it('treats a fully disconnected machine as offline and tells the user it retries', () => {
    const result = describeNetworkError('net::ERR_INTERNET_DISCONNECTED')
    expect(result.text).toContain('No internet connection')
    expect(result.text).toContain('retry')
    expect(result.offline).toBe(true)
  })

  it('explains DNS failures', () => {
    expect(describeNetworkError('net::ERR_NAME_NOT_RESOLVED').text).toContain('DNS')
  })

  it('explains TLS interception rather than blaming the network', () => {
    const result = describeNetworkError('net::ERR_CERT_AUTHORITY_INVALID')
    expect(result.text).toContain('secure connection')
    // A certificate problem is not a transient offline condition.
    expect(result.offline).toBe(false)
  })

  it('matches the error code when Electron wraps it in a sentence', () => {
    const result = describeNetworkError(
      'Error: net::ERR_CONNECTION_TIMED_OUT at SimpleURLLoaderWrapper'
    )
    expect(result.text).not.toContain('SimpleURLLoaderWrapper')
  })

  it('matches the code case-insensitively', () => {
    expect(describeNetworkError('err_connection_refused').text).toContain('refused')
  })

  it('keeps an unrecognised message rather than replacing it with a vague one', () => {
    const result = describeNetworkError('Some brand new updater failure')
    expect(result.text).toBe('Some brand new updater failure')
    expect(result.offline).toBe(false)
  })

  it('never returns an empty sentence', () => {
    expect(describeNetworkError('').text.length).toBeGreaterThan(0)
    expect(describeNetworkError(undefined as unknown as string).text.length).toBeGreaterThan(0)
  })

  it('never leaks the raw "net::" prefix for any known error', () => {
    const codes = [
      'net::ERR_INTERNET_DISCONNECTED',
      'net::ERR_NETWORK_CHANGED',
      'net::ERR_TIMED_OUT',
      'net::ERR_NAME_NOT_RESOLVED',
      'net::ERR_CONNECTION_REFUSED',
      'net::ERR_CONNECTION_RESET',
      'net::ERR_CONNECTION_CLOSED',
      'net::ERR_CONNECTION_ABORTED',
      'net::ERR_CERT_DATE_INVALID',
      'net::ERR_PROXY_CONNECTION_FAILED',
      'net::ERR_TUNNEL_CONNECTION_FAILED'
    ]
    for (const code of codes) {
      expect(describeNetworkError(code).text).not.toContain('net::')
    }
  })
})
