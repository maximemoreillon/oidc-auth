import OidcClient from "./index"

const { VITE_OIDC_AUTHORITY, VITE_OIDC_CLIENT_ID, VITE_OIDC_AUDIENCE } =
  // @ts-ignore
  import.meta.env

const oidcClient = new OidcClient({
  authority: VITE_OIDC_AUTHORITY,
  client_id: VITE_OIDC_CLIENT_ID,
  extraQueryParams: {
    audience: VITE_OIDC_AUDIENCE,
  },
})

oidcClient.init().then((user) => {
  const userInfoDiv = document.getElementById("userInfo")
  if (userInfoDiv) userInfoDiv.innerHTML = JSON.stringify(user, null, 2)
})
