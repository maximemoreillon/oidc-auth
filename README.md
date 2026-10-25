# OIDC Auth

A framework-agnostic browser client for OpenID Connect / OAuth 2.0 authentication (authorization code flow with PKCE).

## Why this package exists

This package exists to cover apps **served over plain HTTP**, for example on a local network or behind a reverse proxy that doesn't terminate TLS. Browsers only expose `crypto.subtle` on HTTPS pages and `localhost`, so mainstream OIDC clients that rely on it to compute the PKCE challenge fail on such pages. This package computes it with [crypto-js](https://www.npmjs.com/package/crypto-js) instead (random values still come from `crypto.getRandomValues`, which works on plain HTTP).

If your app is served over HTTPS, a well-established client such as [oidc-client-ts](https://github.com/authts/oidc-client-ts) is a better fit.

## Related packages

| Package                                                                    | For                                     |
| -------------------------------------------------------------------------- | --------------------------------------- |
| [@moreillon/oidc-auth](https://www.npmjs.com/package/@moreillon/oidc-auth) | Any browser app (this package)          |
| [@moreillon/vue-oidc](https://www.npmjs.com/package/@moreillon/vue-oidc)   | Vue 3 single-page apps, built on this package |
| [@moreillon/nuxt-oidc](https://www.npmjs.com/package/@moreillon/nuxt-oidc) | Nuxt apps                               |

## Installation

```bash
npm install @moreillon/oidc-auth
```

## Usage example

```ts
import OidcClient from "@moreillon/oidc-auth"

const { VITE_OIDC_AUTHORITY, VITE_OIDC_CLIENT_ID, VITE_OIDC_AUDIENCE } =
  import.meta.env

const oidcClient = new OidcClient({
  redirect_uri: `${window.location.origin}/callback`,
  authority: VITE_OIDC_AUTHORITY,
  client_id: VITE_OIDC_CLIENT_ID,
  extraQueryParams: {
    audience: VITE_OIDC_AUDIENCE,
  },
})

async function main() {
  const result = await oidcClient.init()
  if (!result) return
  const { tokens, user } = result

  oidcClient.onTokenRefreshed((tokens) => {
    console.log("Token refreshed")
    console.log(tokens)
  })

  oidcClient.onRefreshError((error) => {
    console.error("Session could not be renewed", error)
  })

  // Logged out in another tab, or tokens rejected by the provider
  oidcClient.onLogout(() => {
    console.log("Session ended")
  })
}

main()
```

At the provider, register a public client (no client secret) with your `redirect_uri` as redirect URI.

## Options

| Option             | Type                     | Description                                                    |
| ------------------ | ------------------------ | -------------------------------------------------------------- |
| `authority`        | `string`                 | URL of the OIDC provider (required)                            |
| `client_id`        | `string`                 | OIDC client ID (required)                                      |
| `redirect_uri`     | `string`                 | Where the provider redirects after login. Defaults to the origin of the current page |
| `extraQueryParams` | `Record<string, string>` | Additional query parameters sent to the authorization endpoint |

## API

| Method                       | Description                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `init(enforce = true)`       | Handle the login callback or load stored tokens. Resolves with `{ tokens, user }` when logged in. When `enforce` is `true`, users who are not logged in are redirected to the provider |
| `login()`                    | Redirect to the provider's login page, then back to the current page                                                |
| `logout()`                   | Clear the tokens and log out at the provider                                                                        |
| `getUser()`                  | Fetch the user info from the provider                                                                               |
| `refreshAccessToken()`       | Refresh the tokens now                                                                                              |
| `onTokenRefreshed(handler)`  | Called with the new tokens after every refresh                                                                      |
| `onRefreshError(handler)`    | Called when the session could not be renewed before the access token expired                                        |
| `onLogout(handler)`          | Called when the user logged out in another tab, or the provider rejected the tokens                                 |

## Token refresh

Tokens are stored in `localStorage` and the access token is refreshed automatically:

- 60 seconds before it expires, or halfway through its lifetime for short-lived tokens
- Failed refreshes are retried every 10 seconds while the access token is still valid. If it expires before a refresh succeeds, `onRefreshError` handlers are called
- Failed refreshes are not retried when the provider rejects the refresh token (`TokenRejectedError`): tokens are cleared and `onLogout` handlers are called
- Refresh tokens and ID tokens omitted from a refresh response are kept from the previous response
- Across tabs, only one refresh happens at a time (using the Web Locks API, when available), and `onTokenRefreshed` handlers are called in every tab

## Errors

`init()` throws when the provider cannot be reached or returns a server error, or when the login itself failed (e.g. the user cancelled). Tokens are kept in that case, so reloading the page can recover. Only tokens rejected by the provider are cleared, after which the user is redirected to the login page if `enforce` is `true` (default).

## Login callback

The login uses PKCE and a `state` parameter. A page is only treated as the login callback when it is on the `redirect_uri` path and its `state` matches a login started by this client, so other `code` query parameters in your app are left alone.

## Upgrading from v3

Tokens stored in a cookie by v3 and earlier are moved to `localStorage` automatically, so users stay logged in after upgrading.
