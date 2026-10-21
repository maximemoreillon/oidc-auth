export function setCookie(
  name: string,
  value: string,
  options: string = "path=/;"
) {
  document.cookie = `${name}=${value}; ${options}`
}

export function getCookie(key: string) {
  const foundRow = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${key}=`))

  // Values can contain "=" themselves, so only strip the "key=" prefix
  if (foundRow) return foundRow.slice(key.length + 1)
  return null
}

export function removeCookie(key: string) {
  // Path must match the one used when setting the cookie
  document.cookie = `${key}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC;`
}
