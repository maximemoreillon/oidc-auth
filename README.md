# OIDC Auth

A wrapper around [oidc-client-ts](https://www.npmjs.com/package/oidc-client-ts)

NOTE: in order for this module to work in plain HTTP contexts, the `oidc-client-ts` version has been set to 2.4.0

## Usage

### With Vue.js

```ts
import { createApp } from "vue"
import { createPinia } from "pinia"
import { useAuthStore } from "./stores/auth"
import OidcAuth from "@moreillon/oidc-auth"
import App from "./App.vue"
import router from "@/router"

const pinia = createPinia()

const app = createApp(App).use(pinia).use(router)

const authStore = useAuthStore()

const { VITE_APP_OIDC_AUTHORITY, VITE_APP_OIDC_CLIENT_ID } = import.meta.env
const oidcOptions = {
  authority: VITE_APP_OIDC_AUTHORITY,
  client_id: VITE_APP_OIDC_CLIENT_ID,
}

const auth = new OidcAuth(oidcOptions)
auth.init().then((user) => {
  authStore.setUser(user)
  app.mount("#app")
})

auth.userManager.events.addUserLoaded((u) => {
  console.log("Refreshed!")
  authStore.setUser(u)
})
```

here, Pinia is used to provide user information throughout the application. The store is defined as follows:

```ts
import { User } from "oidc-client-ts"
import { defineStore } from "pinia"
import { ref } from "vue"

export const useAuthStore = defineStore("auth", () => {
  const user = ref<User | void | null>()
  const setUser = (newUser: User | void | null) => (user.value = newUser)
  return { user, setUser }
})
```
