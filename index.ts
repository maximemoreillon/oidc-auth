import { getCookie, removeCookie } from "./storage"
import { createPkcePair } from "./pkce"
type UserOptions = {
  authority: string
  client_id: string
  redirect_uri?: string

  // TODO: typing
  extraQueryParams?: any
}

type Options = {
  authority: string
  client_id: string
  redirect_uri: string

  // TODO: typing
  extraQueryParams?: any
}

type OidcConfig = {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  end_session_endpoint: string
}

type RefreshHandler = (oidcData: any) => void

/* 
This is a class because
- It allows to get user info
- It will provide event listeners in the future
- It allows to logout (WIP)
*/

export default class {
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

  async init() {
    this.openidConfig = await this.getOidcConfig()

    this.createTimeoutForTokenExpiry()

    // Check if OIDC cookie already available
    // WARNING: available does not mean valid
    const oidcCookie = getCookie("oidc")
    if (oidcCookie) {
      const user = await this.getUser()
      // NOTE: oidc-client-ts uses "profile" as key
      if (user) return { ...JSON.parse(oidcCookie), user }
    }

    const currentUrl = new URL(window.location.href)
    const code = currentUrl.searchParams.get("code")

    if (code) {
      await this.exchangeCodeForToken(code)
      const href = getCookie("href")

      if (href) {
        removeCookie("href")
        window.location.href = href
      } else {
        window.location.href = this.options.redirect_uri
      }
    } else {
      // No access token, no code => redirect to login page
      const authUrl = await this.generateAuthUrl()

      // Keep track of where the user was going
      document.cookie = `href=${window.location.href}`

      window.location.href = authUrl
    }
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
    authUrl.searchParams.append("scope", "openid profile")
    authUrl.searchParams.append("code_challenge_method", "S256")
    authUrl.searchParams.append("code_challenge", challenge)
    authUrl.searchParams.append("redirect_uri", redirect_uri)

    // Additional searchParams such as audience for Auth0
    Object.keys(this.options.extraQueryParams).forEach((key) => {
      authUrl.searchParams.append(key, this.options.extraQueryParams[key])
    })

    document.cookie = `verifier=${verifier}`

    return authUrl.toString()
  }

  createTimeoutForTokenExpiry() {
    const expiry = getCookie("expiry")
    if (!expiry) return

    const expiryDate = new Date(expiry)
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

  saveAuthData(data: {
    expires_in: number // unit is seconds
  }) {
    const { expires_in } = data
    const expiryDate = this.makeExpiryDate(expires_in)
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

    removeCookie("verifier")

    const data = await response.json()
    this.saveAuthData(data)
  }

  async getUser() {
    // Currently returns undefined if user cannot be queried
    if (!this.openidConfig) throw new Error("OpenID config not available")
    const { userinfo_endpoint } = this.openidConfig

    // const access_token = getCookie("access_token")
    const oidcCookie = getCookie("oidc")
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
      console.error(`Error getting user info: ${await response.text()}`)
      return
    }
    return await response.json()
  }

  async refreshAccessToken() {
    if (!this.openidConfig) throw new Error("OpenID config not available")

    const oidcCookie = getCookie("oidc")
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
    const oidcCookie = getCookie("oidc")
    if (!oidcCookie) return null
    const oidcData = JSON.parse(oidcCookie)
    this.refreshEventHandlers.forEach((handler) => handler(oidcData))
  }

  logout() {
    if (!this.openidConfig) throw new Error("OpenID config not available")
    const { end_session_endpoint } = this.openidConfig
    // TODO: implement logout
  }
}
