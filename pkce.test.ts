import { describe, expect, it } from "vitest"
import { createPkcePair, generatePkceChallenge } from "./pkce.js"

describe("PKCE", () => {
  // Example from RFC 7636, appendix B
  it("computes the S256 challenge from the RFC example", () => {
    expect(
      generatePkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })

  it("generates verifiers within the RFC length and charset", () => {
    const { verifier, challenge } = createPkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
    expect(challenge).toBe(generatePkceChallenge(verifier))
  })
})
