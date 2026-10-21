import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import OidcClient, { TokenRejectedError } from "./index.js"
import { getCookie, setCookie } from "./storage.js"

const oidcConfig = {
  authorization_endpoint: "https://idp.example.com/auth",
  token_endpoint: "https://idp.example.com/token",
  userinfo_endpoint: "https://idp.example.com/userinfo",
  end_session_endpoint: "https://idp.example.com/logout",
}

const user = { name: "Jane", email: "jane@example.com" }

let tokenResponses: any[]
let fetchMock: ReturnType<typeof vi.fn>
let redirectMock: ReturnType<typeof vi.spyOn>

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function storeTokens(tokens: object, expiresInSeconds: number) {
  const expires_at = new Date(Date.now() + expiresInSeconds * 1000)
  localStorage.setItem(
    "oidc",
    JSON.stringify({ ...tokens, expires_at: expires_at.toUTCString() })
  )
}

const storedTokens = () => JSON.parse(localStorage.getItem("oidc")!)

const tokenRequests = () =>
  fetchMock.mock.calls.filter(([url]) => url === oidcConfig.token_endpoint)

const newClient = () =>
  new OidcClient({ authority: "https://idp.example.com", client_id: "app" })

async function createClient() {
  const client = newClient()
  client.openidConfig = oidcConfig
  return client
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  localStorage.clear()
  document.cookie = "oidc=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC;"
  tokenResponses = []
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/.well-known/openid-configuration"))
      return jsonResponse(oidcConfig)
    if (url === oidcConfig.userinfo_endpoint) return jsonResponse(user)
    if (url === oidcConfig.token_endpoint) {
      const next = tokenResponses.shift()
      if (next instanceof Error) throw next
      return next ?? { ...jsonResponse({ error: "invalid_grant" }, false), status: 400 }
    }
    throw new Error(`Unexpected fetch ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  redirectMock = vi
    .spyOn(OidcClient.prototype, "redirect")
    .mockImplementation(() => {})
  history.replaceState(null, "", "/")
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "info").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("refresh", () => {
  it("keeps refresh and ID tokens when the response omits them", async () => {
    storeTokens(
      { access_token: "a1", refresh_token: "r1", id_token: "i1" },
      300
    )
    tokenResponses.push(jsonResponse({ access_token: "a2", expires_in: 300 }))

    const client = await createClient()
    const tokens = await client.refreshAccessToken()

    expect(tokens).toMatchObject({
      access_token: "a2",
      refresh_token: "r1",
      id_token: "i1",
    })
    expect(storedTokens()).toMatchObject({ access_token: "a2", refresh_token: "r1" })
  })

  it("uses the new refresh token when the provider rotates it", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, 300)
    tokenResponses.push(
      jsonResponse({ access_token: "a2", refresh_token: "r2", expires_in: 300 })
    )

    const client = await createClient()
    await client.refreshAccessToken()

    expect(storedTokens().refresh_token).toBe("r2")
  })

  it("refreshes before the access token expires", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, 300)
    tokenResponses.push(jsonResponse({ access_token: "a2", expires_in: 300 }))

    const client = await createClient()
    const handler = vi.fn()
    client.onTokenRefreshed(handler)
    client.scheduleRefresh()

    await vi.advanceTimersByTimeAsync(239_000)
    expect(tokenRequests()).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(tokenRequests()).toHaveLength(1)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: "a2" })
    )
  })

  it("refreshes short-lived tokens halfway instead of looping", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, 30)
    tokenResponses.push(jsonResponse({ access_token: "a2", expires_in: 30 }))

    const client = await createClient()
    client.scheduleRefresh()

    await vi.advanceTimersByTimeAsync(14_000)
    expect(tokenRequests()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(tokenRequests()).toHaveLength(1)
  })

  it("retries failed refreshes, then reports the error once the token expired", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, 120)
    // Every token request fails (network error)
    fetchMock.mockImplementation(async () => {
      throw new TypeError("Failed to fetch")
    })

    const client = await createClient()
    const errorHandler = vi.fn()
    client.onRefreshError(errorHandler)
    client.scheduleRefresh()

    // First attempt 60s before expiry, then every 10s
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errorHandler).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(70_000)
    expect(errorHandler).toHaveBeenCalledOnce()
    expect(errorHandler.mock.calls[0][0]).toBeInstanceOf(TypeError)

    // No more attempts after giving up
    const attempts = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fetchMock).toHaveBeenCalledTimes(attempts)
  })

  it("recovers when a retry succeeds", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, 120)
    tokenResponses.push(new TypeError("Failed to fetch"))
    tokenResponses.push(jsonResponse({ access_token: "a2", expires_in: 300 }))

    const client = await createClient()
    const errorHandler = vi.fn()
    client.onRefreshError(errorHandler)
    client.scheduleRefresh()

    await vi.advanceTimersByTimeAsync(70_000)
    expect(storedTokens().access_token).toBe("a2")
    expect(errorHandler).not.toHaveBeenCalled()
  })

  it("skips the request when another tab refreshed while waiting for the lock", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, 300)

    // Simulates another tab holding the lock and refreshing in the meantime
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, callback: () => Promise<unknown>) => {
          storeTokens({ access_token: "a2", refresh_token: "r2" }, 300)
          return callback()
        },
      },
    })

    try {
      const client = await createClient()
      const tokens = await client.refreshAccessToken()

      expect(tokens.access_token).toBe("a2")
      expect(tokenRequests()).toHaveLength(0)
    } finally {
      delete (navigator as any).locks
    }
  })
})

describe("cross-tab sync", () => {
  it("notifies and reschedules when another tab refreshed the tokens", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, 300)
    const client = await createClient()
    const handler = vi.fn()
    client.onTokenRefreshed(handler)
    client.scheduleRefresh()

    // Another tab refreshes 200s later
    await vi.advanceTimersByTimeAsync(200_000)
    storeTokens({ access_token: "a2", refresh_token: "r2" }, 300)
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "oidc",
        newValue: localStorage.getItem("oidc"),
      })
    )

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: "a2" })
    )

    // Original timer (at 240s) was replaced by one for the new expiry
    await vi.advanceTimersByTimeAsync(100_000)
    expect(tokenRequests()).toHaveLength(0)
  })

  it("stops refreshing when another tab logged out", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, 300)
    const client = await createClient()
    client.scheduleRefresh()

    localStorage.removeItem("oidc")
    window.dispatchEvent(
      new StorageEvent("storage", { key: "oidc", newValue: null })
    )

    await vi.advanceTimersByTimeAsync(600_000)
    expect(tokenRequests()).toHaveLength(0)
  })
})

describe("init", () => {
  it("refreshes initially expired tokens before fetching the user", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, -10)
    tokenResponses.push(jsonResponse({ access_token: "a2", expires_in: 300 }))

    const client = new OidcClient({
      authority: "https://idp.example.com",
      client_id: "app",
    })
    const result = await client.init(false)

    expect(result?.tokens.access_token).toBe("a2")
    expect(result?.user).toEqual(user)
    const userinfoCall = fetchMock.mock.calls.find(
      ([url]) => url === oidcConfig.userinfo_endpoint
    )
    expect(userinfoCall?.[1].headers.authorization).toBe("Bearer a2")
  })

  it("clears tokens when the initial refresh fails", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, -10)

    const client = new OidcClient({
      authority: "https://idp.example.com",
      client_id: "app",
    })
    expect(await client.init(false)).toBeUndefined()
    expect(localStorage.getItem("oidc")).toBeNull()
  })
})

describe("legacy cookie migration", () => {
  it("moves tokens from the v3 cookie to localStorage", async () => {
    const tokens = { access_token: "a1", refresh_token: "r1", expires_at: "x" }
    setCookie("oidc", JSON.stringify(tokens))

    const client = await createClient()

    expect(client.getTokens()).toEqual(tokens)
    expect(storedTokens()).toEqual(tokens)
    expect(getCookie("oidc")).toBeNull()
  })

  it("handles URL encoded cookies", async () => {
    const tokens = { access_token: "a1", refresh_token: "r1", expires_at: "x" }
    setCookie("oidc", encodeURIComponent(JSON.stringify(tokens)))

    const client = await createClient()

    expect(client.getTokens()).toEqual(tokens)
  })
})

describe("storage", () => {
  it("reads cookie values containing '='", () => {
    setCookie("verifier", "abc=def==")
    expect(getCookie("verifier")).toBe("abc=def==")
  })
})

describe("login", () => {
  // Starts a login from the given page and returns the state sent to the provider
  async function startLogin(client: OidcClient, from = "/page?x=1") {
    history.replaceState(null, "", from)
    await client.sendUserToAuthUrl(true)
    const authUrl = new URL(redirectMock.mock.calls.at(-1)![0] as string)
    return authUrl.searchParams.get("state")!
  }

  it("sends state and PKCE challenge to the provider", async () => {
    const client = await createClient()
    await startLogin(client)

    const authUrl = new URL(redirectMock.mock.calls[0][0] as string)
    expect(authUrl.origin + authUrl.pathname).toBe(
      oidcConfig.authorization_endpoint
    )
    expect(authUrl.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/)
    expect(authUrl.searchParams.get("code_challenge")).toBeTruthy()
  })

  it("exchanges the code and returns to the original page", async () => {
    const client = await createClient()
    const state = await startLogin(client)
    const { verifier } = client.getPendingLogins()[state]
    tokenResponses.push(
      jsonResponse({ access_token: "a1", refresh_token: "r1", expires_in: 300 })
    )

    history.replaceState(null, "", `/?code=c1&state=${state}`)
    expect(await newClient().init()).toBeUndefined()

    const [, request] = tokenRequests()[0]
    const body = new URLSearchParams(request.body)
    expect(body.get("code")).toBe("c1")
    expect(body.get("code_verifier")).toBe(verifier)
    expect(storedTokens().access_token).toBe("a1")
    expect(redirectMock).toHaveBeenLastCalledWith(
      "http://localhost:3000/page?x=1"
    )
    expect(client.getPendingLogins()).toEqual({})
  })

  it("keeps concurrent logins apart", async () => {
    const client = await createClient()
    const state1 = await startLogin(client, "/one")
    const state2 = await startLogin(client, "/two")
    tokenResponses.push(jsonResponse({ access_token: "a1", expires_in: 300 }))

    history.replaceState(null, "", `/?code=c1&state=${state1}`)
    await newClient().init()

    expect(redirectMock).toHaveBeenLastCalledWith("http://localhost:3000/one")
    expect(Object.keys(client.getPendingLogins())).toEqual([state2])
  })

  it.each([
    ["without state", "/?code=ABC123"],
    ["with an unknown state", "/?code=ABC123&state=forged"],
    ["outside of the redirect URI", "/coupons?code=ABC123&state=STATE"],
  ])("ignores a code parameter %s", async (_, url) => {
    const client = await createClient()
    const state = await startLogin(client)
    storeTokens({ access_token: "a1", refresh_token: "r1" }, 300)

    history.replaceState(null, "", url.replace("STATE", state))
    const result = await newClient().init()

    expect(tokenRequests()).toHaveLength(0)
    expect(result?.user).toEqual(user)
  })

  it("reports errors returned by the provider", async () => {
    const client = await createClient()
    const state = await startLogin(client)

    history.replaceState(
      null,
      "",
      `/?error=access_denied&error_description=User%20cancelled&state=${state}`
    )
    await expect(newClient().init()).rejects.toThrow(
      "Login failed: User cancelled"
    )
    expect(client.getPendingLogins()).toEqual({})
  })

  it("discards abandoned logins after an hour", async () => {
    const client = await createClient()
    const oldState = await startLogin(client)
    vi.advanceTimersByTime(3_601_000)
    const newState = await startLogin(client)

    expect(Object.keys(client.getPendingLogins())).toEqual([newState])
    expect(oldState).not.toBe(newState)
  })
})

describe("rejected tokens vs network errors", () => {
  it("keeps tokens and does not redirect when the initial refresh hits a network error", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, -10)
    tokenResponses.push(new TypeError("Failed to fetch"))

    await expect(newClient().init(true)).rejects.toThrow("Failed to fetch")
    expect(storedTokens().access_token).toBe("a1")
    expect(redirectMock).not.toHaveBeenCalled()
  })

  it("keeps tokens when userinfo fails with a server error", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, 300)
    fetchMock.mockImplementation(async (url: string) =>
      url === oidcConfig.userinfo_endpoint
        ? jsonResponse("Service unavailable", false)
        : jsonResponse(oidcConfig)
    )

    await expect(newClient().init(true)).rejects.toThrow("Error getting user info")
    expect(storedTokens().access_token).toBe("a1")
    expect(redirectMock).not.toHaveBeenCalled()
  })

  it("clears tokens and redirects to login when userinfo rejects the token", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, 300)
    fetchMock.mockImplementation(async (url: string) =>
      url === oidcConfig.userinfo_endpoint
        ? { ...jsonResponse("Unauthorized", false), status: 401 }
        : jsonResponse(oidcConfig)
    )

    expect(await newClient().init(true)).toBeUndefined()
    expect(localStorage.getItem("oidc")).toBeNull()
    await vi.waitFor(() => expect(redirectMock).toHaveBeenCalledOnce())
    expect(redirectMock.mock.calls[0][0]).toContain(
      oidcConfig.authorization_endpoint
    )
  })

  it("ends the session without retrying when a scheduled refresh is rejected", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, 300)
    tokenResponses.push({
      ...jsonResponse({ error: "invalid_grant" }, false),
      status: 400,
    })

    const client = await createClient()
    const errorHandler = vi.fn()
    const logoutHandler = vi.fn()
    client.onRefreshError(errorHandler)
    client.onLogout(logoutHandler)
    client.scheduleRefresh()

    await vi.advanceTimersByTimeAsync(300_000)

    expect(tokenRequests()).toHaveLength(1)
    expect(errorHandler.mock.calls[0][0]).toBeInstanceOf(TokenRejectedError)
    expect(logoutHandler).toHaveBeenCalledOnce()
    expect(localStorage.getItem("oidc")).toBeNull()
  })

  it("retries server errors during a scheduled refresh", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, 120)
    tokenResponses.push({ ...jsonResponse("Bad gateway", false), status: 502 })
    tokenResponses.push(jsonResponse({ access_token: "a2", expires_in: 300 }))

    const client = await createClient()
    client.scheduleRefresh()

    await vi.advanceTimersByTimeAsync(70_000)
    expect(storedTokens().access_token).toBe("a2")
  })

  it("throws a clear error when the OIDC config cannot be fetched", async () => {
    fetchMock.mockImplementation(async () => ({
      ...jsonResponse("Not found", false),
      status: 404,
    }))
    await expect(newClient().init()).rejects.toThrow(
      "Error fetching OIDC config"
    )
  })
})

describe("logout", () => {
  it("notifies when another tab logged out", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1" }, 300)
    const client = await createClient()
    const logoutHandler = vi.fn()
    client.onLogout(logoutHandler)

    localStorage.removeItem("oidc")
    window.dispatchEvent(
      new StorageEvent("storage", { key: "oidc", newValue: null })
    )

    expect(logoutHandler).toHaveBeenCalledOnce()
  })

  it("sends the ID token hint and clears tokens", async () => {
    storeTokens({ access_token: "a1", refresh_token: "r1", id_token: "i1" }, 300)
    const client = await createClient()
    client.logout()

    const logoutUrl = new URL(redirectMock.mock.calls[0][0] as string)
    expect(logoutUrl.searchParams.get("id_token_hint")).toBe("i1")
    expect(localStorage.getItem("oidc")).toBeNull()
  })

  it("still ends the provider session when already logged out locally", async () => {
    const client = await createClient()
    expect(() => client.logout()).not.toThrow()
    expect(redirectMock).toHaveBeenCalledWith(oidcConfig.end_session_endpoint)
  })
})
