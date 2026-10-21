import { getCookie, removeCookie } from "./storage.js"
import { createPkcePair, generateState } from "./pkce.js"

export interface BaseOptions {
  authority: string
  client_id: string
  extraQueryParams?: { [key: string]: string }
}

export interface Options extends BaseOptions {
  redirect_uri: string
}

export interface UserProvidedOptions extends BaseOptions {
  redirect_uri?: string
}

export interface OidcConfig {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  end_session_endpoint: string
}

export interface User {
  name: string
  email: string
  family_name: string
  given_name: string
  [key: string]: unknown
}

export interface Tokens {
  access_token: string
  refresh_token: string
  id_token?: string
  expires_at: string
  scope: string
  [key: string]: unknown
}

export interface InitOutput {
  tokens: Tokens
  user: User
}

// Login started by this client, waiting for the provider to redirect back
interface PendingLogin {
  verifier: string
  href: string
  created_at: number
}

type TokenResponse = { expires_in: number; [key: string]: unknown }
type RefreshHandler = (tokens: Tokens) => void
type RefreshErrorHandler = (error: unknown) => void
type LogoutHandler = () => void

// The provider rejected the tokens: the session is over, unlike with network or server errors
export class TokenRejectedError extends Error {
  name = "TokenRejectedError"
}

// Refresh this long before the access token expires (seconds)
const REFRESH_MARGIN = 60
// Delay between retries of a failed refresh while the access token is still valid (seconds)
const REFRESH_RETRY_DELAY = 10
// Pending logins older than this are discarded (seconds)
const PENDING_LOGIN_TTL = 3600

/*
This is a class because
- It allows to get user info
- It provides event listeners
- It allows to logout
*/

export default class {
  // Key of the tokens in localStorage, also the name of the cookie used by v3 and earlier
  storageKey = "oidc"
  options: Options
  openidConfig?: OidcConfig
  refreshEventHandlers: RefreshHandler[] = []
  refreshErrorHandlers: RefreshErrorHandler[] = []
  logoutHandlers: LogoutHandler[] = []
  refreshTimeout?: ReturnType<typeof setTimeout>

  constructor(options: UserProvidedOptions) {
    const { redirect_uri = window.location.origin, ...rest } = options

    this.options = {
      redirect_uri,
      ...rest,
    }

    window.addEventListener("storage", this.handleStorageEvent)
  }

  // Throws on network or server errors, in which case tokens are kept so that a reload can recover
  async init(enforce: boolean = true): Promise<InitOutput | undefined> {
    this.openidConfig = await this.fetchOidcConfig()

    const currentUrl = new URL(window.location.href)
    if (this.isLoginCallback(currentUrl)) {
      await this.handleLoginCallback(currentUrl)
      return
    }

    // WARNING: available does not mean valid: access token might be expired
    let tokens = this.getTokens()

    if (tokens) {
      try {
        if (this.isExpired(tokens.expires_at)) {
          console.warn("Access token was initially expired, refreshing...")
          tokens = await this.refreshAccessToken()
          console.info("Initially expired access token has been refreshed")
        }

        // Checking if user data can be queried to confirm token is valid
        const user = await this.getUser()
        this.scheduleRefresh()
        return { tokens, user }
      } catch (error) {
        if (!(error instanceof TokenRejectedError)) throw error
        console.warn("Tokens rejected by the provider", error)
        this.removeTokens()
      }
    }

    // No valid tokens => redirect to login page
    if (enforce) this.sendUserToAuthUrl(true)
  }

  redirect(url: string) {
    window.location.href = url
  }

  async sendUserToAuthUrl(saveHref: boolean) {
    const returnTo = saveHref ? window.location.href : undefined
    this.redirect(await this.generateAuthUrl(returnTo))
  }

  async fetchOidcConfig(): Promise<OidcConfig> {
    const { authority } = this.options
    const openIdConfigUrl = `${authority}/.well-known/openid-configuration`
    const response = await fetch(openIdConfigUrl)
    if (!response.ok)
      throw new Error(
        `Error fetching OIDC config from ${openIdConfigUrl}: ${response.status}`
      )
    return await response.json()
  }

  async generateAuthUrl(returnTo = this.options.redirect_uri) {
    if (!this.openidConfig) throw new Error("OpenID config not available")

    const { verifier, challenge } = createPkcePair()
    const state = generateState()
    const { client_id, redirect_uri } = this.options
    const { authorization_endpoint } = this.openidConfig

    const authUrl = new URL(authorization_endpoint)

    // TODO: have scope configurable
    authUrl.searchParams.append("scope", "openid profile offline_access")
    authUrl.searchParams.append("response_type", "code")
    authUrl.searchParams.append("code_challenge_method", "S256")
    authUrl.searchParams.append("code_challenge", challenge)
    authUrl.searchParams.append("client_id", client_id)
    authUrl.searchParams.append("redirect_uri", redirect_uri)
    authUrl.searchParams.append("state", state)

    // Additional searchParams such as audience
    const { extraQueryParams } = this.options
    if (extraQueryParams !== undefined) {
      Object.keys(extraQueryParams).forEach((key) => {
        authUrl.searchParams.append(key, extraQueryParams[key])
      })
    }

    this.savePendingLogin(state, {
      verifier,
      href: returnTo,
      created_at: Date.now(),
    })

    return authUrl.toString()
  }

  // Keyed by state so that concurrent logins (e.g. in multiple tabs) do not overwrite each other
  get pendingLoginsKey() {
    return `${this.storageKey}-login`
  }

  getPendingLogins(): Record<string, PendingLogin> {
    try {
      return JSON.parse(localStorage.getItem(this.pendingLoginsKey) ?? "{}")
    } catch {
      return {}
    }
  }

  savePendingLogin(state: string, login: PendingLogin) {
    const logins = this.getPendingLogins()
    const now = Date.now()
    for (const [key, { created_at }] of Object.entries(logins)) {
      if (now - created_at > PENDING_LOGIN_TTL * 1000) delete logins[key]
    }
    logins[state] = login
    localStorage.setItem(this.pendingLoginsKey, JSON.stringify(logins))
  }

  takePendingLogin(state: string) {
    const logins = this.getPendingLogins()
    const login = logins[state]
    delete logins[state]
    localStorage.setItem(this.pendingLoginsKey, JSON.stringify(logins))
    return login
  }

  // Only the redirect of a login started by this client counts, not any URL with a "code" parameter
  isLoginCallback(url: URL) {
    const redirectUrl = new URL(this.options.redirect_uri)
    const state = url.searchParams.get("state")

    return (
      url.origin === redirectUrl.origin &&
      url.pathname === redirectUrl.pathname &&
      (url.searchParams.has("code") || url.searchParams.has("error")) &&
      state !== null &&
      state in this.getPendingLogins()
    )
  }

  async handleLoginCallback(url: URL) {
    const { verifier, href } = this.takePendingLogin(
      url.searchParams.get("state") as string
    )

    const error = url.searchParams.get("error")
    if (error) {
      const description = url.searchParams.get("error_description")
      throw new Error(`Login failed: ${description ?? error}`)
    }

    await this.exchangeCodeForToken(url.searchParams.get("code") as string, verifier)

    // Back to the page originally requested
    this.redirect(href)
  }

  scheduleRefresh(delay?: number) {
    clearTimeout(this.refreshTimeout)

    const tokens = this.getTokens()
    if (!tokens) return

    if (delay === undefined) {
      const timeLeft = new Date(tokens.expires_at).getTime() - Date.now()
      // Halfway through for tokens too short-lived for the margin, to avoid a refresh loop
      delay = Math.max(timeLeft - REFRESH_MARGIN * 1000, timeLeft / 2, 0)
    }

    this.refreshTimeout = setTimeout(() => {
      this.refreshAccessToken().catch((error) => this.handleRefreshError(error))
    }, delay)
  }

  handleRefreshError(error: unknown) {
    if (error instanceof TokenRejectedError) {
      console.error("Tokens rejected by the provider", error)
      this.removeTokens()
      this.refreshErrorHandlers.forEach((handler) => handler(error))
      this.logoutHandlers.forEach((handler) => handler())
      return
    }

    // Transient failures (e.g. network) are retried as long as the access token remains usable
    const tokens = this.getTokens()
    if (tokens && !this.isExpired(tokens.expires_at)) {
      console.warn("Token refresh failed, retrying...", error)
      this.scheduleRefresh(REFRESH_RETRY_DELAY * 1000)
      return
    }

    console.error("Token refresh failed", error)
    this.refreshErrorHandlers.forEach((handler) => handler(error))
  }

  // Keeps tabs in sync: a refresh or logout in one tab updates localStorage, which notifies the others
  handleStorageEvent = (event: StorageEvent) => {
    if (event.key !== this.storageKey || !this.openidConfig) return

    if (!event.newValue) {
      clearTimeout(this.refreshTimeout)
      this.logoutHandlers.forEach((handler) => handler())
      return
    }

    this.scheduleRefresh()
    this.runRefreshEventHandlers()
  }

  makeExpiryDate(expires_in: number) {
    // unit of expires_in is seconds
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

  getTokens(): Tokens | null {
    const stored =
      localStorage.getItem(this.storageKey) ?? this.migrateLegacyCookie()
    if (!stored) return null
    return JSON.parse(stored)
  }

  // Up to v3, tokens were stored in a cookie: move them to localStorage so users stay logged in
  migrateLegacyCookie() {
    const cookie = getCookie(this.storageKey)
    if (!cookie) return null

    removeCookie(this.storageKey)

    // Cookie values were written unencoded but can come back URL encoded
    const value = cookie.startsWith("{") ? cookie : decodeURIComponent(cookie)
    localStorage.setItem(this.storageKey, value)
    return value
  }

  // Refresh responses can omit tokens that remain valid (e.g. refresh_token, id_token), hence the merge with previous tokens
  saveTokens(data: TokenResponse, previousTokens?: Tokens | null): Tokens {
    const expiryDate = this.makeExpiryDate(data.expires_in)

    const tokens = {
      ...previousTokens,
      ...data,
      expires_at: expiryDate.toUTCString(),
    } as Tokens

    localStorage.setItem(this.storageKey, JSON.stringify(tokens))

    return tokens
  }

  removeTokens() {
    clearTimeout(this.refreshTimeout)
    localStorage.removeItem(this.storageKey)
    removeCookie(this.storageKey)
  }

  async exchangeCodeForToken(code: string, code_verifier: string) {
    if (!this.openidConfig) throw new Error("OpenID config not available")

    const { token_endpoint } = this.openidConfig
    const { redirect_uri, client_id } = this.options

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
    if (!response.ok)
      throw new Error(`Error getting token ${await response.text()}`)

    const data = await response.json()
    this.saveTokens(data)
  }

  async getUser(): Promise<User> {
    if (!this.openidConfig) throw new Error("OpenID config not available")
    const { userinfo_endpoint } = this.openidConfig

    const access_token = this.getTokens()?.access_token
    if (!access_token) throw new TokenRejectedError("No access token")

    const options: RequestInit = {
      headers: {
        authorization: `Bearer ${access_token}`,
      },
    }

    const response = await fetch(userinfo_endpoint, options)
    if (!response.ok) {
      const message = `Error getting user info: ${await response.text()}`
      if (response.status === 401) throw new TokenRejectedError(message)
      throw new Error(message)
    }
    return await response.json()
  }

  // Ensures only one tab refreshes at a time, as refresh tokens can be single use
  async withRefreshLock<T>(callback: () => Promise<T>): Promise<T> {
    // Web Locks API is not available in insecure contexts
    if (!navigator.locks) return callback()
    return navigator.locks.request(`${this.storageKey}-refresh`, callback)
  }

  async refreshAccessToken(oidcConfig = this.openidConfig): Promise<Tokens> {
    if (!oidcConfig) throw new Error("OpenID config not available")

    const accessTokenBeforeLock = this.getTokens()?.access_token

    return this.withRefreshLock(async () => {
      const tokens = this.getTokens()
      if (!tokens) throw new TokenRejectedError("No tokens")

      // Another tab might have refreshed the tokens while this one was waiting for the lock
      if (
        tokens.access_token !== accessTokenBeforeLock &&
        !this.isExpired(tokens.expires_at)
      )
        return tokens

      const { refresh_token } = tokens
      if (!refresh_token) throw new TokenRejectedError("No refresh token")

      const { token_endpoint } = oidcConfig
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
      if (!response.ok) {
        const message = `Error refreshing token: ${await response.text()}`
        // 400 (e.g. invalid_grant) and 401 (invalid_client) per RFC 6749 section 5.2
        if (response.status === 400 || response.status === 401)
          throw new TokenRejectedError(message)
        throw new Error(message)
      }

      const data = await response.json()

      const newTokens = this.saveTokens(data, tokens)
      this.scheduleRefresh()
      this.runRefreshEventHandlers()

      return newTokens
    })
  }

  onTokenRefreshed(handler: RefreshHandler) {
    this.refreshEventHandlers.push(handler)
  }

  // Called when tokens could not be refreshed before the access token expired, or were rejected
  onRefreshError(handler: RefreshErrorHandler) {
    this.refreshErrorHandlers.push(handler)
  }

  // Called when the session ends without logout() being called in this tab:
  // logout in another tab, or tokens rejected by the provider
  onLogout(handler: LogoutHandler) {
    this.logoutHandlers.push(handler)
  }

  runRefreshEventHandlers() {
    const tokens = this.getTokens()
    if (!tokens) throw new Error("No tokens")

    // NOTE: does not contain user
    this.refreshEventHandlers.forEach((handler) => handler(tokens))
  }

  login() {
    // TODO: Allow setting target URL for after login
    this.sendUserToAuthUrl(true)
  }

  // Also works when already logged out locally (e.g. from another tab) to end the session at the provider
  logout() {
    if (!this.openidConfig) throw new Error("OpenID config not available")
    const { end_session_endpoint } = this.openidConfig
    const tokens = this.getTokens()

    const logoutUrl = new URL(end_session_endpoint)

    if (tokens?.id_token)
      logoutUrl.searchParams.append("id_token_hint", tokens.id_token)

    this.removeTokens()

    this.redirect(logoutUrl.toString())
  }
}
