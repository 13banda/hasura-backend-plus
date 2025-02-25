import { JWT as CONFIG_JWT, REGISTRATION } from './config'
import { JWK, JWKS, JWT } from 'jose'

import fs from 'fs'
import kebabCase from 'lodash.kebabcase'
import { Claims, Token, AccountData, ClaimValueType, PermissionVariables } from './types'

const RSA_TYPES = ['RS256', 'RS384', 'RS512']
const SHA_TYPES = ['HS256', 'HS384', 'HS512']

let jwtKey: string | JWK.RSAKey | JWK.ECKey | JWK.OKPKey | JWK.OctKey = CONFIG_JWT.KEY

/**
 * * Sets the JWT Key.
 * * If RSA algorithm, then checks if the PEM has been passed on through the JWT_KEY
 * * If not, tries to read the private.pem file, or generates it otherwise
 * * If SHA algorithm, then uses the JWT_KEY environment variables
 */
if (RSA_TYPES.includes(CONFIG_JWT.ALGORITHM)) {
  if (jwtKey) {
    try {
      jwtKey = JWK.asKey(jwtKey, { alg: CONFIG_JWT.ALGORITHM })
      jwtKey.toPEM(true)
    } catch (error) {
      throw new Error('Invalid RSA private key in the JWT_KEY environment variable.')
    }
  } else {
    try {
      const file = fs.readFileSync(CONFIG_JWT.KEY_FILE_PATH)
      jwtKey = JWK.asKey(file)
    } catch (error) {
      jwtKey = JWK.generateSync('RSA', 2048, { alg: CONFIG_JWT.ALGORITHM, use: 'sig' }, true)
      fs.writeFileSync(CONFIG_JWT.KEY_FILE_PATH, jwtKey.toPEM(true))
    }
  }
} else if (SHA_TYPES.includes(CONFIG_JWT.ALGORITHM)) {
  if (!jwtKey) {
    throw new Error('Empty JWT secret key.')
  }
} else {
  throw new Error(`Invalid JWT algorithm: ${CONFIG_JWT.ALGORITHM}`)
}

export const newJwtExpiry = CONFIG_JWT.EXPIRES_IN * 60 * 1000

/**
 * Convert array to Postgres array
 * @param arr js array to be converted to Postgres array
 */
function toPgArray(arr: string[]): string {
  const m = arr.map((e) => `"${e}"`).join(',')
  return `{${m}}`
}

/**
 * Create an object that contains all the permission variables of the user,
 * i.e. user-id, allowed-roles, default-role and the kebab-cased columns
 * of the public.tables columns defined in JWT_CUSTOM_FIELDS
 * @param jwt if true, add a 'x-hasura-' prefix to the property names, and stringifies the values (required by Hasura)
 */
export function generatePermissionVariables(
  { default_role, account_roles = [], user }: AccountData,
  jwt = false
): { [key: string]: ClaimValueType } {
  const prefix = jwt ? 'x-hasura-' : ''
  const role = user.is_anonymous
    ? REGISTRATION.DEFAULT_ANONYMOUS_ROLE
    : default_role || REGISTRATION.DEFAULT_USER_ROLE
  const accountRoles = account_roles.map(({ role: roleName }) => roleName)

  if (!accountRoles.includes(role)) {
    accountRoles.push(role)
  }

  return {
    [`${prefix}user-id`]: user.id,
    [`${prefix}allowed-roles`]: accountRoles,
    [`${prefix}default-role`]: role,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...CONFIG_JWT.CUSTOM_FIELDS.reduce<{ [key: string]: ClaimValueType }>((aggr: any, cursor) => {
      const type = typeof user[cursor] as ClaimValueType

      let value
      if (type === 'string') {
        value = user[cursor]
      } else if (Array.isArray(user[cursor])) {
        value = toPgArray(user[cursor] as string[])
      } else {
        value = JSON.stringify(user[cursor] ?? null)
      }

      aggr[`${prefix}${kebabCase(cursor)}`] = value

      return aggr
    }, {})
  }
}

/**
 * * Creates a JWKS store. Only works with RSA algorithms. Raises an error otherwise
 * @returns JWKS store
 */
export const getJwkStore = (): JWKS.KeyStore => {
  if (RSA_TYPES.includes(CONFIG_JWT.ALGORITHM)) {
    const keyStore = new JWKS.KeyStore()
    keyStore.add(jwtKey as JWK.RSAKey)
    return keyStore
  }
  throw new Error('JWKS is not implemented on this server.')
}

/**
 * * Signs a payload with the existing JWT configuration
 */
export const sign = (payload: object, accountData: AccountData): string =>
  JWT.sign(payload, jwtKey, {
    algorithm: CONFIG_JWT.ALGORITHM,
    expiresIn: `${CONFIG_JWT.EXPIRES_IN}m`,
    subject: accountData.user.id,
    issuer: 'nhost'
  })

/**
 * Verify JWT token and return the Hasura claims.
 * @param authorization Authorization header.
 */
export const getClaims = (authorization: string | undefined): Claims => {
  if (!authorization) throw new Error('Missing Authorization header.')
  const token = authorization.replace('Bearer ', '')
  try {
    const decodedToken = JWT.verify(token, jwtKey) as Token
    if (!decodedToken[CONFIG_JWT.CLAIMS_NAMESPACE]) throw new Error('Claims namespace not found.')
    return decodedToken[CONFIG_JWT.CLAIMS_NAMESPACE]
  } catch (err) {
    throw new Error('Invalid or expired JWT token.')
  }
}

export const getPermissionVariablesFromClaims = (claims: Claims): PermissionVariables => {
  // remove `x-hasura-` from claim props
  const claims_sanatized: { [k: string]: any } = {}
  for (const claimKey in claims) {
    claims_sanatized[claimKey.replace('x-hasura-', '') as string] = claims[claimKey]
  }

  return claims_sanatized as PermissionVariables
}

/**
 * Create JWT token.
 */
export const createHasuraJwt = (accountData: AccountData): string =>
  sign(
    {
      [CONFIG_JWT.CLAIMS_NAMESPACE]: generatePermissionVariables(accountData, true)
    },
    accountData
  )
