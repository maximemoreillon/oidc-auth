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
}

/* 
This is a class because
- It allows to get user info
- It will provide event listeners in the future

*/

export default class {
  options: Options
  openidConfig?: OidcConfig

  constructor(options: UserOptions) {
    const {
      redirect_uri = `${window.location.origin}?href=${window.location.href}`,
      ...rest
    } = options

    this.options = { redirect_uri, ...rest }
  }

  async init() {
    this.openidConfig = await this.getOidcConfig()

    const user = await this.getUser()
    if (user) return user

    const currentUrl = new URL(window.location.href)
    const code = currentUrl.searchParams.get("code")
    const href = currentUrl.searchParams.get("href")

    if (code) {
      await this.getToken(code)
      if (href) window.location.href = href
    } else {
      // No access token, no code, redirect to login page
      const authUrl = await this.generateAuthUrl()
      window.location.href = authUrl
    }
  }

  async getOidcConfig() {
    const { authority } = this.options
    const openIdConfigUrl = `${authority}/.well-known/openid-configuration`
    const response = await fetch(openIdConfigUrl)
    return await response.json()
  }

  getCookie(key: string) {
    return document.cookie
      .split("; ")
      .find((row) => row.startsWith(`${key}=`))
      ?.split("=")[1]
  }

  generateRandomString(length: number) {
    // Provided by ChatGPT
    const charset =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    let randomString = ""
    const randomValues = new Uint8Array(length)
    window.crypto.getRandomValues(randomValues)
    for (let i = 0; i < randomValues.length; i++) {
      randomString += charset.charAt(randomValues[i] % charset.length)
    }
    return randomString
  }

  base64UrlEncode(arrayBuffer: ArrayBuffer) {
    return btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  }

  async generatePkceChallenge(verifier: string) {
    const encoder = new TextEncoder()
    const data = encoder.encode(verifier)
    const digest = await crypto.subtle.digest("SHA-256", data)
    return this.base64UrlEncode(digest)
  }

  async createPkcePair() {
    const verifier = this.generateRandomString(128)
    const challenge = await this.generatePkceChallenge(verifier)
    return {
      verifier,
      challenge,
    }
  }

  async generateAuthUrl() {
    if (!this.openidConfig) throw new Error("OpenID config not available")

    const { verifier, challenge } = await this.createPkcePair()
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

  async getToken(code: string) {
    if (!this.openidConfig) throw new Error("OpenID config not available")

    const { token_endpoint } = this.openidConfig
    const { redirect_uri, client_id } = this.options

    const code_verifier = this.getCookie("verifier")
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
    // TODO: check that request was succesful

    document.cookie = `verifier=; expires=Thu, 01 Jan 1970 00:00:00 UTC;`

    const data = await response.json()
    console.log(data)
    const { access_token, refresh_token } = data

    // NOTE: Expiry is also available, but not useful here because also needed when the user is already logged in

    if (!access_token) throw new Error("No access token")

    // TODO: add expiry
    document.cookie = `access_token=${access_token}`

    // TODO: figure out how to use the refresh token
    if (refresh_token) document.cookie = `refresh_token=${refresh_token}`
  }

  async getUser() {
    // Currently returns undefined if user cannot be queried
    if (!this.openidConfig) throw new Error("OpenID config not available")
    const { userinfo_endpoint } = this.openidConfig

    const access_token = this.getCookie("access_token")
    if (!access_token) return

    const options: RequestInit = {
      headers: {
        authorization: `Bearer ${access_token}`,
      },
    }

    const response = await fetch(userinfo_endpoint, options)
    if (response.status !== 200) return

    return await response.json()
  }
}
