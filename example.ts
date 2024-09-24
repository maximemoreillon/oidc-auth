import OidcClient from "./index"

// @ts-ignore
const { VITE_OIDC_AUTHORITY, VITE_OIDC_CLIENT_ID } = import.meta.env

const oidcClient = new OidcClient({
  authority: VITE_OIDC_AUTHORITY,
  client_id: VITE_OIDC_CLIENT_ID,
})

oidcClient.init().then((user) => {
  const userInfoDiv = document.getElementById("userInfo")
  if (userInfoDiv) userInfoDiv.innerHTML = JSON.stringify(user, null, 2)
})
