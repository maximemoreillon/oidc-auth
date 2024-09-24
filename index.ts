import { User, UserManager, type UserManagerSettings } from "oidc-client-ts"

type Options = Omit<UserManagerSettings, "redirect_uri"> & {
  redirect_uri?: string
}

export default class {
  userManager: UserManager

  constructor(options: Options) {
    const {
      redirect_uri = `${window.location.origin}?href=${window.location.href}`,
      ...rest
    } = options

    this.userManager = new UserManager({
      redirect_uri,
      ...rest,
    })
  }

  init() {
    return new Promise<User | void | null>(async (resolve, reject) => {
      // Just proceed if user is already available
      const user = await this.userManager.getUser()
      if (user) {
        if (user.expired) return this.userManager.signinRedirect()
        return resolve(user)
      }

      try {
        const user = await this.userManager.signinCallback()
        if (!user) return reject("User is not logged in")

        // Restore original URL from href provided in redirect_uri
        // TODO: Check if this is a good approach
        const { searchParams } = new URL(window.location.href)
        const originalHref = searchParams.get("href")

        if (originalHref) window.location.href = originalHref
        else resolve(user)
      } catch (error) {
        console.warn(error)
        this.userManager.signinRedirect()
        return resolve(null)
      }
    })
  }
}
