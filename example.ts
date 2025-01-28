import OidcClient from "./index"

const { VITE_OIDC_AUTHORITY, VITE_OIDC_CLIENT_ID, VITE_OIDC_AUDIENCE } =
  // @ts-ignore
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
  const { user } = result
  //  await oidcClient.getUser()

  const userInfoEl = document.getElementById("userInfo")
  if (userInfoEl) userInfoEl.innerText = JSON.stringify(user, null, 2)

  oidcClient.onTokenRefreshed((oidcData) => {
    console.log("Token refreshed")
    console.log(oidcData)
  })
}

main()
