# OIDC Auth

A simple class that enforces authentication using OpenID Connect / Oauth2.0

## Usage

### With Vue.js

```ts
import OidcAuth from "@moreillon/oidc-auth"

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
  const { user } = result

  oidcClient.onTokenRefreshed((oidcData) => {
    console.log("Token refreshed")
    console.log(oidcData)
  })
}

main()
```
