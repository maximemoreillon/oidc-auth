import { User, UserManager } from "oidc-client-ts"

type Options = {
  client_id: string
  authority: string
  redirect_uri?: string
}

export default class {
  userManager: UserManager

  constructor(options: Options) {
    const {
      client_id,
      authority,
      redirect_uri = `${window.location.origin}?href=${window.location.href}`,
    } = options

    this.userManager = new UserManager({
      redirect_uri,
      client_id,
      authority,
    })
  }

  init() {
    return new Promise<User | void | null>(async (resolve) => {
      // Just proceed if user is already available
      const user = await this.userManager.getUser()
      if (user) return resolve(user)

      try {
        const user = await this.userManager.signinCallback()

        // Restore original URL from href provided in redirect_uri
        // TODO: Check if this is a good approach
        // PROBLEM: Vue router messes this up
        const { searchParams } = new URL(window.location.href)
        const originalHref = searchParams.get("href")
        // history.replaceState({}, "", originalHref)
        history.pushState({}, "", originalHref)

        return resolve(user)
      } catch (error) {
        console.warn(error)
        this.userManager.signinRedirect()
        return resolve(null)
      }
    })
  }
}
