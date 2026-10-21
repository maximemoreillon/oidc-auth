// Crypto module not available in insecure contexts, replaced with CryptoJS
import CryptoJS from "crypto-js"

function generateCodeVerifier(length: number) {
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  return Array.from(array, (byte) => (byte % 36).toString(36)).join("")
}

function generatePkceChallenge(verifier: string) {
  const hash = CryptoJS.SHA256(verifier)
  const base64 = CryptoJS.enc.Base64.stringify(hash)
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function createPkcePair() {
  const verifier = generateCodeVerifier(128)
  const challenge = generatePkceChallenge(verifier)

  return {
    verifier,
    challenge,
  }
}

export function generateState() {
  const array = new Uint8Array(16)
  crypto.getRandomValues(array)
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("")
}
