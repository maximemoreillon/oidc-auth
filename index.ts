import { getCookie, removeCookie } from "./storage"
import { createPkcePair } from "./pkce"

interface BaseOptions {
  authority: string
  client_id: string
  extraQueryParams?: { [key: string]: string }
}

interface Options extends BaseOptions {
  redirect_uri: string
}

interface UserOptions extends BaseOptions {
  redirect_uri?: string
}

interface OidcConfig {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  end_session_endpoint: string
}

interface User {
  name: string
  email: string
  family_name: string
  given_name: string
  [key: string]: unknown
}

interface OidcData {
  access_token: string
  refresh_token: string
  expires_at: string
  user: User
  [key: string]: unknown
}

type RefreshHandler = (oidcData: OidcData) => void

/* 
This is a class because
- It allows to get user info
- It will provide event listeners in the future
- It allows to logout (WIP)
*/

export default class {
  cookieName = "oidc"
  options: Options
  openidConfig?: OidcConfig
  refreshEventHandlers: Function[] = []

  constructor(options: UserOptions) {
    const { redirect_uri = window.location.origin, ...rest } = options

    this.options = {
      redirect_uri,
      ...rest,
    }
  }

  async init(): Promise<OidcData | undefined> {
    this.openidConfig = await this.getOidcConfig()

    const currentUrl = new URL(window.location.href)
    const code = currentUrl.searchParams.get("code")

    if (code) {
      try {
        await this.exchangeCodeForToken(code)

        // Redirect user to page originally requested
        const href = getCookie("href")
        if (href) {
          removeCookie("href")
          window.location.href = href
          return
        } else {
          window.location.href = this.options.redirect_uri
          return
        }
      } catch (error) {
        console.error(error)
        window.location.href = await this.generateAuthUrl()
        return
      }
    }

    // TODO: Is this really a good idea to have this here?
    // Keep track of where the user was going
    document.cookie = `href=${window.location.href}`

    // Check if OIDC cookie already available
    // WARNING: available does not mean valid: access token might be expired
    const oidcCookie = getCookie(this.cookieName)

    if (oidcCookie) {
      // TODO: have this here or in getUser()?
      if (this.isExpired(JSON.parse(oidcCookie).expires_at)) {
        try {
          await this.refreshAccessToken()
        } catch (error) {
          console.error(error)
          window.location.href = await this.generateAuthUrl()
        }
      }
      // Checking if user data can be queried to confirm token is valid
      const user = await this.getUser()
      // NOTE: oidc-client-ts uses "profile" as key
      if (user) {
        this.createTimeoutForTokenExpiry()
        return { ...JSON.parse(oidcCookie), user }
      }
    }

    // No access token (cookie), no user => redirect to login page

    window.location.href = await this.generateAuthUrl()
  }

  async getOidcConfig() {
    const { authority } = this.options
    const openIdConfigUrl = `${authority}/.well-known/openid-configuration`
    const response = await fetch(openIdConfigUrl)
    return await response.json()
  }

  async generateAuthUrl() {
    if (!this.openidConfig) throw new Error("OpenID config not available")

    const { verifier, challenge } = createPkcePair()
    const { client_id, redirect_uri } = this.options
    const { authorization_endpoint } = this.openidConfig

    const authUrl = new URL(authorization_endpoint)

    authUrl.searchParams.append("response_type", "code")
    authUrl.searchParams.append("client_id", client_id)
    authUrl.searchParams.append("scope", "openid profile offline_access")
    authUrl.searchParams.append("code_challenge_method", "S256")
    authUrl.searchParams.append("code_challenge", challenge)
    authUrl.searchParams.append("redirect_uri", redirect_uri)

    // Additional searchParams such as audience for Auth0
    const { extraQueryParams } = this.options

    if (extraQueryParams !== undefined) {
      Object.keys(extraQueryParams).forEach((key) => {
        authUrl.searchParams.append(key, extraQueryParams[key])
      })
    }

    document.cookie = `verifier=${verifier}`

    return authUrl.toString()
  }

  createTimeoutForTokenExpiry() {
    const oidcCookie = getCookie(this.cookieName)
    if (!oidcCookie) return

    const { expires_at } = JSON.parse(oidcCookie)

    if (!expires_at) throw new Error("Missing expires_at field in OIDC cookie")

    const expiryDate = new Date(expires_at)
    const timeLeft = expiryDate.getTime() - Date.now()

    setTimeout(() => {
      this.refreshAccessToken()
    }, timeLeft)
  }

  makeExpiryDate(expires_in: number) {
    const expiryDate = new Date()
    const time = expiryDate.getTime()
    const expiryTime = time + 1000 * expires_in
    expiryDate.setTime(expiryTime)
    return expiryDate
  }

  isExpired(expires_at: string) {
    const expiryDate = new Date(expires_at)
    return new Date().getTime() - expiryDate.getTime() > 0
  }

  saveAuthData(data: {
    expires_in: number // unit is seconds
  }) {
    const { expires_in } = data
    const expiryDate = this.makeExpiryDate(expires_in)

    // Note: not setting any expiry because refresh token needed to refresh after expiry
    document.cookie = `oidc=${JSON.stringify({
      ...data,
      expires_at: expiryDate.toUTCString(),
    })}`
  }

  async exchangeCodeForToken(code: string) {
    if (!this.openidConfig) throw new Error("OpenID config not available")

    const { token_endpoint } = this.openidConfig
    const { redirect_uri, client_id } = this.options

    const code_verifier = getCookie("verifier")
    if (!code_verifier) throw new Error("Missing verifier")
    removeCookie("verifier")

    const body = new URLSearchParams({
      code,
      code_verifier,
      redirect_uri,
      client_id,
      grant_type: "authorization_code",
    })

    const options: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    }

    const response = await fetch(token_endpoint, options)
    if (!response.ok) throw `Error getting token ${await response.text()}`

    const data = await response.json()
    this.saveAuthData(data)
  }

  async getUser() {
    // Currently returns null if user cannot be queried
    if (!this.openidConfig) throw new Error("OpenID config not available")
    const { userinfo_endpoint } = this.openidConfig

    const oidcCookie = getCookie(this.cookieName)
    if (!oidcCookie) return null

    const { access_token } = JSON.parse(oidcCookie)
    if (!access_token) return null

    const options: RequestInit = {
      headers: {
        authorization: `Bearer ${access_token}`,
      },
    }

    const response = await fetch(userinfo_endpoint, options)
    if (!response.ok) {
      // TODO: throw error or return null?
      console.error(`Error getting user info: ${await response.text()}`)
      return null
    }
    return await response.json()
  }

  async refreshAccessToken() {
    if (!this.openidConfig) throw new Error("OpenID config not available")

    const oidcCookie = getCookie(this.cookieName)
    if (!oidcCookie) throw new Error("No OIDC cookie")

    const { refresh_token } = JSON.parse(oidcCookie)
    if (!refresh_token) throw new Error("No refresh token")

    const { token_endpoint } = this.openidConfig
    const { client_id } = this.options

    const body = new URLSearchParams({
      client_id,
      grant_type: "refresh_token",
      refresh_token,
    })

    const options: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    }

    const response = await fetch(token_endpoint, options)
    if (!response.ok) throw new Error("Error refreshing token")

    const data = await response.json()

    this.saveAuthData(data)
    this.createTimeoutForTokenExpiry()
    this.runRefreshEventHandlers()
  }

  onTokenRefreshed(handler: RefreshHandler) {
    this.refreshEventHandlers.push(handler)
  }

  runRefreshEventHandlers() {
    const oidcCookie = getCookie(this.cookieName)
    if (!oidcCookie) return null
    const oidcData = JSON.parse(oidcCookie)
    this.refreshEventHandlers.forEach((handler) => handler(oidcData))
  }

  async logout() {
    if (!this.openidConfig) throw new Error("OpenID config not available")
    const { end_session_endpoint } = this.openidConfig
    const oidcCookie = getCookie(this.cookieName)
    if (!oidcCookie) throw new Error("No OIDC cookie")

    const { id_token } = JSON.parse(oidcCookie)

    const logoutUrl = new URL(end_session_endpoint)

    logoutUrl.searchParams.append("id_token_hint", id_token)

    removeCookie(this.cookieName)

    window.location.href = logoutUrl.toString()
  }
}

export type { User, UserOptions as OidcOptions, OidcConfig }
