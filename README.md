# OIDC Auth

A simple class that enforces authentication using OpenID Connect / Oauth2.0

## Usage example

```ts
import OidcClient from "@moreillon/oidc-auth"

const { VITE_APP_OIDC_AUTHORITY, VITE_APP_OIDC_CLIENT_ID } = import.meta.env

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
