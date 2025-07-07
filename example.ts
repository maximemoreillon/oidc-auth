import OidcClient from "./index"

const { VITE_OIDC_AUTHORITY, VITE_OIDC_CLIENT_ID, VITE_OIDC_AUDIENCE } =
  // @ts-ignore
  import.meta.env

const oidcClient = new OidcClient({
  // redirect_uri: `${window.location.origin}/callback`,
  authority: VITE_OIDC_AUTHORITY,
  client_id: VITE_OIDC_CLIENT_ID,
  extraQueryParams: {
    audience: VITE_OIDC_AUDIENCE,
  },
})

async function main() {
  const result = await oidcClient.init(false)
  if (!result) return
  const { user, tokens } = result
  //  await oidcClient.getUser()

  const userEl = document.getElementById("user")
  if (userEl) userEl.innerText = JSON.stringify(user, null, 2)

  const tokensEl = document.getElementById("tokens")
  if (tokensEl) tokensEl.innerText = JSON.stringify(tokens, null, 2)

  oidcClient.onTokenRefreshed((newTokens) => {
    console.log("Token refreshed")
    console.log({ newTokens, tokens })
    if (tokensEl) tokensEl.innerText = JSON.stringify(newTokens, null, 2)
  })
}

main()

document.getElementById("logoutButton")?.addEventListener("click", async () => {
  await oidcClient.logout()
})

document.getElementById("LoginButton")?.addEventListener("click", async () => {
  oidcClient.login()
})
