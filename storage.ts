// TODO: saveCookie

export function getCookie(key: string) {
  const foundRow = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${key}=`))

  if (foundRow) return foundRow.split("=")[1]
  return null
}

export function removeCookie(key: string) {
  document.cookie = `${key}=; expires=Thu, 01 Jan 1970 00:00:00 UTC;`
}
