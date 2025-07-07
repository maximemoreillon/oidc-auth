# OIDC Auth

A simple class that enforces authentication using OpenID Connect / Oauth2.0

## Usage

### Example with Vue.js

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
}

main()
```
