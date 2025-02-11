// TODO: saveCookie

export function getCookie(key: string) {
  return document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${key}=`))
    ?.split("=")[1]
}

export function removeCookie(key: string) {
  document.cookie = `${key}=; expires=Thu, 01 Jan 1970 00:00:00 UTC;`
}
