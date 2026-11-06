import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { resolve } from 'node:path'

export const communicationIdentity = {
  identifier: 'net.processone.fluux', team: '8L55BDM864',
  entitlement: 'com.apple.developer.usernotifications.communication',
}

// Public CMS profile only: no identity lookup, signing operation or keychain access.
export function decodeProfile(path) {
  const xml = execFileSync('/usr/bin/openssl', ['smime', '-verify', '-inform', 'DER', '-noverify', '-in', path], { stdio: ['ignore', 'pipe', 'pipe'] })
  return readPlist(xml)
}

export function readPlist(bytes) {
  return JSON.parse(execFileSync('/usr/bin/python3', ['-c', `import sys,plistlib,json,datetime,base64
print(json.dumps(plistlib.loads(sys.stdin.buffer.read()), default=lambda v: base64.b64encode(v).decode() if isinstance(v,bytes) else v.isoformat()+'Z'))`], { input: bytes }).toString())
}

export function validateProfile(profile, { team = communicationIdentity.team, now = new Date(), identifier = communicationIdentity.identifier } = {}) {
  const identity = communicationIdentity
  if (![identity.identifier, devCommunicationIdentifier].includes(identifier)) throw new Error('Communication profile: unsupported application identifier')
  const entitlements = profile.Entitlements || {}
  if (team !== identity.team || JSON.stringify(profile.TeamIdentifier) !== JSON.stringify([identity.team])) throw new Error('Communication profile: wrong team')
  if (entitlements['com.apple.application-identifier'] !== `${team}.${identifier}`
      || entitlements['com.apple.developer.team-identifier'] !== team) throw new Error('Communication profile: wrong application or team entitlement')
  if (entitlements[identity.entitlement] !== true) throw new Error('Communication profile: capability not authorized')
  if (!profile.Platform?.includes('OSX') || profile.ProvisionsAllDevices !== true || 'ProvisionedDevices' in profile) throw new Error('Communication profile: requires Developer ID all-Mac distribution without a device list')
  const minimum = new Date(now)
  minimum.setUTCFullYear(minimum.getUTCFullYear() + 5)
  const expiry = new Date(profile.ExpirationDate)
  if (!Number.isFinite(expiry.getTime()) || expiry < minimum) throw new Error('Communication profile: expiry must be at least five years away')
  if (!profile.DeveloperCertificates?.length) throw new Error('Communication profile: missing signing certificates')
  return profile
}

export const devCommunicationIdentifier = 'net.processone.fluux.dev'

// Match only public profile certificates. Never search a keychain or infer approval from a name.
export function validateDevSigner(profile, signingIdentity, team, now = new Date()) {
  if (!signingIdentity || signingIdentity === '-') throw new Error('Dev communication requires an explicit Developer ID signing identity')
  for (const encoded of profile.DeveloperCertificates || []) {
    const certificate = new X509Certificate(Buffer.from(encoded, 'base64'))
    const subject = certificate.toLegacyObject().subject
    const fingerprint = certificate.fingerprint.replaceAll(':', '')
    if (signingIdentity !== subject.CN && signingIdentity.toUpperCase() !== fingerprint) continue
    const details = execFileSync('/usr/bin/openssl', ['x509', '-inform', 'DER', '-noout', '-text'], { input: certificate.raw }).toString()
    if (!subject.CN?.startsWith('Developer ID Application: ') || subject.OU !== team
        || !details.includes('1.2.840.113635.100.6.1.13:')
        || now < new Date(certificate.validFrom) || now >= new Date(certificate.validTo)) continue
    return certificate
  }
  throw new Error('Dev communication requires a valid Developer ID Application certificate listed in the profile')
}

export function validateCommunicationConfig(config, settings, root) {
  if (!settings.communication) return
  if (!settings.team) throw new Error('Communication build requires a known Apple team')
  const mapped = config.bundle?.macOS?.files?.['embedded.provisionprofile']
  if (typeof mapped !== 'string' || !mapped) throw new Error('Communication build requires an embedded.provisionprofile mapping')
  const profile = validateProfile(decodeProfile(resolve(root, mapped)), { team: settings.team, identifier: settings.identifier })
  if (settings.identifier === devCommunicationIdentifier) validateDevSigner(profile, settings.signingIdentity, settings.team)
  console.error(`Communication profile validated: ${profile.Name}; expires ${profile.ExpirationDate}`)
}

export function assertProfileCovers(profile, entitlements, certificate, { identifier = communicationIdentity.identifier } = {}) {
  validateProfile(profile, { identifier })
  for (const key of [communicationIdentity.entitlement, 'com.apple.application-identifier', 'com.apple.developer.team-identifier']) {
    if (entitlements[key] !== profile.Entitlements[key]) throw new Error(`Signed entitlement not covered by profile: ${key}`)
  }
  // Application Groups are generated by the unchanged Share Extension integration.
  for (const key of ['com.apple.security.application-groups', 'keychain-access-groups']) {
    for (const value of entitlements[key] || []) {
      if (!(profile.Entitlements[key] || []).some(allowed => allowed === value || (allowed.endsWith('*') && value.startsWith(allowed.slice(0, -1))))) {
        throw new Error(`Signed entitlement not covered by profile: ${key}`)
      }
    }
  }
  if (!profile.DeveloperCertificates.some(encoded => Buffer.from(encoded, 'base64').equals(certificate))) throw new Error('Signing certificate is not listed in embedded profile')
}
